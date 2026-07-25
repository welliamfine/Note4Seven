import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent, isDuplicateKey } from '../services/idempotency';
import type { StorageService } from '../services/storage';
import type { WechatService } from '../services/wechat';

const createBody = z.object({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mediaId: z.string(),
  remark: z.string().trim().max(500).default(''),
  clientRequestId: z.string().min(8).max(64),
});

const initializeCheckinBody = z.object({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  remark: z.string().trim().max(500).default(''),
  sourceType: z.enum(['camera', 'gallery']),
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png']),
  fileSize: z.number().int().positive().max(1024 * 1024),
  width: z.number().int().min(32).max(7680),
  height: z.number().int().min(32).max(4320),
  clientRequestId: z.string().min(8).max(64),
});

const updateBody = z.object({
  mediaId: z.string(),
  remark: z.string().trim().max(500).default(''),
  version: z.number().int().nonnegative(),
  clientRequestId: z.string().min(8).max(64),
});

const deleteBody = z.object({
  version: z.number().int().nonnegative(),
  clientRequestId: z.string().min(8).max(64),
});

const reactionBody = z.object({
  emojiCode: z.enum(['heart', 'like', 'laugh', 'yummy', 'hug', 'cheer']),
  clientRequestId: z.string().min(8).max(64),
});

const simpleWriteBody = z.object({ clientRequestId: z.string().min(8).max(64) });

interface MediaRow extends RowDataPacket {
  media_id: string;
  owner_user_id: string;
  module_id: string;
  member_instance_id: string;
  status: string;
  cutout_status: string;
}

interface RecordRow extends RowDataPacket {
  record_id: string;
  module_id: string;
  member_instance_id: string;
  user_id: string;
  record_date: Date | string;
  source: 'normal' | 'makeup';
  status: string;
  media_id: string;
  remark: string | null;
  display_name_snapshot: string;
  avatar_file_key_snapshot: string | null;
  join_sequence_snapshot: number;
  first_effective_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  original_file_key: string;
  thumbnail_file_key: string;
  sticker_file_key: string;
  sticker_thumbnail_file_key: string;
}

interface MemberRow extends RowDataPacket {
  member_instance_id: string;
  user_id: string;
  join_sequence: number;
  nickname_snapshot: string;
  avatar_file_key_snapshot: string | null;
}

interface ReactionRow extends RowDataPacket {
  reaction_id: string;
  module_id: string;
  record_id: string;
  reactor_user_id: string;
  reactor_member_instance_id: string;
  emoji_code: string;
  reactor_name_snapshot: string;
  reactor_avatar_file_key_snapshot: string | null;
  created_at: Date;
}

interface ProcessingRecordRow extends RowDataPacket {
  record_id: string;
  media_id: string;
  user_id: string;
  module_id: string;
  record_date: Date | string;
  record_status: string;
  media_status: string;
  cutout_status: string;
  content_check_status: string;
  sticker_file_key: string | null;
  sticker_thumbnail_file_key: string | null;
  processing_attempts: number;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
}

