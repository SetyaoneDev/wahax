import { ApiKey, IApiKeyRepository } from '@waha/core/storage/IApiKeyRepository';
import { LocalStore } from '@waha/core/storage/LocalStore';
import {
  SQLApiKeyMigrations,
  SQLApiKeySchema,
} from '@waha/core/storage/sql/schemas';
import { Sqlite3KVRepository } from '@waha/core/storage/sqlite3/Sqlite3KVRepository';

export class Sqlite3ApiKeyRepository
  extends Sqlite3KVRepository<ApiKey>
  implements IApiKeyRepository
{
  get schema() {
    return SQLApiKeySchema;
  }

  get migrations() {
    return SQLApiKeyMigrations;
  }

  get metadata() {
    return new Map<string, (entity: ApiKey) => any>([
      ['isActive', (entity: ApiKey) => (entity.isActive ? 1 : 0)],
    ]);
  }

  constructor(store: LocalStore) {
    super(store.getWAHADatabase());
  }

  async list(): Promise<ApiKey[]> {
    return this.getAll();
  }

  async upsert(key: ApiKey): Promise<ApiKey> {
    await this.upsertOne(key);
    return key;
  }

  async getActiveByKey(key: string): Promise<ApiKey | null> {
    return this.getBy({ key: key, isActive: 1 });
  }

  async getById(id: string): Promise<ApiKey | null> {
    return super.getById(id);
  }

  async getByKey(key: string): Promise<ApiKey | null> {
    return this.getBy({ key: key });
  }

  async deleteById(id: string): Promise<void> {
    await super.deleteById(id);
  }

  async deleteBySession(session: string): Promise<void> {
    await this.deleteBy({ session: session });
  }
}
