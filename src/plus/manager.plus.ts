import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppsService,
  IAppsService,
} from '@waha/apps/app_sdk/services/IAppsService';
import { EngineBootstrap } from '@waha/core/abc/EngineBootstrap';
import { populateSessionInfo, SessionManager } from '@waha/core/abc/manager.abc';
import { SessionParams, WhatsappSession } from '@waha/core/abc/session.abc';
import { GowsEngineConfigService } from '@waha/core/config/GowsEngineConfigService';
import { WPPEngineConfigService } from '@waha/core/config/WPPEngineConfigService';
import { WebJSEngineConfigService } from '@waha/core/config/WebJSEngineConfigService';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { WhatsappSessionNoWebCore } from '@waha/core/engines/noweb/session.noweb.core';
import { WhatsappSessionWPPCore } from '@waha/core/engines/wpp/session.wpp.core';
import { WhatsappSessionWebJSCore } from '@waha/core/engines/webjs/session.webjs.core';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaManager } from '@waha/core/media/MediaManager';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { EngineConfigService } from '@waha/core/config/EngineConfigService';
import { Sqlite3ApiKeyRepository } from '@waha/core/storage/sqlite3/Sqlite3ApiKeyRepository';
import { LocalSessionAuthRepository } from '@waha/core/storage/LocalSessionAuthRepository';
import { LocalSessionConfigRepository } from '@waha/core/storage/LocalSessionConfigRepository';
import { LocalStoreCore } from '@waha/core/storage/LocalStoreCore';
import { getProxyConfig } from '@waha/core/helpers.proxy';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { complete } from '@waha/utils/reactive/complete';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import { PinoLogger } from 'nestjs-pino';
import { Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';

import { getNamespace, getSessionNamespace } from '../config';
import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';

@Injectable()
export class SessionManagerPlus extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  private sessions: Map<string, WhatsappSession>;
  private sessionConfigs: Map<string, SessionConfig | undefined>;

  protected readonly EngineClass: typeof WhatsappSession;
  protected events2: DefaultMap<
    string,
    DefaultMap<WAHAEvents, SwitchObservable<any>>
  >;
  protected readonly engineBootstrap: EngineBootstrap;

  constructor(
    config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private webjsEngineConfigService: WebJSEngineConfigService,
    private wppEngineConfigService: WPPEngineConfigService,
    gowsConfigService: GowsEngineConfigService,
    log: PinoLogger,
    private mediaStorageFactory: MediaStorageFactory,
    @Inject(AppsService)
    appsService: IAppsService,
  ) {
    super(log, config, gowsConfigService, appsService);
    this.sessions = new Map();
    this.sessionConfigs = new Map();
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    this.events2 = new DefaultMap(
      (sessionName: string) =>
        new DefaultMap<WAHAEvents, SwitchObservable<any>>(
          (key: WAHAEvents) =>
            new SwitchObservable((obs$) => obs$.pipe(retry(), share())),
        ),
    );

    this.store = new LocalStoreCore(getNamespace(), getSessionNamespace());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.sessionConfigRepository = new LocalSessionConfigRepository(this.store);
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.WPP) {
      return WhatsappSessionWPPCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else if (engine === WAHAEngine.GOWS) {
      return WhatsappSessionGoWSCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  async beforeApplicationShutdown(signal?: string) {
    void signal;
    for (const name of this.sessions.keys()) {
      await this.stop(name, true);
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    this.apiKeyRepository = new Sqlite3ApiKeyRepository(this.store);
    await this.apiKeyRepository.init();
    await this.engineBootstrap.bootstrap();
    this.startPredefinedSessions();
  }

  async exists(name: string): Promise<boolean> {
    if (this.sessions.has(name)) {
      return true;
    }
    return this.sessionConfigRepository.exists(name);
  }

  isRunning(name: string): boolean {
    return this.sessions.has(name);
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    this.sessionConfigs.set(name, config);
    await this.sessionConfigRepository.saveConfig(name, config);
  }

  async start(name: string): Promise<SessionDTO> {
    if (this.sessions.has(name)) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }
    this.log.info({ session: name }, `Starting session...`);
    const sessionConfig = this.sessionConfigs.get(name);
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(sessionConfig?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.buildProxyConfig(name);
    const sessionParams: SessionParams = {
      name: name,
      mediaManager: mediaManager,
      loggerBuilder: loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: sessionConfig,
      ignore: this.ignoreChatsConfig(sessionConfig),
    };
    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionParams.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionWPPCore) {
      sessionParams.engineConfig = this.wppEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionParams.engineConfig = this.gowsConfigService.getConfig();
    }

    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionParams);
    this.sessions.set(name, session);
    this.updateSessionEvents(name, session);

    const webhooks = this.buildWebhooks(name);
    webhook.configure(session, webhooks);

    try {
      await this.appsService.beforeSessionStart(session, this.store);
    } catch (e) {
      logger.error(`Apps Error: ${e}`);
      session.status = WAHASessionStatus.FAILED;
    }

    if (session.status !== WAHASessionStatus.FAILED) {
      await session.start();
      logger.info('Session has been started.');
      await this.appsService.afterSessionStart(session, this.store);
    }

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  private updateSessionEvents(name: string, session: WhatsappSession) {
    const sessionEvents = this.events2.get(name);
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      sessionEvents.get(event).switch(stream$);
    }
  }

  getSessionEvent(session: string, event: WAHAEvents): Observable<any> {
    return this.events2.get(session).get(event);
  }

  async stop(name: string, silent: boolean): Promise<void> {
    if (!this.isRunning(name)) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    this.sessions.delete(name);
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) {
      return;
    }
    this.log.info({ session: name }, 'Unpairing the device from account...');
    await session.unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    await this.appsService.removeBySession(this, name);
    this.sessions.delete(name);
    this.sessionConfigs.delete(name);
    await this.sessionConfigRepository.deleteConfig(name);
  }

  private buildWebhooks(name: string): WebhookConfig[] {
    let webhooks: WebhookConfig[] = [];
    const sessionConfig = this.sessionConfigs.get(name);
    if (sessionConfig?.webhooks) {
      webhooks = webhooks.concat(sessionConfig.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  private buildProxyConfig(name: string): ProxyConfig | undefined {
    const sessionConfig = this.sessionConfigs.get(name);
    if (sessionConfig?.proxy) {
      return sessionConfig.proxy;
    }
    return getProxyConfig(
      this.config,
      Object.fromEntries(this.sessions),
      name,
    );
  }

  getSession(name: string): WhatsappSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    if (!all) {
      return Array.from(this.sessions.values()).map((session) => {
        const me = session.getSessionMeInfo();
        return {
          name: session.name,
          status: session.status,
          config: session.sessionConfig,
          me: me,
          presence: session.presence,
          timestamps: {
            activity: session.getLastActivityTimestamp(),
          },
        };
      });
    }

    const sessionNames = await this.sessionConfigRepository.getAllConfigs();
    return Promise.all(
      sessionNames.map(async (name) => {
        const session = this.sessions.get(name);
        if (session) {
          const me = session.getSessionMeInfo();
          return {
            name: session.name,
            status: session.status,
            config: session.sessionConfig,
            me: me,
            presence: session.presence,
            timestamps: {
              activity: session.getLastActivityTimestamp(),
            },
          };
        }
        const config = await this.sessionConfigRepository.getConfig(name);
        return {
          name: name,
          status: WAHASessionStatus.STOPPED,
          config: config,
          me: null,
          presence: null,
          timestamps: {
            activity: null,
          },
        };
      }),
    );
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const exists = await this.exists(name);
    if (!exists) {
      return null;
    }
    const sessions = await this.getSessions(true);
    const sessionInfo = sessions.find((s) => s.name === name);
    if (!sessionInfo) {
      return null;
    }
    const runningSession = this.sessions.get(name);
    let engineInfo: Record<string, any> = {};
    if (runningSession) {
      try {
        engineInfo = await promiseTimeout(1000, runningSession.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    return {
      ...sessionInfo,
      engine: {
        engine: runningSession?.engine,
        ...engineInfo,
      },
    };
  }

  protected stopEvents() {
    for (const sessionEvents of this.events2.values()) {
      complete(sessionEvents);
    }
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
    const sessionNames = await this.sessionConfigRepository.getAllConfigs();
    for (const sessionName of sessionNames) {
      const config = await this.sessionConfigRepository.getConfig(sessionName);
      this.sessionConfigs.set(sessionName, config ?? undefined);
    }
  }
}