export function recordRoutes(
  pool: Pool,
  storage: StorageService,
  wechat: WechatService,
  onMediaQueued?: () => void,
): Router {
  const router = Router();

  router.post('/modules/:moduleId/checkins/media/init', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(initializeCheckinBody, request);
    if (body.recordDate !== shanghaiDate()) {
      throw new AppError('RECORD_DATE_NOT_ALLOWED', '只能记录今天', 422, { serverDate: shanghaiDate() });
    }
    await wechat.assertTextAllowed(user.openId, body.remark);

    let result: Record<string, unknown>;
    try {
      result = await idempotent(pool, user.userId, 'checkin_media_init', body.clientRequestId, body, async (connection) => {
        const access = await requireMember(connection, moduleId, user.userId, { lock: true });
        const [mediaInsert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO media_asset
             (owner_user_id, module_id, member_instance_id, purpose, source_type, mime_type, file_size,
              width, height, status, cutout_status, content_check_status)
           VALUES (?, ?, ?, 'record_photo', ?, ?, ?, ?, ?, 'created', 'not_started', 'not_started')`,
          [user.userId, moduleId, access.member_instance_id, body.sourceType, body.mimeType,
            body.fileSize, body.width, body.height],
        );
        const mediaId = String(mediaInsert.insertId);
        const extension = body.mimeType === 'image/png' ? 'png' : 'jpg';
        const objectKey = `media/${user.userId}/${mediaId}/original.${extension}`;
        await connection.execute('UPDATE media_asset SET original_file_key = ? WHERE media_id = ?', [objectKey, mediaId]);

        const [recordInsert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO life_record
             (module_id, member_instance_id, user_id, record_date, source, status, media_id, remark,
              display_name_snapshot, avatar_file_key_snapshot, join_sequence_snapshot, client_request_id)
           VALUES (?, ?, ?, ?, 'normal', 'pending', ?, ?, ?, ?, ?, ?)`,
          [moduleId, access.member_instance_id, user.userId, body.recordDate, mediaId, body.remark || null,
            user.nickname, user.avatarFileKey, access.join_sequence, body.clientRequestId],
        );
        const recordId = String(recordInsert.insertId);
        await connection.execute(
          `INSERT INTO record_revision
             (record_id, revision_no, media_id, remark, changed_by_user_id, change_type)
           VALUES (?, 1, ?, ?, ?, 'create')`,
          [recordId, mediaId, body.remark || null, user.userId],
        );
        return {
          recordId: publicId('r', recordId),
          mediaId: publicId('media', mediaId),
          objectKey,
          status: 'processing',
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new AppError('RECORD_ALREADY_EXISTS', '今天已经有一条记录', 409, { refreshRequired: true });
      throw error;
    }
    const upload = await storage.createUpload(String(result.objectKey));
    ok(response, {
      recordId: result.recordId,
      mediaId: result.mediaId,
      status: result.status,
      upload,
    }, 201);
  }));

  router.get('/checkins/:recordId/processing-status', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const record = await loadProcessingRecord(pool, recordId, user.userId);
    if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
    const ready = record.record_status === 'active'
      && record.media_status === 'ready'
      && record.content_check_status === 'passed'
      && record.cutout_status === 'succeeded'
      && Boolean(record.sticker_file_key);
    const rejected = record.content_check_status === 'rejected' || record.record_status === 'rejected';
    const failed = !rejected && record.media_status === 'failed';
    const reviewFailed = failed && record.failure_code === 'MEDIA_CONTENT_CHECK_FAILED';
    ok(response, {
      checkinId: publicId('r', record.record_id),
      mediaId: publicId('media', record.media_id),
      displayStatus: ready ? 'ready' : rejected ? 'rejected' : failed ? 'failed' : 'waiting',
      stage: ready ? 'completed' : rejected ? 'review_rejected' : reviewFailed
        ? 'review_failed' : failed ? 'matting_failed' : processingStage(record),
      canLeave: true,
      elapsedMs: Math.max(0, Date.now() - new Date(record.created_at).getTime()),
      stickerUrl: ready && (record.sticker_thumbnail_file_key || record.sticker_file_key)
        ? await storage.signedUrl(record.sticker_thumbnail_file_key || record.sticker_file_key!) : null,
      retryable: failed && record.processing_attempts < 3,
      message: rejected
        ? '图片未通过审核，请更换图片'
        : reviewFailed ? '图片安全检查服务暂时不可用，请重试'
          : failed ? '贴纸生成失败，请重试或更换图片' : null,
    });
  }));

  router.post('/checkins/:recordId/retry-matting', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'checkin_retry_matting', body.clientRequestId, body, async (connection) => {
      const [records] = await connection.execute<ProcessingRecordRow[]>(
        processingRecordSelect('WHERE r.record_id = ? AND r.user_id = ? FOR UPDATE'),
        [recordId, user.userId],
      );
      const record = records[0];
      if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
      if (record.content_check_status === 'rejected' || record.media_status !== 'failed' || record.processing_attempts >= 3) {
        throw new AppError('MEDIA_RETRY_NOT_ALLOWED', '该图片无法继续重试', 409);
      }
      await connection.execute(
        `UPDATE media_asset
            SET status = 'processing',
                cutout_status = IF(cutout_status = 'succeeded', 'succeeded', 'queued'),
                content_check_status = IF(content_check_status = 'passed', 'passed', 'queued'),
                failure_code = NULL, failure_message = NULL, version = version + 1
          WHERE media_id = ?`,
        [record.media_id],
      );
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'media.processing_requested', JSON_OBJECT('mediaId', ?))`,
        [record.media_id, record.media_id],
      );
      return { checkinId: publicId('r', recordId), status: 'processing' };
    });
    onMediaQueued?.();
    ok(response, result);
  }));

  router.delete('/checkins/:recordId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'checkin_cancel', body.clientRequestId, body, async (connection) => {
      const [records] = await connection.execute<ProcessingRecordRow[]>(
        processingRecordSelect('WHERE r.record_id = ? AND r.user_id = ? FOR UPDATE'),
        [recordId, user.userId],
      );
      const record = records[0];
      if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
      if (record.record_status !== 'pending') throw new AppError('RECORD_LOCKED', '该记录已经不能取消', 409);
      await connection.execute("UPDATE life_record SET status = 'cancelled', version = version + 1 WHERE record_id = ?", [recordId]);
      await connection.execute(
        `UPDATE media_asset SET status = 'abandoned', abandoned_at = UTC_TIMESTAMP(3), version = version + 1
          WHERE media_id = ? AND status NOT IN ('ready', 'abandoned')`,
        [record.media_id],
      );
      return { checkinId: publicId('r', recordId), status: 'cancelled' };
    });
    ok(response, result);
  }));

  router.post('/modules/:moduleId/records', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(createBody, request);
    if (body.recordDate !== shanghaiDate()) {
      throw new AppError('RECORD_DATE_NOT_ALLOWED', '只能记录今天', 422, { serverDate: shanghaiDate() });
    }
    await wechat.assertTextAllowed(user.openId, body.remark);
    const mediaId = dbId(body.mediaId, 'media');

    let result: Record<string, unknown>;
    try {
      result = await idempotent(pool, user.userId, 'record_create', body.clientRequestId, body, async (connection) => {
        const access = await requireMember(connection, moduleId, user.userId, { lock: true });
        await requireReadyMedia(connection, mediaId, user.userId, moduleId, String(access.member_instance_id));
        const now = new Date();
        const [insert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO life_record
             (module_id, member_instance_id, user_id, record_date, source, status, media_id, remark,
              display_name_snapshot, avatar_file_key_snapshot, join_sequence_snapshot, client_request_id,
              first_effective_at)
           VALUES (?, ?, ?, ?, 'normal', 'active', ?, ?, ?, ?, ?, ?, ?)`,
          [moduleId, access.member_instance_id, user.userId, body.recordDate, mediaId, body.remark || null,
            user.nickname, user.avatarFileKey, access.join_sequence, body.clientRequestId, now],
        );
        const recordId = String(insert.insertId);
        await connection.execute(
          `INSERT INTO record_revision
             (record_id, revision_no, media_id, remark, changed_by_user_id, change_type)
           VALUES (?, 1, ?, ?, ?, 'create')`,
          [recordId, mediaId, body.remark || null, user.userId],
        );
        await connection.execute(
          `UPDATE life_module SET last_activity_at = UTC_TIMESTAMP(3), version = version + 1 WHERE module_id = ?`,
          [moduleId],
        );
        await emit(connection, 'record', recordId, 'record.created', { recordId, moduleId });
        return {
          recordId: publicId('r', recordId),
          moduleId: publicId('m', moduleId),
          memberInstanceId: publicId('mi', access.member_instance_id),
          recordDate: body.recordDate,
          source: 'normal',
          status: 'active',
          remark: body.remark,
          firstEffectiveAt: isoWithShanghaiOffset(now),
          version: 0,
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new AppError('RECORD_ALREADY_EXISTS', '今天已经有一条记录', 409, { refreshRequired: true });
      throw error;
    }
    ok(response, result, 201);
  }));

  router.get('/records/:recordId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const record = await loadRecord(pool, recordId);
    if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
    await requireMember(pool, String(record.module_id), user.userId, { allowPendingDelete: true });
    ok(response, await serializeRecord(storage, record, user.userId));
  }));

  router.patch('/records/:recordId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(updateBody, request);
    const mediaId = dbId(body.mediaId, 'media');
    await wechat.assertTextAllowed(user.openId, body.remark);
    const result = await idempotent(pool, user.userId, 'record_update', body.clientRequestId, body, async (connection) => {
      const [records] = await connection.execute<RecordRow[]>(
        'SELECT * FROM life_record WHERE record_id = ? FOR UPDATE',
        [recordId],
      );
      const record = records[0];
      if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
      if (String(record.user_id) !== user.userId) throw new AppError('NO_MODULE_PERMISSION', '只能修改自己的记录', 403);
      if (sqlDate(record.record_date) !== shanghaiDate() || record.status !== 'active') {
        throw new AppError('RECORD_LOCKED', '该记录已经不能修改', 409);
      }
      const access = await requireMember(connection, String(record.module_id), user.userId, { lock: true });
      await requireReadyMedia(connection, mediaId, user.userId, String(record.module_id), String(access.member_instance_id));
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE life_record SET media_id = ?, remark = ?, version = version + 1
          WHERE record_id = ? AND version = ?`,
        [mediaId, body.remark || null, recordId, body.version],
      );
      if (update.affectedRows !== 1) throw new AppError('VERSION_CONFLICT', '记录已被修改，请刷新后重试', 409);
      const [[revision]] = await connection.query<RowDataPacket[]>(
        'SELECT COALESCE(MAX(revision_no), 0) + 1 AS next_revision FROM record_revision WHERE record_id = ?',
        [recordId],
      );
      await connection.execute(
        `INSERT INTO record_revision
           (record_id, revision_no, media_id, remark, changed_by_user_id, change_type)
         VALUES (?, ?, ?, ?, ?, 'edit')`,
        [recordId, revision.next_revision, mediaId, body.remark || null, user.userId],
      );
      await emit(connection, 'record', recordId, 'record.updated', { recordId, moduleId: record.module_id });
      return { recordId: publicId('r', recordId), mediaId: publicId('media', mediaId), remark: body.remark, version: body.version + 1 };
    });
    ok(response, result);
  }));

  router.delete('/records/:recordId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(deleteBody, request);
    const result = await idempotent(pool, user.userId, 'record_delete', body.clientRequestId, body, async (connection) => {
      const [records] = await connection.execute<RecordRow[]>('SELECT * FROM life_record WHERE record_id = ? FOR UPDATE', [recordId]);
      const record = records[0];
      if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
      if (String(record.user_id) !== user.userId) throw new AppError('NO_MODULE_PERMISSION', '只能删除自己的记录', 403);
      if (sqlDate(record.record_date) !== shanghaiDate() || record.status !== 'active') {
        throw new AppError('RECORD_LOCKED', '该记录已经不能删除', 409);
      }
      await requireMember(connection, String(record.module_id), user.userId, { lock: true });
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE life_record SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3), version = version + 1
          WHERE record_id = ? AND version = ?`,
        [recordId, body.version],
      );
      if (update.affectedRows !== 1) throw new AppError('VERSION_CONFLICT', '记录已被修改，请刷新后重试', 409);
      await connection.execute(
        `UPDATE reaction SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3), version = version + 1
          WHERE record_id = ? AND status = 'active'`,
        [recordId],
      );
      await connection.execute(
        `INSERT INTO record_revision
           (record_id, revision_no, media_id, remark, changed_by_user_id, change_type)
         SELECT record_id, COALESCE((SELECT MAX(rr.revision_no) FROM record_revision rr WHERE rr.record_id = ?), 0) + 1,
                media_id, remark, ?, 'delete'
           FROM life_record WHERE record_id = ?`,
        [recordId, user.userId, recordId],
      );
      await audit(connection, String(record.module_id), user.userId, 'record_delete', 'record', recordId);
      await emit(connection, 'record', recordId, 'record.deleted', { recordId, moduleId: record.module_id });
      return { recordId: publicId('r', recordId), status: 'deleted' };
    });
    ok(response, result);
  }));

  router.get('/modules/:moduleId/calendar', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const month = queryString(request.query.month);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('VALIDATION_ERROR', '月份格式不正确', 422);
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const [members, records] = await Promise.all([
      loadMembers(pool, moduleId),
      loadMonthRecords(pool, moduleId, month),
    ]);
    const slots = layoutSlots(members.length);
    const memberLayout = members.map((member, index) => ({
      memberInstanceId: publicId('mi', member.member_instance_id),
      joinSequence: member.join_sequence,
      layoutSlot: slots[index],
    }));
    const recordViews = await Promise.all(records.map(async (record) => ({
      date: sqlDate(record.record_date),
      memberInstanceId: String(record.member_instance_id),
      recordId: publicId('r', record.record_id),
      status: record.status,
      source: record.source,
      stickerThumbnailUrl: record.status === 'pending' ? null : await storage.signedUrl(record.sticker_thumbnail_file_key),
    })));
    const today = shanghaiDate();
    const dayCount = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const days = Array.from({ length: dayCount }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`).map((date) => {
      const matching = recordViews.filter((record) => record.date === date);
      return {
        date,
        dateType: date === today ? 'today' : date > today ? 'future' : 'past',
        isToday: date === today,
        isFuture: date > today,
        hasFormalRecord: matching.some((record) => ['active', 'locked'].includes(record.status)),
        showDateNumber: matching.every((record) => record.status === 'pending') || matching.length === 0,
        hasPendingMakeup: matching.some((record) => record.status === 'pending' && record.source === 'makeup'),
        showPendingClock: matching.some((record) => record.status === 'pending'),
        processingCheckinId: matching.find((record) => (
          record.memberInstanceId === String(access.member_instance_id)
          && record.status === 'pending'
          && record.source === 'normal'
        ))?.recordId ?? null,
        memberSlots: members.map((member, memberIndex) => {
          const record = matching.find((item) => item.memberInstanceId === String(member.member_instance_id));
          return {
            memberInstanceId: publicId('mi', member.member_instance_id),
            joinSequence: member.join_sequence,
            layoutSlot: slots[memberIndex],
            hasRecord: Boolean(record && ['active', 'locked'].includes(record.status)),
            recordId: record?.recordId ?? null,
            stickerThumbnailUrl: record?.stickerThumbnailUrl ?? null,
          };
        }),
      };
    });
    ok(response, { month, memberLayout, days });
  }));

  router.get('/modules/:moduleId/dates/:recordDate', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const date = queryString(request.params.recordDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', '日期格式不正确', 422);
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const [records] = await pool.execute<RecordRow[]>(recordSelect('WHERE r.module_id = ? AND r.record_date = ? AND r.status IN (\'pending\', \'active\', \'locked\')'), [moduleId, date]);
    const formalRecords = records.filter((record) => ['active', 'locked'].includes(record.status));
    const serialized = await Promise.all(formalRecords.map((record) => serializeRecord(storage, record, user.userId)));
    const today = shanghaiDate();
    const dateType = date === today ? 'today' : date > today ? 'future' : 'past';
    const current = records.find((record) => String(record.member_instance_id) === String(access.member_instance_id));
    ok(response, {
      date,
      weekdayLabel: weekdayLabel(date),
      dateType,
      title: `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日 · ${weekdayLabel(date)}`,
      summaryLabel: formalRecords.length ? `${formalRecords.length} 条记录` : '还没有记录',
      emptyMessage: formalRecords.length ? null : '这一天还静悄悄的～',
      records: serialized,
      currentUserRecord: current && ['active', 'locked'].includes(current.status)
        ? await serializeRecord(storage, current, user.userId) : null,
      pendingMakeup: current?.status === 'pending' && current.source === 'makeup'
        ? { recordId: publicId('r', current.record_id) } : null,
      processingCheckin: current?.status === 'pending' && current.source === 'normal'
        ? { recordId: publicId('r', current.record_id) } : null,
      primaryAction: dateType === 'today'
        ? current
          ? current.status === 'pending' && current.source === 'normal'
            ? { type: 'resume_processing', label: '查看生成进度', recordId: publicId('r', current.record_id) }
            : { type: 'edit_today', label: '编辑今日', recordId: publicId('r', current.record_id) }
          : { type: 'record_today', label: '记录今日' }
        : null,
      availableActions: dateType === 'future' ? [] : ['view_records'],
    });
  }));

  router.get('/records/:recordId/reactions', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const record = await loadRecord(pool, recordId);
    if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
    await requireMember(pool, String(record.module_id), user.userId, { allowPendingDelete: true });
    const [rows] = await pool.execute<ReactionRow[]>(
      `SELECT * FROM reaction WHERE record_id = ? AND status = 'active' ORDER BY created_at`,
      [recordId],
    );
    const items = await Promise.all(rows.map(async (reaction) => ({
      reactionId: publicId('re', reaction.reaction_id),
      moduleId: publicId('m', reaction.module_id),
      recordId: publicId('r', reaction.record_id),
      reactorUserId: publicId('u', reaction.reactor_user_id),
      reactorMemberInstanceId: publicId('mi', reaction.reactor_member_instance_id),
      emojiCode: reaction.emoji_code,
      reactorName: reaction.reactor_name_snapshot,
      reactorAvatarUrl: reaction.reactor_avatar_file_key_snapshot
        ? await storage.signedUrl(reaction.reactor_avatar_file_key_snapshot)
        : null,
      isMine: String(reaction.reactor_user_id) === user.userId,
      createdAt: isoWithShanghaiOffset(reaction.created_at),
    })));
    ok(response, { items });
  }));

  router.put('/records/:recordId/reaction', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(reactionBody, request);
    const record = await loadRecord(pool, recordId);
    if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
    if (String(record.user_id) === user.userId) throw new AppError('REACTION_SELF_NOT_ALLOWED', '不能回应自己的记录', 422);
    const access = await requireMember(pool, String(record.module_id), user.userId);
    const result = await idempotent(pool, user.userId, 'reaction_set', body.clientRequestId, body, async (connection) => {
      await connection.execute(
        `INSERT INTO reaction
           (module_id, record_id, reactor_user_id, reactor_member_instance_id, emoji_code, status,
            reactor_name_snapshot, reactor_avatar_file_key_snapshot)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON DUPLICATE KEY UPDATE emoji_code = VALUES(emoji_code), status = 'active', cancelled_at = NULL,
           reactor_name_snapshot = VALUES(reactor_name_snapshot),
           reactor_avatar_file_key_snapshot = VALUES(reactor_avatar_file_key_snapshot),
           version = version + 1, updated_at = UTC_TIMESTAMP(3)`,
        [record.module_id, recordId, user.userId, access.member_instance_id, body.emojiCode, user.nickname, user.avatarFileKey],
      );
      await emit(connection, 'record', recordId, 'reaction.changed', { recordId, reactorUserId: user.userId });
      return { recordId: publicId('r', recordId), emojiCode: body.emojiCode, status: 'active' };
    });
    ok(response, result);
  }));

  router.delete('/records/:recordId/reaction', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recordId = dbId(request.params.recordId, 'r');
    const body = parseBody(simpleWriteBody, request);
    const record = await loadRecord(pool, recordId);
    if (!record) throw new AppError('RECORD_NOT_FOUND', '记录不存在', 404);
    const access = await requireMember(pool, String(record.module_id), user.userId);
    const result = await idempotent(pool, user.userId, 'reaction_delete', body.clientRequestId, body, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE reaction SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3), version = version + 1
          WHERE record_id = ? AND reactor_member_instance_id = ? AND status = 'active'`,
        [recordId, access.member_instance_id],
      );
      if (update.affectedRows !== 1) throw new AppError('REACTION_NOT_FOUND', '回应不存在', 404);
      await emit(connection, 'record', recordId, 'reaction.changed', { recordId, reactorUserId: user.userId });
      return { recordId: publicId('r', recordId), status: 'cancelled' };
    });
    ok(response, result);
  }));

  return router;
}

