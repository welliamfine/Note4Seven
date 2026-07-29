import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { productionEnvironment } from './fixtures/production-config';

const base = {
  MYSQL_ADDRESS: 'db.internal:3307',
  MYSQL_USERNAME: 'app',
  MYSQL_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('parses the Cloud Hosting MySQL address', () => {
    const config = loadConfig(base);
    expect(config.mysql.host).toBe('db.internal');
    expect(config.mysql.port).toBe(3307);
    expect(config.mysql.database).toBe('record_life');
    expect(config.port).toBe(8080);
  });

  it('allows an explicit port to override the address port', () => {
    const config = loadConfig({ ...base, MYSQL_PORT: '3308' });
    expect(config.mysql.port).toBe(3308);
  });

  it('accepts the current DB_* variable names', () => {
    const config = loadConfig({
      DB_HOST: 'mysql.internal',
      DB_PORT: '3310',
      DB_USER: 'cloud-app',
      DB_PASSWORD: 'secret',
      DB_NAME: 'cloud_database',
    });
    expect(config.mysql).toMatchObject({
      host: 'mysql.internal',
      port: 3310,
      user: 'cloud-app',
      password: 'secret',
      database: 'cloud_database',
    });
  });

  it('reports missing database connection settings clearly', () => {
    expect(() => loadConfig({})).toThrow('MYSQL_ADDRESS or DB_HOST');
  });

  it('rejects development authentication in production', () => {
    expect(() => loadConfig({ ...productionEnvironment, ALLOW_DEV_AUTH: 'true' })).toThrow(
      'ALLOW_DEV_AUTH must be false in production',
    );
  });

  it('requires production resources and explicit migration control', () => {
    expect(() => loadConfig({ ...productionEnvironment, AUTO_MIGRATE: 'true' })).toThrow('AUTO_MIGRATE must be false');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTO_MIGRATE: 'false' })).toThrow('RELEASE_ID');
    expect(loadConfig(productionEnvironment).autoMigrate).toBe(false);
  });

  it('defaults invite codes to the experience version and allows a release override', () => {
    expect(loadConfig(productionEnvironment).miniProgramCodeEnvVersion).toBe('trial');
    expect(loadConfig({
      ...productionEnvironment,
      MINI_PROGRAM_CODE_ENV_VERSION: 'release',
    }).miniProgramCodeEnvVersion).toBe('release');
  });

  it('requires capability-specific production configuration', () => {
    expect(() => loadConfig({ ...productionEnvironment, ENABLE_STORAGE_EVENTS: 'true' })).toThrow('STORAGE_EVENT_TOKEN');
    expect(() => loadConfig({ ...productionEnvironment, ENABLE_SUBSCRIPTIONS: 'true' })).toThrow('SUBSCRIBE_TEMPLATE_ID');
    expect(() => loadConfig({ ...productionEnvironment, ENABLE_ANALYTICS: 'true' })).toThrow('ANALYTICS_HASH_SALT');
  });

  it('loads the optional COS event forwarding token', () => {
    expect(loadConfig({ ...base, STORAGE_EVENT_TOKEN: 'storage-event-token-at-least-24' }).storageEventToken)
      .toBe('storage-event-token-at-least-24');
  });
});
