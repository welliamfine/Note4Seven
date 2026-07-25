import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import pino from 'pino';
import { createApp } from './app';
import { closeServer, createSwitchableServer, listenServer, startingRequestHandler } from './bootstrap';
import { loadConfig } from './config';
import { runMigrations } from './db/migrate';
import { createDatabasePool } from './db/pool';
import { startJobRunner } from './jobs/runner';
import { LocalStorageService } from './services/local-storage';
import { StorageService } from './services/storage';
import { WechatService } from './services/wechat';
import { MetricsRegistry } from './observability/metrics';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const metrics = new MetricsRegistry({ release_id: config.releaseId, environment: config.environment });
  logger.info({
    releaseId: config.releaseId,
    environment: config.environment,
    nodeEnv: config.nodeEnv,
    cloudEnvId: config.cloudEnvId,
    cloudService: config.cloudService,
    objectBucket: config.objectBucket,
    cosRegion: config.cosRegion,
    autoMigrate: config.autoMigrate,
    capabilities: config.capabilities,
    secrets: {
      databasePassword: Boolean(config.mysql.password),
      wechatCallbackToken: Boolean(config.wechatCallbackToken),
      storageEventToken: Boolean(config.storageEventToken),
      metricsToken: Boolean(config.metricsToken),
    },
  }, 'configuration loaded');
  const { server, setHandler } = createSwitchableServer(startingRequestHandler);
  let pool: Pool | null = null;
  let stopJobs: (timeoutMs?: number) => Promise<void> = async () => {};
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => process.exit(1), 15_000);
    forceExit.unref();
    try {
      const closeHttp = closeServer(server);
      await stopJobs(10_000);
      await closeHttp;
      await pool?.end();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'graceful shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await listenServer(server, config.port, '0.0.0.0');
  logger.info({ port: config.port, env: config.nodeEnv }, 'server listening');

  try {
    if (config.autoMigrate) await runMigrations(config);

    pool = createDatabasePool(config);
    await pool.query('SELECT 1');
    const storage = config.nodeEnv === 'production'
      ? new StorageService(config)
      : new LocalStorageService(config);
    const wechat = new WechatService(config);
    const jobs = startJobRunner({ pool, storage, wechat, config, logger, metrics, instanceId: randomUUID() });
    stopJobs = jobs.stop;
    const app = createApp({ config, pool, storage, wechat, logger, metrics, onMediaQueued: jobs.wake });
    setHandler(app);
    logger.info({ port: config.port, env: config.nodeEnv }, 'server ready');
  } catch (error) {
    logger.error({ err: error }, 'server initialization failed');
    await closeServer(server);
    await pool?.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