async function loadProcessingRecord(pool: Pool, recordId: string, userId: string): Promise<ProcessingRecordRow | undefined> {
  const [rows] = await pool.execute<ProcessingRecordRow[]>(
    processingRecordSelect('WHERE r.record_id = ? AND r.user_id = ? LIMIT 1'),
    [recordId, userId],
  );
  return rows[0];
}

function processingRecordSelect(where: string): string {
  return `SELECT r.record_id, r.media_id, r.user_id, r.module_id, r.record_date,
                 r.status AS record_status, r.created_at,
                 ma.status AS media_status, ma.cutout_status, ma.content_check_status,
                 ma.sticker_file_key, ma.sticker_thumbnail_file_key,
                 ma.processing_attempts, ma.failure_code, ma.failure_message
            FROM life_record r JOIN media_asset ma ON ma.media_id = r.media_id ${where}`;
}

function processingStage(record: ProcessingRecordRow): string {
  if (['created', 'uploading', 'uploaded'].includes(record.media_status)) return 'uploading';
  if (record.cutout_status === 'succeeded' && record.content_check_status !== 'passed') return 'reviewing';
  if (record.content_check_status === 'passed' && record.cutout_status !== 'succeeded') return 'matting';
  if (record.cutout_status === 'succeeded' && record.content_check_status === 'passed') return 'finalizing';
  return 'reviewing_and_matting';
}

