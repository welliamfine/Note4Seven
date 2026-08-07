import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { inTransaction } from '../db/pool';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent } from '../services/idempotency';
import {
  getMemoryCollageView,
  saveMemoryCollage,
  type MemoryCollageTransform,
} from '../services/memory-collage';
import { getMemoryOverview, type MemoryReportMode } from '../services/memory-overview';
import type { StorageService } from '../services/storage';

const reminderBody = z.object({
  enabled: z.boolean(),
  reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
  subscriptionStatus: z.enum(['not_requested', 'authorized', 'denied', 'unavailable', 'exhausted']),
  clientRequestId: z.string().min(8).max(64),
});

const checkinNotificationSubscriptionBody = z.object({
  enabled: z.boolean(),
  authorizationGranted: z.boolean(),
  clientRequestId: z.string().min(8).max(64),
});

const writeBody = z.object({ clientRequestId: z.string().min(8).max(64) });
const memoryBody = z.object({
  moduleId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  clientRequestId: z.string().min(8).max(64),
});
const memoryCollageItemBody = z.object({
  assetType: z.enum(['record_sticker', 'decorative_sticker']),
  recordId: z.string().optional(),
  stickerAssetId: z.string().optional(),
  x: z.number().min(-0.2).max(1.2),
  y: z.number().min(-0.2).max(1.2),
  width: z.number().min(0.08).max(0.7),
  height: z.number().min(0.08).max(0.7),
  rotation: z.number().min(-180).max(180),
  zIndex: z.number().int().min(0).max(999),
});
const memoryCollageSaveBody = z.object({
  moduleId: z.string().nullable().optional(),
  reportMode: z.enum(['week', 'month']),
  periodKey: z.string().min(7).max(10),
  boardAssetId: z.string().nullable().optional(),
  baseVersion: z.number().int().min(0),
  force: z.boolean().optional().default(false),
  items: z.array(memoryCollageItemBody).max(40),
  clientRequestId: z.string().min(8).max(64),
});

interface ReminderRow extends RowDataPacket {
  reminder_id: string;
  module_id: string;
  member_instance_id: string;
  user_id: string;
  enabled: number;
  reminder_time: string;
  subscription_status: string;
  checkin_notify_enabled: number;
  checkin_notify_status: string;
  checkin_notify_credits: number;
  checkin_notify_last_sent_at: Date | null;
  checkin_notify_last_send_status: string | null;
  last_sent_date: Date | string | null;
  last_send_status: string | null;
  version: number;
}

interface InboxRow extends RowDataPacket {
  item_id: string;
  module_id: string;
  type: string;
  title: string;
  content: string | null;
  target_type: string;
  target_id: string;
  record_date: Date | string | null;
  status: string;
  created_at: Date;
  expire_at: Date;
}

interface GalleryRow extends RowDataPacket {
  record_id: string;
  record_date: Date | string;
  member_instance_id: string;
  display_name_snapshot: string;
  remark: string | null;
  sticker_thumbnail_file_key: string;
}

