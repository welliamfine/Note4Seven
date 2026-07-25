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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const { server, setHandler } = createSwitchableServer(startingRequestHandler);
  let pool: Pool | null = null;
  let stopJobs = () => {};
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopJobs();
    server.close(() => {
      (pool?.end() ?? Promise.resolve()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

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
    const jobs = startJobRunner({ pool, storage, wechat, config, logger, instanceId: randomUUID() });
    stopJobs = jobs.stop;
    const app = createApp({ config, pool, storage, wechat, logger, onMediaQueued: jobs.wake });
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