async function requireReadyMedia(
  connection: { execute: Pool['execute'] },
  mediaId: string,
  userId: string,
  moduleId: string,
  memberId: string,
): Promise<MediaRow> {
  const [rows] = await connection.execute<MediaRow[]>(
    `SELECT * FROM media_asset
      WHERE media_id = ? AND owner_user_id = ? AND module_id = ? AND member_instance_id = ?
      FOR UPDATE`,
    [mediaId, userId, moduleId, memberId],
  );
  const media = rows[0];
  if (!media) throw new AppError('MEDIA_NOT_FOUND', '图片不存在', 404);
  if (media.status !== 'ready' || media.cutout_status !== 'succeeded') {
    throw new AppError('MEDIA_NOT_READY', '图片或贴纸尚未处理完成', 409);
  }
  const [used] = await connection.execute<RowDataPacket[]>('SELECT record_id FROM life_record WHERE media_id = ? LIMIT 1', [mediaId]);
  if (used[0]) throw new AppError('MEDIA_ALREADY_USED', '该图片已经被使用', 409);
  return media;
}

async function loadRecord(pool: Pool, recordId: string): Promise<RecordRow | undefined> {
  const [rows] = await pool.execute<RecordRow[]>(recordSelect('WHERE r.record_id = ?'), [recordId]);
  return rows[0];
}

