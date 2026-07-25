import { Router } from 'express';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { analyticsUserHash } from '../lib/analytics';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { authUser } from '../middleware/auth';
import type { MetricsRegistry } from '../observability/metrics';

const FORBIDDEN_PROPERTY = /(openid|unionid|token|secret|password|cookie|authorization|url|uri|path|file|photo|image|avatar|nickname|name|note|content|text|location|latitude|longitude|address|(?:^|_)id$)/i;
const URL_VALUE = /(?:https?:\/\/|wxfile:\/\/|cloud:\/\/|data:image\/)/i;
const scalar = z.union([z.string().max(80), z.number().finite(), z.boolean()]);
const properties = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), scalar).superRefine((value, context) => {
  if (Object.keys(value).length > 24) context.addIssue({ code: 'custom', message: 'too many properties' });
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PROPERTY.test(key) || /Id$/.test(key) || (typeof item === 'string' && URL_VALUE.test(item))) {
      context.addIssue({ code: 'custom', path: [key], message: 'forbidden analytics property' });
    }
  }
});
const eventSchema = z.object({
  eventId: z.string().regex(/^\d{10,16}_[a-z0-9]{4,16}$/),
  eventName: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  schemaVersion: z.literal('1.1'),
  documentBaseline: z.literal('prd_6.4'),
  occurredAt: z.string().datetime({ offset: true }),
  releaseId: z.string().min(1).max(128),
  environment: z.enum(['development', 'staging', 'production']),
  deviceType: z.string().min(1).max(24),
  networkType: z.string().min(1).max(24),
  properties,
});
const eventsBody = z.object({ events: z.array(eventSchema).min(1).max(25) });

export function analyticsRoutes(pool: Pool, config: AppConfig, metrics?: MetricsRegistry): Router {
  const router = Router();

  router.post('/analytics/events', asyncRoute(async (request, response) => {
    const user = authUser(request);
    if (!config.capabilities.analytics || !config.analyticsHashSalt) {
      throw new AppError('ANALYTICS_DISABLED', '分析服务未启用', 404);
    }
    const body = parseBody(eventsBody, request);
    const now = Date.now();
    for (const event of body.events) {
      if (event.environment !== config.environment) {
        throw new AppError('INVALID_ANALYTICS_ENVIRONMENT', '分析事件环境与服务环境不一致', 422);
      }
      const occurredAt = Date.parse(event.occurredAt);
      if (occurredAt < now - 30 * 24 * 60 * 60 * 1000 || occurredAt > now + 24 * 60 * 60 * 1000) {
        throw new AppError('INVALID_ANALYTICS_TIME', '分析事件时间不在允许范围内', 422);
      }
    }

    const values: unknown[] = [];
    const placeholders = body.events.map((event) => {
      values.push(
        event.eventId,
        analyticsUserHash(user.userId, config.analyticsHashSalt!),
        event.eventName,
        new Date(event.occurredAt),
        event.releaseId,
        event.environment,
        event.deviceType,
        event.networkType,
        JSON.stringify(event.properties),
      );
      return '(?, ?, ?, ?, ?, ?, ?, ?, ?)';
    });
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO analytics_event
         (client_event_id, user_hash, event_name, occurred_at, release_id, environment,
          device_type, network_type, properties)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
    metrics?.increment('analytics_event_received_total', { result: 'accepted' }, result.affectedRows);
    metrics?.increment('analytics_event_received_total', { result: 'duplicate' }, body.events.length - result.affectedRows);
    ok(response, { acceptedCount: result.affectedRows, duplicateCount: body.events.length - result.affectedRows });
  }));

  return router;
}
