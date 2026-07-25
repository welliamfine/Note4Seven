import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { AppError } from '../src/lib/errors';
import { analyticsRoutes } from '../src/routes/analytics';

const config = loadConfig({
  MYSQL_ADDRESS: 'db.internal:3306',
  MYSQL_USERNAME: 'app',
  MYSQL_PASSWORD: 'test',
  ENABLE_ANALYTICS: 'true',
  ANALYTICS_HASH_SALT: 'test-analytics-hash-salt-at-least-32-characters',
});

describe('analytics ingestion', () => {
  it('stores only an anonymous user hash and accepts duplicates idempotently', async () => {
    const query = vi.fn(async () => [{ affectedRows: 1 }]);
    const response = await sendAnalytics(query, { result: 'success', durationMs: 120 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { acceptedCount: 1, duplicateCount: 0 } });
    const values = query.mock.calls[0][1] as unknown[];
    expect(values).not.toContain('42');
    expect(String(values[1])).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects forbidden identifiers and private text properties', async () => {
    const response = await sendAnalytics(vi.fn(), { recordId: 'rec_1', note: 'private' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

async function sendAnalytics(query: ReturnType<typeof vi.fn>, properties: Record<string, unknown>): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.requestId = 'analytics-test';
    request.auth = { userId: '42', openId: 'not-persisted', nickname: 'test', avatarFileKey: null, status: 'active', sessionId: '1' };
    next();
  });
  app.use(analyticsRoutes({ query } as unknown as Pool, config));
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const known = error as AppError;
    response.status(known.httpStatus ?? 500).json({ code: known.code ?? 'INTERNAL_ERROR' });
  };
  app.use(errors);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    return await fetch(`http://127.0.0.1:${address.port}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{
          eventId: `${Date.now()}_abcd1234`,
          eventName: 'record_submit_success',
          schemaVersion: '1.1',
          documentBaseline: 'prd_6.4',
          occurredAt: new Date().toISOString(),
          releaseId: 'test-release',
          environment: 'development',
          deviceType: 'ios',
          networkType: 'wifi',
          properties,
        }],
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