async function loadMembers(pool: Pool, moduleId: string): Promise<MemberRow[]> {
  const [rows] = await pool.execute<MemberRow[]>(
    `SELECT member_instance_id, user_id, join_sequence, nickname_snapshot, avatar_file_key_snapshot
       FROM module_member WHERE module_id = ? AND status = 'active' ORDER BY join_sequence`,
    [moduleId],
  );
  return rows;
}

async function loadMonthRecords(pool: Pool, moduleId: string, month: string): Promise<RecordRow[]> {
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00+08:00`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);
  const [rows] = await pool.execute<RecordRow[]>(
    recordSelect("WHERE r.module_id = ? AND r.record_date >= ? AND r.record_date < ? AND r.status IN ('pending', 'active', 'locked')"),
    [moduleId, start, end],
  );
  return rows;
}

function recordSelect(where: string): string {
  return `SELECT r.*, ma.original_file_key, ma.thumbnail_file_key, ma.sticker_file_key, ma.sticker_thumbnail_file_key
            FROM life_record r JOIN media_asset ma ON ma.media_id = r.media_id ${where}
           ORDER BY r.record_date, r.join_sequence_snapshot`;
}

async function serializeRecord(storage: StorageService, record: RecordRow, currentUserId: string) {
  const [stickerUrl, stickerThumbnailUrl] = await Promise.all([
    storage.signedUrl(record.sticker_file_key),
    storage.signedUrl(record.sticker_thumbnail_file_key),
  ]);
  return {
    recordId: publicId('r', record.record_id),
    moduleId: publicId('m', record.module_id),
    mediaId: publicId('media', record.media_id),
    memberInstanceId: publicId('mi', record.member_instance_id),
    userId: publicId('u', record.user_id),
    displayName: record.display_name_snapshot,
    avatarUrl: null,
    isAnonymousExitedMember: false,
    recordDate: sqlDate(record.record_date),
    source: record.source,
    status: record.status,
    remark: record.remark ?? '',
    originalUrl: null,
    originalThumbnailUrl: null,
    stickerUrl,
    stickerThumbnailUrl,
    firstEffectiveAt: record.first_effective_at ? isoWithShanghaiOffset(record.first_effective_at) : null,
    version: record.version,
    availableActions: String(record.user_id) === currentUserId && sqlDate(record.record_date) === shanghaiDate() && record.status === 'active'
      ? ['edit', 'delete']
      : ['react'],
  };
}

function layoutSlots(count: number): string[] {
  if (count <= 1) return ['center'];
  if (count === 2) return ['top_center', 'bottom_center'];
  if (count === 3) return ['top_left', 'top_right', 'bottom_center'];
  return ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
}

function sqlDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function weekdayLabel(date: string): string {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return labels[new Date(`${date}T12:00:00+08:00`).getUTCDay()];
}

function queryString(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return String(value ?? '');
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(candidate ?? '');
  if (!match) throw new AppError('VALIDATION_ERROR', '资源 ID 不正确', 422);
  return match[1];
}

async function emit(
  connection: { execute: Pool['execute'] },
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await connection.execute(
    `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload) VALUES (?, ?, ?, ?)`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload)],
  );
}

async function audit(
  connection: { execute: Pool['execute'] },
  moduleId: string,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await connection.execute(
    `INSERT INTO audit_log
       (module_id, operator_user_id, action_type, target_type, target_id, result)
     VALUES (?, ?, ?, ?, ?, 'success')`,
    [moduleId, userId, action, targetType, targetId],
  );
}
