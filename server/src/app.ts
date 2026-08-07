import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Pool } from 'mysql2/promise';
import pino, { type Logger } from 'pino';
import pinoHttp from 'pino-http';
import type { AppConfig } from './config';
import { AppError } from './lib/errors';
import { isoWithShanghaiOffset } from './lib/time';
import { optionalAuth } from './middleware/auth';
import { requestContext } from './middleware/request-context';
import { createRateLimiter } from './middleware/rate-limit';
import { accountRoutes } from './routes/account';
import { analyticsRoutes } from './routes/analytics';
import { authRoutes } from './routes/auth';
import { collaborationRoutes } from './routes/collaboration';
import { discoveryRoutes } from './routes/discovery';
import { devStorageRoutes } from './routes/dev-storage';
import { makeupRoutes } from './routes/makeup';
import { mediaRoutes } from './routes/media';
import { moduleRoutes } from './routes/modules';
import { recordRoutes } from './routes/records';
import { storageEventRoutes } from './routes/storage-events';
import { streakRewardRoutes } from './routes/streak-rewards';
import { viewRoutes } from './routes/views';
import { wechatEventRoutes } from './routes/wechat-events';
import type { StorageService } from './services/storage';
import { LocalStorageService } from './services/local-storage';
import type { WechatService } from './services/wechat';
import { metricsEndpoint, requestMetrics, type MetricsRegistry } from './observability/metrics';

export interface ApplicationDependencies {
  config: AppConfig;
  pool: Pool;
  storage: StorageService;
  wechat: WechatService;
  logger?: Logger;
  onMediaQueued?: () => void;
  metrics?: MetricsRegistry;
}

export function createApp(dependencies: ApplicationDependencies) {
  const { config, pool, storage, wechat } = dependencies;
  const logger = dependencies.logger ?? pino({ level: config.logLevel });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  if (dependencies.metrics) app.use(requestMetrics(dependencies.metrics));
  app.use(pinoHttp({
    logger,
    customProps: (request) => ({ requestId: request.requestId }),
    serializers: {
      req(request) {
        const headers = { ...request.headers };
        for (const name of [
          'authorization',
          'cookie',
          'x-wx-openid',
          'x-wx-unionid',
          'x-dev-openid',
          'x-cloudbase-context',
          'x-cloudbase-access-token',
          'x-cloudbase-service-access-token',
        ]) {
          if (headers[name]) headers[name] = '[REDACTED]';
        }
        return { ...request, url: sanitizeRequestUrl(request.url), headers };
      },
    },
  }));
  app.use(helmet({ contentSecurityPolicy: false }));

  app.get('/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      const [wechatIntegration, storageIntegration] = await Promise.all([
        wechat.integrationReadiness(),
        storage.integrationReadiness(),
      ]);
      response.json({
        status: 'ok',
        releaseId: config.releaseId,
        environment: config.environment,
        serverTime: isoWithShanghaiOffset(new Date()),
        integrations: {
          wechat: wechatIntegration.status,
          wechatMode: wechatIntegration.mode,
          wechatTokenFile: wechatIntegration.tokenFile,
          storage: storageIntegration.status,
          storageMode: storageIntegration.mode,
        },
      });
    } catch {
      response.status(503).json({ status: 'unavailable', serverTime: isoWithShanghaiOffset(new Date()) });
    }
  });
  if (config.capabilities.metrics && dependencies.metrics) {
    app.get('/metrics', metricsEndpoint(dependencies.metrics, config.metricsToken));
  }

  app.use(express.text({ type: ['text/xml', 'application/xml'], limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  if (config.capabilities.storageEvents) {
    app.use(storageEventRoutes(pool, storage, config, dependencies.onMediaQueued));
  }
  if (config.capabilities.wechatCallback) {
    app.use(wechatEventRoutes(pool, config, dependencies.onMediaQueued));
  }

  const api = express.Router();
  api.use(optionalAuth(pool));
  api.use(createRateLimiter());
  if (config.nodeEnv !== 'production' && storage instanceof LocalStorageService) {
    api.use(devStorageRoutes(storage));
  }
  api.use(authRoutes(pool, config, storage, wechat));
  api.use(collaborationRoutes(pool, storage));
  api.use(discoveryRoutes(pool, storage, wechat));
  api.use(moduleRoutes(pool, wechat, storage));
  api.use(mediaRoutes(pool, storage, dependencies.onMediaQueued));
  api.use(recordRoutes(pool, storage, wechat, dependencies.onMediaQueued));
  api.use(streakRewardRoutes(pool, storage, wechat));
  api.use(makeupRoutes(pool, wechat));
  api.use(accountRoutes(pool, config));
  api.use(analyticsRoutes(pool, config, dependencies.metrics));
  api.use(viewRoutes(pool, storage));
  app.use('/api/v1', api);

  app.use((_request, _response, next) => next(new AppError('NOT_FOUND', '接口不存在', 404)));
  app.use(errorHandler(logger));
  return app;
}

export function sanitizeRequestUrl(url: string): string {
  return url
    .replace(/(\/invites\/)[^/?]+/g, '$1[REDACTED]')
    .replace(/(\/public\/invite-scenes\/)[^/?]+/g, '$1[REDACTED]');
}

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    const known = error instanceof AppError
      ? error
      : isBodyParseError(error)
        ? new AppError('INVALID_JSON', '请求内容格式不正确', 400)
        : new AppError('INTERNAL_ERROR', '服务暂时不可用，请稍后重试', 500);

    if (known.httpStatus >= 500) {
      logger.error({
        err: error,
        code: known.code,
        data: known.data,
        requestId: request.requestId,
      }, 'request failed');
    } else {
      logger.warn({ code: known.code, requestId: request.requestId }, 'request rejected');
    }
    response.status(known.httpStatus).json({
      code: known.code,
      message: known.message,
      data: known.data,
      requestId: request.requestId,
      serverTime: isoWithShanghaiOffset(new Date()),
    });
  };
}

function isBodyParseError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed');
}
