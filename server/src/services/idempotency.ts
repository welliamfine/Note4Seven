import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';
import { addDays } from '../lib/time';
import { inTransaction } from '../db/pool';

interface IdempotencyRow extends RowDataPacket {
  request_hash: string;
  status: string;
  response_snapshot: string | Record<string, unknown> | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function bodyHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function idempotent<T extends Record<string, unknown>>(
  pool: Pool,
  userId: string,
  requestType: string,
  clientRequestId: string,
  requestBody: unknown,
  operation: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(clientRequestId)) {
    throw new AppError('VALIDATION_ERROR', 'clientRequestId 格式不正确', 422);
  }
  const hash = bodyHash(requestBody);

  return inTransaction(pool, async (connection) => {
    try {
      await connection.execute(
        `INSERT INTO idempotency_request
           (user_id, client_request_id, request_type, request_hash, status, expire_at)
         VALUES (?, ?, ?, ?, 'processing', ?)`,
        [userId, clientRequestId, requestType, hash, addDays(new Date(), 7)],
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const [rows] = await connection.execute<IdempotencyRow[]>(
        `SELECT request_hash, status, response_snapshot
           FROM idempotency_request
          WHERE user_id = ? AND request_type = ? AND client_request_id = ?
          FOR UPDATE`,
        [userId, requestType, clientRequestId],
      );
      const previous = rows[0];
      if (!previous || previous.request_hash !== hash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', '重复请求的内容不一致', 409);
      }
      if (previous.status !== 'succeeded' || !previous.response_snapshot) {
        throw new AppError('REQUEST_IN_PROGRESS', '请求正在处理中，请稍后重试', 409);
      }
      return parseSnapshot<T>(previous.response_snapshot);
    }

    const result = await operation(connection);
    await connection.execute(
      `UPDATE idempotency_request
          SET status = 'succeeded', response_code = 200, response_snapshot = ?
        WHERE user_id = ? AND request_type = ? AND client_request_id = ?`,
      [JSON.stringify(result), userId, requestType, clientRequestId],
    );
    return result;
  });
}

function parseSnapshot<T>(snapshot: string | Record<string, unknown>): T {
  return (typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot) as T;
}

export function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY');
}
