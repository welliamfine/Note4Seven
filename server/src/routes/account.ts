import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { addDays, isoWithShanghaiOffset } from '../lib/time';
import { authUser } from '../middleware/auth';
import { idempotent } from '../services/idempotency';

const writeBody = z.object({ clientRequestId: z.string().min(8).max(64) });
const consentBody = z.object({
  privacyVersion: z.string().min(1).max(32),
  agreed: z.boolean(),
  clientRequestId: z.string().min(8).max(64),
});

interface NotificationRow extends RowDataPacket {
  notification_id: string;
  type: string;
  title: string;
  content: string | null;
  module_id: string | null;
  target_type: string | null;
  target_id: string | null;
  record_date: Date | string | null;
  action_type: string;
  action_status: string;
  is_read: number;
  created_at: Date;
}

interface DeletionRow extends RowDataPacket {
  deletion_request_id: string;
  status: string;
  requested_at: Date;
  execute_after: Date;
  updated_at: Date;
}

export function accountRoutes(pool: Pool, config: AppConfig): Router {
  const router = Router();

  router.get('/notifications', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const unreadOnly = String(request.query.unreadOnly ?? 'false') === 'true';
    const cursor = numericCursor(request.query.cursor);
    const [rows] = await pool.execute<NotificationRow[]>(
      `SELECT * FROM notification
        WHERE user_id = ? ${unreadOnly ? "AND is_read = 0 AND action_status <> 'resolved'" : ''} ${cursor ? 'AND notification_id < ?' : ''}
        ORDER BY notification_id DESC LIMIT 21`,
      cursor ? [user.userId, cursor] : [user.userId],
    );
    const hasMore = rows.length > 20;
    const items = rows.slice(0, 20).map((row) => ({
      notificationId: publicId('n', row.notification_id),
      type: row.type,
      title: row.title,
      content: row.content ?? '',
      moduleId: row.module_id ? publicId('m', row.module_id) : null,
      relativeTimeLabel: relativeTime(row.created_at),
      isRead: Boolean(row.is_read) || row.action_status === 'resolved',
      actionType: row.action_type,
      actionStatus: row.action_status,
      target: row.target_type && row.target_id ? { type: row.target_type, id: targetPublicId(row.target_type, row.target_id) } : null,
      recordDate: row.record_date ? sqlDate(row.record_date) : null,
      createdAt: isoWithShanghaiOffset(row.created_at),
      availableActions: row.action_status === 'actionable' ? ['approve', 'reject'] : [],
    }));
    ok(response, { items, nextCursor: hasMore ? rows[19].notification_id : null, hasMore });
  }));

  router.get('/notifications/unread-count', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const [[row]] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS unread_count FROM notification
        WHERE user_id = ? AND is_read = 0 AND action_status <> 'resolved'`,
      [user.userId],
    );
    ok(response, { unreadCount: Number(row.unread_count) });
  }));

  router.post('/notifications/read-all', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'notification_read_all', body.clientRequestId, body, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE notification SET is_read = 1, read_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
          WHERE user_id = ? AND is_read = 0`,
        [user.userId],
      );
      await connection.execute(
        `UPDATE module_inbox_item i
          JOIN notification n ON n.target_id = i.target_id AND n.target_type = i.target_type
            AND (n.target_type = 'join_application'
              OR (n.type = 'member_change' AND i.type = 'member_change')
              OR (n.type = 'makeup_result' AND i.type = 'makeup_result'))
          LEFT JOIN join_application ja
            ON i.target_type = 'join_application' AND ja.application_id = i.target_id
           SET i.status = 'read', i.updated_at = UTC_TIMESTAMP(3)
         WHERE n.user_id = ? AND i.recipient_user_id = ? AND i.status = 'unread'
           AND NOT (i.target_type = 'join_application' AND COALESCE(ja.status, 'pending') = 'pending')`,
        [user.userId, user.userId],
      );
      return { updatedCount: update.affectedRows };
    });
    ok(response, result);
  }));

  router.post('/notifications/:notificationId/read', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const notificationId = dbId(request.params.notificationId, 'n');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'notification_read', body.clientRequestId, body, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE notification SET is_read = 1, read_at = COALESCE(read_at, UTC_TIMESTAMP(3)), updated_at = UTC_TIMESTAMP(3)
          WHERE notification_id = ? AND user_id = ?`,
        [notificationId, user.userId],
      );
      if (update.affectedRows !== 1) throw new AppError('NOTIFICATION_NOT_FOUND', '通知不存在', 404);
      await connection.execute(
        `UPDATE module_inbox_item i
          JOIN notification n ON n.target_id = i.target_id AND n.target_type = i.target_type
            AND (n.target_type = 'join_application'
              OR (n.type = 'member_change' AND i.type = 'member_change')
              OR (n.type = 'makeup_result' AND i.type = 'makeup_result'))
          LEFT JOIN join_application ja
            ON i.target_type = 'join_application' AND ja.application_id = i.target_id
           SET i.status = 'read', i.updated_at = UTC_TIMESTAMP(3)
         WHERE n.notification_id = ? AND n.user_id = ? AND i.recipient_user_id = ?
           AND i.status = 'unread'
           AND NOT (i.target_type = 'join_application' AND COALESCE(ja.status, 'pending') = 'pending')`,
        [notificationId, user.userId, user.userId],
      );
      return { notificationId: publicId('n', notificationId), isRead: true };
    });
    ok(response, result);
  }));

  router.get('/privacy/current', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT agreed_at, revoked_at FROM privacy_consent
        WHERE user_id = ? AND privacy_version = ? LIMIT 1`,
      [user.userId, config.privacyVersion],
    );
    const consent = rows[0];
    ok(response, {
      version: config.privacyVersion,
      agreed: Boolean(consent?.agreed_at && !consent?.revoked_at),
      agreedAt: consent?.agreed_at ? isoWithShanghaiOffset(consent.agreed_at as Date) : null,
      dataRetentionDaysAfterAccountDeletionRequest: 7,
    });
  }));

  router.post('/privacy/consents', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(consentBody, request);
    if (body.privacyVersion !== config.privacyVersion) {
      throw new AppError('PRIVACY_VERSION_OUTDATED', '隐私说明版本已更新，请重新查看', 409, { currentVersion: config.privacyVersion });
    }
    const result = await idempotent(pool, user.userId, 'privacy_consent', body.clientRequestId, body, async (connection) => {
      await connection.execute(
        `INSERT INTO privacy_consent (user_id, privacy_version, agreed_at, revoked_at)
         VALUES (?, ?, UTC_TIMESTAMP(3), ?)
         ON DUPLICATE KEY UPDATE agreed_at = UTC_TIMESTAMP(3), revoked_at = VALUES(revoked_at)`,
        [user.userId, body.privacyVersion, body.agreed ? null : new Date()],
      );
      return { privacyVersion: body.privacyVersion, agreed: body.agreed };
    });
    ok(response, result);
  }));

  router.get('/users/me/deletion-request', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const deletion = await currentDeletion(pool, user.userId);
    ok(response, deletion ? serializeDeletion(deletion) : null);
  }));

  router.post('/users/me/deletion-request', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'account_deletion_request', body.clientRequestId, body, async (connection) => {
      const [existing] = await connection.execute<DeletionRow[]>(
        `SELECT * FROM account_deletion_request
          WHERE user_id = ? AND status IN ('cooling_off', 'processing') ORDER BY deletion_request_id DESC LIMIT 1 FOR UPDATE`,
        [user.userId],
      );
      if (existing[0]) return serializeDeletion(existing[0]);
      const now = new Date();
      const executeAfter = addDays(now, 7);
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO account_deletion_request (user_id, status, requested_at, execute_after)
         VALUES (?, 'cooling_off', ?, ?)`,
        [user.userId, now, executeAfter],
      );
      await connection.execute(`UPDATE user_account SET status = 'deletion_pending', version = version + 1 WHERE user_id = ?`, [user.userId]);
      await connection.execute(
        `UPDATE auth_session SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND session_id <> ? AND revoked_at IS NULL`,
        [user.userId, user.sessionId],
      );
      return {
        requestId: publicId('adr', insert.insertId),
        status: 'cooling_off',
        requestedAt: isoWithShanghaiOffset(now),
        executeAfter: isoWithShanghaiOffset(executeAfter),
      };
    });
    ok(response, result, 201);
  }));

  router.post('/users/me/deletion-request/cancel', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'account_deletion_cancel', body.clientRequestId, body, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE account_deletion_request
            SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3)
          WHERE user_id = ? AND status = 'cooling_off' AND execute_after > UTC_TIMESTAMP(3)`,
        [user.userId],
      );
      if (update.affectedRows !== 1) throw new AppError('DELETION_CANCEL_NOT_ALLOWED', '注销申请已无法撤销', 409);
      await connection.execute(`UPDATE user_account SET status = 'active', version = version + 1 WHERE user_id = ?`, [user.userId]);
      return { status: 'cancelled' };
    });
    ok(response, result);
  }));

  return router;
}

async function currentDeletion(pool: Pool, userId: string): Promise<DeletionRow | undefined> {
  const [rows] = await pool.execute<DeletionRow[]>(
    `SELECT * FROM account_deletion_request WHERE user_id = ? ORDER BY deletion_request_id DESC LIMIT 1`,
    [userId],
  );
  return rows[0];
}

function serializeDeletion(row: DeletionRow) {
  return {
    requestId: publicId('adr', row.deletion_request_id),
    status: row.status,
    requestedAt: isoWithShanghaiOffset(row.requested_at),
    executeAfter: isoWithShanghaiOffset(row.execute_after),
    updatedAt: isoWithShanghaiOffset(row.updated_at),
  };
}

function relativeTime(value: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - value.getTime()) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function targetPublicId(type: string, id: string): string {
  const prefix: Record<string, string> = { module: 'm', join_application: 'ja', record: 'r', member: 'mi' };
  return publicId(prefix[type] ?? type, id);
}

function numericCursor(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && /^\d+$/.test(candidate) ? candidate : null;
}

function sqlDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(candidate ?? '');
  if (!match) throw new AppError('VALIDATION_ERROR', '资源 ID 不正确', 422);
  return match[1];
}