export function viewRoutes(pool: Pool, storage: StorageService): Router {
  const router = Router();

  router.get('/modules/:moduleId/reminder', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const [rows] = await pool.execute<ReminderRow[]>(
      `SELECT * FROM reminder_subscription WHERE module_id = ? AND member_instance_id = ? LIMIT 1`,
      [moduleId, access.member_instance_id],
    );
    ok(response, rows[0] ? serializeReminder(rows[0]) : {
      moduleId: publicId('m', moduleId),
      memberInstanceId: publicId('mi', access.member_instance_id),
      enabled: false,
      reminderTime: '21:00:00',
      subscriptionStatus: 'not_requested',
      checkinNotificationsEnabled: false,
      checkinNotificationStatus: 'not_requested',
      checkinNotificationCredits: 0,
      checkinNotificationLastSentAt: null,
      checkinNotificationLastSendStatus: null,
      lastSentDate: null,
      version: 0,
    });
  }));

  router.put('/modules/:moduleId/reminder', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(reminderBody, request);
    const access = await requireMember(pool, moduleId, user.userId);
    if (body.enabled && body.subscriptionStatus !== 'authorized') {
      throw new AppError('SUBSCRIPTION_NOT_AUTHORIZED', '需要先授权订阅消息', 422);
    }
    const result = await idempotent(pool, user.userId, 'reminder_update', body.clientRequestId, body, async (connection) => {
      await connection.execute(
        `INSERT INTO reminder_subscription
           (module_id, member_instance_id, user_id, enabled, reminder_time, subscription_status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), reminder_time = VALUES(reminder_time),
           subscription_status = VALUES(subscription_status), version = version + 1`,
        [moduleId, access.member_instance_id, user.userId, body.enabled, body.reminderTime, body.subscriptionStatus],
      );
      const [rows] = await connection.execute<ReminderRow[]>(
        `SELECT * FROM reminder_subscription WHERE module_id = ? AND member_instance_id = ? LIMIT 1`,
        [moduleId, access.member_instance_id],
      );
      return serializeReminder(rows[0]);
    });
    ok(response, result);
  }));

  router.put('/modules/:moduleId/checkin-notification-subscription', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(checkinNotificationSubscriptionBody, request);
    const access = await requireMember(pool, moduleId, user.userId);
    if (access.module_mode !== 'group') {
      throw new AppError('GROUP_MODULE_REQUIRED', '只有多人模块可以订阅成员打卡通知', 422);
    }
    const result = await idempotent(
      pool,
      user.userId,
      'checkin_notification_subscription_update',
      body.clientRequestId,
      body,
      async (connection) => {
        const [rows] = await connection.execute<ReminderRow[]>(
          `SELECT * FROM reminder_subscription
            WHERE module_id = ? AND member_instance_id = ? LIMIT 1 FOR UPDATE`,
          [moduleId, access.member_instance_id],
        );
        const current = rows[0];
        const currentCredits = Number(current?.checkin_notify_credits ?? 0);
        const credits = !body.enabled ? 0
          : body.authorizationGranted ? Math.min(20, currentCredits + 1) : currentCredits;
        const enabled = body.enabled && credits > 0;
        const status = body.authorizationGranted
          ? 'authorized'
          : !body.enabled ? 'disabled' : credits > 0 ? 'authorized' : 'denied';

        await connection.execute(
          `INSERT INTO reminder_subscription
             (module_id, member_instance_id, user_id, enabled, reminder_time, subscription_status,
              checkin_notify_enabled, checkin_notify_status, checkin_notify_credits)
           VALUES (?, ?, ?, 0, '21:00:00', 'not_requested', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             checkin_notify_enabled = VALUES(checkin_notify_enabled),
             checkin_notify_status = VALUES(checkin_notify_status),
             checkin_notify_credits = VALUES(checkin_notify_credits),
             version = version + 1`,
          [moduleId, access.member_instance_id, user.userId, enabled, status, credits],
        );
        const [updatedRows] = await connection.execute<ReminderRow[]>(
          `SELECT * FROM reminder_subscription
            WHERE module_id = ? AND member_instance_id = ? LIMIT 1`,
          [moduleId, access.member_instance_id],
        );
        return serializeReminder(updatedRows[0]);
      },
    );
    ok(response, result);
  }));

  router.get('/modules/:moduleId/inbox', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const cursor = numericCursor(request.query.cursor);
    const [rows] = await pool.execute<InboxRow[]>(
      `SELECT * FROM module_inbox_item
        WHERE module_id = ? AND recipient_user_id = ?
          AND status IN ('unread', 'read') AND expire_at > CURRENT_TIMESTAMP(3)
          ${cursor ? 'AND item_id < ?' : ''}
        ORDER BY item_id DESC LIMIT 21`,
      cursor ? [moduleId, user.userId, cursor] : [moduleId, user.userId],
    );
    const hasMore = rows.length > 20;
    const items = rows.slice(0, 20).map((row) => ({
      itemId: publicId('inbox', row.item_id),
      moduleId: publicId('m', row.module_id),
      type: row.type,
      title: row.title,
      content: row.content ?? '',
      targetType: row.target_type,
      targetId: targetId(row.target_type, row.target_id),
      recordDate: row.record_date ? sqlDate(row.record_date) : null,
      status: row.status,
      createdAt: isoWithShanghaiOffset(row.created_at),
      expireAt: isoWithShanghaiOffset(row.expire_at),
    }));
    ok(response, { items, nextCursor: hasMore ? rows[19].item_id : null, hasMore });
  }));

  router.post('/module-inbox-items/:itemId/read', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const itemId = dbId(request.params.itemId, 'inbox');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'inbox_read', body.clientRequestId, body, async (connection) => {
      await connection.execute<ResultSetHeader>(
        `UPDATE module_inbox_item i
          LEFT JOIN join_application ja
            ON i.target_type = 'join_application' AND ja.application_id = i.target_id
          LEFT JOIN makeup_approval ma
            ON i.target_type = 'makeup_approval' AND ma.approval_id = i.target_id
           SET i.status = 'read', i.updated_at = CURRENT_TIMESTAMP(3)
         WHERE i.item_id = ? AND i.recipient_user_id = ? AND i.status = 'unread'
           AND NOT (i.target_type = 'join_application' AND COALESCE(ja.status, 'pending') = 'pending')
           AND NOT (i.target_type = 'makeup_approval' AND COALESCE(ma.status, 'pending') = 'pending')`,
        [itemId, user.userId],
      );
      const [items] = await connection.execute<RowDataPacket[]>(
        'SELECT item_id, status FROM module_inbox_item WHERE item_id = ? AND recipient_user_id = ?',
        [itemId, user.userId],
      );
      if (!items[0]) throw new AppError('INBOX_ITEM_NOT_FOUND', '待办不存在', 404);
      const status = String(items[0].status);
      if (status === 'read') {
        await connection.execute(
          `UPDATE notification n
            JOIN module_inbox_item i ON i.target_id = n.target_id AND i.target_type = n.target_type
              AND (i.target_type = 'join_application'
                OR (i.type = 'member_change' AND n.type = 'member_change')
                OR (i.type = 'makeup_result' AND n.type = 'makeup_result'))
             SET n.is_read = 1, n.read_at = COALESCE(n.read_at, CURRENT_TIMESTAMP(3)), n.updated_at = CURRENT_TIMESTAMP(3)
           WHERE i.item_id = ? AND i.recipient_user_id = ? AND n.user_id = ?
             AND n.is_read = 0`,
          [itemId, user.userId, user.userId],
        );
      }
      return { itemId: publicId('inbox', itemId), status };
    });
    ok(response, result);
  }));

  router.get('/modules/:moduleId/gallery', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const month = queryString(request.query.month);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('VALIDATION_ERROR', '月份格式不正确', 422);
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const cursor = numericCursor(request.query.cursor);
    const [rows] = await pool.execute<GalleryRow[]>(
      `SELECT r.record_id, r.record_date, r.member_instance_id, r.display_name_snapshot, r.remark,
              CASE WHEN r.media_variant = 'original'
                THEN IF(ma.thumbnail_file_key IS NULL OR ma.thumbnail_file_key = ma.sticker_thumbnail_file_key,
                  ma.original_file_key, ma.thumbnail_file_key)
                ELSE ma.sticker_thumbnail_file_key END AS sticker_thumbnail_file_key
         FROM life_record r JOIN media_asset ma ON ma.media_id = r.media_id
        WHERE r.module_id = ? AND DATE_FORMAT(r.record_date, '%Y-%m') = ?
          AND r.status IN ('active', 'locked') ${cursor ? 'AND r.record_id < ?' : ''}
        ORDER BY r.record_date DESC, r.join_sequence_snapshot ASC, r.record_id DESC LIMIT 21`,
      cursor ? [moduleId, month, cursor] : [moduleId, month],
    );
    const hasMore = rows.length > 20;
    const items = await Promise.all(rows.slice(0, 20).map(async (row) => {
      const stickerThumbnailUrl = await storage.signedUrl(row.sticker_thumbnail_file_key);
      return {
        recordId: publicId('r', row.record_id),
        recordDate: sqlDate(row.record_date),
        memberInstanceId: publicId('mi', row.member_instance_id),
        displayName: row.display_name_snapshot,
        isAnonymousExitedMember: row.display_name_snapshot === '已退出成员',
        remark: row.remark ?? '',
        stickerThumbnailUrl,
        originalThumbnailUrl: null,
      };
    }));
    ok(response, { month, items, nextCursor: hasMore ? rows[19].record_id : null, hasMore });
  }));

  router.get('/modules/:moduleId/month-summary', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const month = queryString(request.query.month);
    if (!/^(19\d{2}|20\d{2})-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError('VALIDATION_ERROR', '月份必须在 1900-01 至 2099-12 之间', 422);
    }
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const today = shanghaiDate();
    const monthStart = `${month}-01`;
    const monthEnd = nextMonthStart(month);
    const [[summary]] = await pool.execute<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(DISTINCT r.record_date) FROM life_record r
           WHERE r.module_id = ? AND r.user_id = ? AND r.record_date >= ? AND r.record_date < ?
             AND r.record_date <= ? AND r.status IN ('active', 'locked')) AS current_user_recorded_days,
         (SELECT COUNT(*) FROM daily_module_snapshot s
           WHERE s.module_id = ? AND s.record_date >= ? AND s.record_date < ?
             AND s.record_date <= ? AND s.is_all_completed = 1) AS joint_completed_days,
         (SELECT COUNT(*) FROM reaction re JOIN life_record own ON own.record_id = re.record_id
           WHERE own.module_id = ? AND own.user_id = ? AND own.record_date >= ? AND own.record_date < ?
             AND own.record_date <= ? AND own.status IN ('active', 'locked') AND re.status = 'active') AS received_reaction_count`,
      [moduleId, user.userId, monthStart, monthEnd, today, moduleId, monthStart, monthEnd, today,
        moduleId, user.userId, monthStart, monthEnd, today],
    );
    ok(response, {
      moduleId: publicId('m', moduleId),
      month,
      currentUserRecordedDays: Number(summary.current_user_recorded_days ?? 0),
      jointCompletedDays: Number(summary.joint_completed_days ?? 0),
      receivedReactionCount: Number(summary.received_reaction_count ?? 0),
    });
  }));

  router.get('/memories/weekly-overview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const week = queryString(request.query.week);
    const { start } = isoWeekRange(week);
    const overview = await getMemoryOverview(pool, storage, user.userId, {
      mode: 'week',
      period: start,
      today: shanghaiDate(),
    });
    ok(response, {
      recordedDays: overview.recordedDays,
      participatedModuleCount: overview.participatedModuleCount,
      jointCompletedDays: overview.jointCompletedDays,
      currentStreakDays: overview.currentStreakDays,
      receivedReactionCount: overview.receivedReactionCount,
      weeklyRecordCount: overview.momentCount,
    });
  }));

  router.get('/memories/overview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mode = queryString(request.query.mode) as MemoryReportMode;
    if (mode !== 'week' && mode !== 'month') {
      throw new AppError('VALIDATION_ERROR', '回忆报告类型不正确', 422);
    }
    const period = queryString(request.query.period);
    const rawModuleId = queryString(request.query.moduleId);
    const rawGroupSeed = queryString(request.query.group);
    if (rawGroupSeed.length > 80) throw new AppError('VALIDATION_ERROR', '换组参数过长', 422);
    const moduleId = rawModuleId ? dbId(rawModuleId, 'm') : undefined;
    const overview = await getMemoryOverview(pool, storage, user.userId, {
      mode,
      period,
      ...(moduleId ? { moduleId } : {}),
      ...(rawGroupSeed ? { groupSeed: rawGroupSeed } : {}),
      today: shanghaiDate(),
    });
    const collageView = await getMemoryCollageView(pool, storage, user.userId, overview, moduleId);
    ok(response, { ...overview, collage: collageView.collage });
  }));

  router.get('/memories/collage', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mode = queryString(request.query.mode) as MemoryReportMode;
    if (mode !== 'week' && mode !== 'month') {
      throw new AppError('VALIDATION_ERROR', '回忆报告类型不正确', 422);
    }
    const period = queryString(request.query.period);
    const rawModuleId = queryString(request.query.moduleId);
    const moduleId = rawModuleId ? dbId(rawModuleId, 'm') : undefined;
    const overview = await getMemoryOverview(pool, storage, user.userId, {
      mode,
      period,
      ...(moduleId ? { moduleId } : {}),
      today: shanghaiDate(),
    });
    ok(response, await getMemoryCollageView(pool, storage, user.userId, overview, moduleId));
  }));

  router.put('/memories/collage', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(memoryCollageSaveBody, request);
    const moduleId = body.moduleId ? dbId(body.moduleId, 'm') : undefined;
    const boardAssetId = body.boardAssetId ? dbId(body.boardAssetId, 'cboard') : undefined;
    const items: MemoryCollageTransform[] = body.items.map((item) => ({
      assetType: item.assetType,
      ...(item.recordId ? { recordId: dbId(item.recordId, 'r') } : {}),
      ...(item.stickerAssetId ? { stickerAssetId: dbId(item.stickerAssetId, 'csticker') } : {}),
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      rotation: item.rotation,
      zIndex: item.zIndex,
    }));
    await idempotent(pool, user.userId, 'memory_collage_save', body.clientRequestId, body, async (connection) => (
      saveMemoryCollage(connection, user.userId, {
        reportMode: body.reportMode,
        periodKey: body.periodKey,
        ...(moduleId ? { moduleId } : {}),
        ...(boardAssetId ? { boardAssetId } : {}),
        baseVersion: body.baseVersion,
        force: body.force,
        items,
      })
    ));
    const overview = await getMemoryOverview(pool, storage, user.userId, {
      mode: body.reportMode,
      period: body.periodKey,
      ...(moduleId ? { moduleId } : {}),
      today: shanghaiDate(),
    });
    ok(response, await getMemoryCollageView(pool, storage, user.userId, overview, moduleId));
  }));

  router.get('/memories/monthly-card', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(queryString(request.query.moduleId), 'm');
    const month = queryString(request.query.month);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('VALIDATION_ERROR', '月份格式不正确', 422);
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    await ensureMemoryCard(pool, moduleId, user.userId, month);
    const memory = await memoryCard(pool, storage, moduleId, user.userId, month);
    ok(response, memory);
  }));

  router.post('/memories/monthly-card/change-group', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(memoryBody, request);
    const moduleId = dbId(body.moduleId, 'm');
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const result = await idempotent(pool, user.userId, 'memory_change_group', body.clientRequestId, body, async (connection) => {
      const seed = randomBytes(16).toString('hex');
      await connection.execute(
        `INSERT INTO monthly_memory_card
           (module_id, user_id, month_key, random_seed, generation_version, data_version, status)
         VALUES (?, ?, ?, ?, 1, ?, 'ready')
         ON DUPLICATE KEY UPDATE random_seed = VALUES(random_seed), generation_version = generation_version + 1,
           data_version = VALUES(data_version), status = 'ready'`,
        [moduleId, user.userId, body.month, seed, seed],
      );
      return { moduleId: publicId('m', moduleId), month: body.month, seed };
    });
    await ensureMemoryCard(pool, moduleId, user.userId, body.month, String(result.seed));
    ok(response, await memoryCard(pool, storage, moduleId, user.userId, body.month));
  }));

  router.post('/memories/monthly-card/export', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(memoryBody, request);
    const moduleId = dbId(body.moduleId, 'm');
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const result = await idempotent(pool, user.userId, 'memory_export', body.clientRequestId, body, async (connection) => {
      const [cards] = await connection.execute<RowDataPacket[]>(
        `SELECT memory_card_id FROM monthly_memory_card WHERE module_id = ? AND user_id = ? AND month_key = ? LIMIT 1`,
        [moduleId, user.userId, body.month],
      );
      if (!cards[0]) throw new AppError('MEMORY_CARD_NOT_FOUND', '请先生成月度记录卡', 404);
      const cardId = String(cards[0].memory_card_id);
      await connection.execute(
        `UPDATE monthly_memory_card SET status = 'processing', generated_image_file_key = NULL
          WHERE memory_card_id = ?`,
        [cardId],
      );
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('memory_card', ?, 'memory.export_requested', ?)`,
        [cardId, JSON.stringify({ memoryCardId: cardId, userId: user.userId })],
      );
      return { memoryCardId: publicId('mc', cardId), status: 'processing' };
    });
    ok(response, result, 202);
  }));

  return router;
}

