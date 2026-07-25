import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

interface RateLimitPolicy {
  name: string;
  method?: string;
  path: RegExp;
  limit: number;
  windowMs: number;
  dimensions: Array<'ip' | 'user' | 'module' | 'media'>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const policies: RateLimitPolicy[] = [
  { name: 'login', method: 'POST', path: /^\/auth\/wechat\/login$/, limit: 10, windowMs: 5 * 60_000, dimensions: ['ip'] },
  { name: 'public-invite', method: 'GET', path: /^\/public\/(?:invites|invite-scenes)\//, limit: 60, windowMs: 60_000, dimensions: ['ip'] },
  { name: 'invite-create', method: 'POST', path: /^\/modules\/(\d+)\/invites$/, limit: 20, windowMs: 24 * 60 * 60_000, dimensions: ['user', 'module'] },
  { name: 'media-create', method: 'POST', path: /^\/media(?:\/reservations)?$/, limit: 30, windowMs: 60 * 60_000, dimensions: ['user', 'ip'] },
  { name: 'media-complete', method: 'POST', path: /^\/media\/(\d+)\/upload-complete$/, limit: 20, windowMs: 10 * 60_000, dimensions: ['user', 'media'] },
  { name: 'media-retry', method: 'POST', path: /^\/media\/(\d+)\/retry$/, limit: 10, windowMs: 60 * 60_000, dimensions: ['user', 'media'] },
  { name: 'memory-export', method: 'POST', path: /^\/memories\/monthly-card\/export$/, limit: 10, windowMs: 24 * 60 * 60_000, dimensions: ['user'] },
  { name: 'write-default', path: /^\//, limit: 120, windowMs: 60_000, dimensions: ['user', 'ip'] },
];

export function createRateLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  let operations = 0;
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      const readPolicy = matchPolicy(request);
      if (!readPolicy || readPolicy.name === 'write-default') return next();
    }
    const policy = matchPolicy(request);
    if (!policy) return next();
    const timestamp = now();
    const key = policyKey(policy, request);
    const existing = buckets.get(key);
    const bucket = !existing || existing.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + policy.windowMs }
      : existing;
    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, policy.limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
    response.setHeader('x-ratelimit-limit', String(policy.limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > policy.limit) {
      response.setHeader('retry-after', String(retryAfterSeconds));
      return next(new AppError('RATE_LIMITED', '请求过于频繁，请稍后重试', 429, { retryAfterSeconds }));
    }
    operations += 1;
    if (operations % 1000 === 0) cleanup(buckets, timestamp);
    next();
  };
}

function matchPolicy(request: Request): RateLimitPolicy | undefined {
  const path = request.path;
  return policies.find((policy) => (!policy.method || policy.method === request.method) && policy.path.test(path));
}

function policyKey(policy: RateLimitPolicy, request: Request): string {
  const identifiers = policy.dimensions.map((dimension) => {
    if (dimension === 'user') return request.auth?.userId ? `user:${request.auth.userId}` : `anonymous:${ipHash(request)}`;
    if (dimension === 'ip') return `ip:${ipHash(request)}`;
    const match = policy.path.exec(request.path);
    return `${dimension}:${match?.[1] ?? 'unknown'}`;
  });
  return `${policy.name}|${identifiers.join('|')}`;
}

function ipHash(request: Request): string {
  return createHash('sha256').update(request.ip || request.socket.remoteAddress || 'unknown').digest('hex').slice(0, 24);
}

function cleanup(buckets: Map<string, Bucket>, timestamp: number): void {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= timestamp) buckets.delete(key);
}
