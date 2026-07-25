import express, { type ErrorRequestHandler } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { createRateLimiter } from '../src/middleware/rate-limit';

describe('rate limiter', () => {
  it('returns a standard 429 with retry metadata after the route-specific quota', async () => {
    let now = 1_000;
    const app = express();
    app.set('trust proxy', 1);
    app.use(createRateLimiter(() => now));
    app.post('/auth/wechat/login', (_request, response) => response.json({ ok: true }));
    const errors: ErrorRequestHandler = (error, _request, response, _next) => {
      const known = error as AppError;
      response.status(known.httpStatus).json({ code: known.code, data: known.data, requestId: 'test-request' });
    };
    app.use(errors);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no port');
      const url = `http://127.0.0.1:${address.port}/auth/wechat/login`;
      for (let index = 0; index < 10; index += 1) expect((await fetch(url, { method: 'POST' })).status).toBe(200);
      const limited = await fetch(url, { method: 'POST' });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED', requestId: 'test-request' });
      now += 5 * 60_000;
      expect((await fetch(url, { method: 'POST' })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