async function ensureMemoryCard(
  pool: Pool,
  moduleId: string,
  userId: string,
  month: string,
  requestedSeed?: string,
): Promise<string> {
  return inTransaction(pool, async (connection) => {
    const [cards] = await connection.execute<RowDataPacket[]>(
      `SELECT memory_card_id, random_seed FROM monthly_memory_card
        WHERE module_id = ? AND user_id = ? AND month_key = ? FOR UPDATE`,
      [moduleId, userId, month],
    );
    let cardId: string;
    let seed: string;
    if (cards[0]) {
      cardId = String(cards[0].memory_card_id);
      seed = requestedSeed ?? String(cards[0].random_seed);
      if (requestedSeed && requestedSeed !== cards[0].random_seed) {
        await connection.execute(
          `UPDATE monthly_memory_card SET random_seed = ?, generation_version = generation_version + 1,
             data_version = ?, status = 'ready', generated_image_file_key = NULL
           WHERE memory_card_id = ?`,
          [seed, seed, cardId],
        );
      }
    } else {
      seed = requestedSeed ?? randomBytes(16).toString('hex');
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO monthly_memory_card
           (module_id, user_id, month_key, random_seed, generation_version, data_version, status)
         VALUES (?, ?, ?, ?, 1, ?, 'ready')`,
        [moduleId, userId, month, seed, seed],
      );
      cardId = String(insert.insertId);
    }

    const [records] = await connection.execute<RowDataPacket[]>(
      `SELECT r.record_id, r.member_instance_id
         FROM life_record r JOIN media_asset ma ON ma.media_id = r.media_id
        WHERE r.module_id = ? AND DATE_FORMAT(r.record_date, '%Y-%m') = ?
          AND r.record_date <= ? AND r.status IN ('active', 'locked') AND ma.status = 'ready'
        ORDER BY SHA2(CONCAT(r.record_id, ?), 256) LIMIT 8`,
      [moduleId, month, shanghaiDate(), seed],
    );
    await connection.execute('DELETE FROM monthly_memory_card_item WHERE memory_card_id = ?', [cardId]);
    if (records.length) {
      const values = records.flatMap((record, index) => [
        cardId,
        record.record_id,
        record.member_instance_id,
        index,
      ]);
      await connection.execute(
        `INSERT INTO monthly_memory_card_item
           (memory_card_id, record_id, member_instance_id, display_order, is_anonymous)
         VALUES ${records.map(() => '(?, ?, ?, ?, 0)').join(', ')}`,
        values,
      );
    }
    return cardId;
  });
}

async function memoryCard(pool: Pool, storage: StorageService, moduleId: string, userId: string, month: string) {
  const [[moduleRows], [cards]] = await Promise.all([
    pool.execute<RowDataPacket[]>('SELECT name FROM life_module WHERE module_id = ?', [moduleId]),
    pool.execute<RowDataPacket[]>(
      `SELECT memory_card_id, status, generated_image_file_key FROM monthly_memory_card
        WHERE module_id = ? AND user_id = ? AND month_key = ? LIMIT 1`,
      [moduleId, userId, month],
    ),
  ]);
  const card = cards[0];
  const [[rows], [[stats]]] = await Promise.all([
    pool.execute<RowDataPacket[]>(
      `SELECT r.record_id,
              CASE WHEN r.media_variant = 'original'
                THEN IF(ma.thumbnail_file_key IS NULL OR ma.thumbnail_file_key = ma.sticker_thumbnail_file_key,
                  ma.original_file_key, ma.thumbnail_file_key)
                ELSE ma.sticker_thumbnail_file_key END AS sticker_thumbnail_file_key
         FROM monthly_memory_card_item mci
         JOIN life_record r ON r.record_id = mci.record_id
         JOIN media_asset ma ON ma.media_id = r.media_id
        WHERE mci.memory_card_id = ? ORDER BY mci.display_order`,
      [card.memory_card_id],
    ),
    pool.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT CASE WHEN s.is_all_completed = 1 THEN s.record_date END) AS joint_days,
              (SELECT COUNT(DISTINCT own.record_date) FROM life_record own
                WHERE own.module_id = ? AND own.user_id = ? AND DATE_FORMAT(own.record_date, '%Y-%m') = ?
                  AND own.record_date <= ? AND own.status IN ('active', 'locked')) AS current_user_recorded_days,
              (SELECT COUNT(*) FROM reaction re JOIN life_record rr ON rr.record_id = re.record_id
                WHERE rr.module_id = ? AND rr.user_id = ? AND DATE_FORMAT(rr.record_date, '%Y-%m') = ?
                  AND rr.record_date <= ? AND re.status = 'active') AS reactions
         FROM daily_module_snapshot s WHERE s.module_id = ? AND DATE_FORMAT(s.record_date, '%Y-%m') = ?`,
      [moduleId, userId, month, shanghaiDate(), moduleId, userId, month, shanghaiDate(), moduleId, month],
    ),
  ]);
  const items = await Promise.all(rows.map(async (row, index) => ({
    displayOrder: index,
    recordId: publicId('r', row.record_id),
    stickerThumbnailUrl: await storage.signedUrl(String(row.sticker_thumbnail_file_key)),
  })));
  return {
    memoryCardId: publicId('mc', card.memory_card_id),
    moduleId: publicId('m', moduleId),
    moduleName: String(moduleRows[0]?.name ?? ''),
    month,
    items,
    currentUserRecordedDays: Number(stats.current_user_recorded_days ?? 0),
    jointCompletedDays: Number(stats.joint_days ?? 0),
    receivedReactionCount: Number(stats.reactions ?? 0),
    mostUsedEmojiCode: null,
    exportStatus: card.status,
    generatedImageUrl: card.generated_image_file_key
      ? await storage.signedUrl(String(card.generated_image_file_key))
      : null,
    availableActions: ['change_group', 'export_image'],
  };
}

function serializeReminder(row: ReminderRow) {
  return {
    reminderId: publicId('rem', row.reminder_id),
    moduleId: publicId('m', row.module_id),
    memberInstanceId: publicId('mi', row.member_instance_id),
    enabled: Boolean(row.enabled),
    reminderTime: row.reminder_time,
    subscriptionStatus: row.subscription_status,
    checkinNotificationsEnabled: Boolean(row.checkin_notify_enabled),
    checkinNotificationStatus: row.checkin_notify_status,
    checkinNotificationCredits: Number(row.checkin_notify_credits),
    checkinNotificationLastSentAt: row.checkin_notify_last_sent_at
      ? isoWithShanghaiOffset(row.checkin_notify_last_sent_at)
      : null,
    checkinNotificationLastSendStatus: row.checkin_notify_last_send_status,
    lastSentDate: row.last_sent_date ? sqlDate(row.last_sent_date) : null,
    lastSendStatus: row.last_send_status,
    version: row.version,
  };
}

function isoWeekRange(value: string): { start: string; end: string } {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) throw new AppError('VALIDATION_ERROR', '周格式不正确', 422);
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new AppError('VALIDATION_ERROR', '周格式不正确', 422);
  const fourth = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(fourth);
  monday.setUTCDate(fourth.getUTCDate() - ((fourth.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const end = new Date(monday);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start: monday.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function targetId(type: string, id: string): string {
  const prefixes: Record<string, string> = { join_application: 'ja', makeup_approval: 'ma', record: 'r', member: 'mi', module: 'm', reward_draw: 'rd' };
  return publicId(prefixes[type] ?? type, id);
}

function numericCursor(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && /^\d+$/.test(candidate) ? candidate : null;
}

function queryString(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return String(value ?? '');
}

function nextMonthStart(month: string): string {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  return value === 12 ? `${year + 1}-01-01` : `${year}-${String(value + 1).padStart(2, '0')}-01`;
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
