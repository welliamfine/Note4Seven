import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { addHours, daysBetweenShanghai, isoWithShanghaiOffset } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent, isDuplicateKey } from '../services/idempotency';
import type { WechatService } from '../services/wechat';

const createBody = z.object({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mediaId: z.string(),
  remark: z.string().trim().max(500).default(''),
  clientRequestId: z.string().min(8).max(64),
});

const writeBody = z.object({ clientRequestId: z.string().min(8).max(64) });

interface ApprovalRow extends RowDataPacket {
  approval_id: string;
  module_id: string;
  record_id: string;
  applicant_user_id: string;
  applicant_member_instance_id: string;
  target_date: Date | string;
  attempt_number: number;
  status: string;
  expire_at: Date;
  resolved_at: Date | null;
  resolved_by_user_id: string | null;
  resolution_reason: string | null;
  version: number;
}

export function makeupRoutes(pool: Pool, wechat: WechatService): Router {
  const router = Router();

  router.post('/modules/:moduleId/makeup-applications', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(createBody, request);
    const distance = daysBetweenShanghai(body.recordDate);
    if (distance < 1 || distance > 3) throw new AppError('MAKEUP_DATE_EXPIRED', '只能补记过去三天', 422);
    await wechat.assertTextAllowed(user.openId, body.remark);
    const mediaId = dbId(body.mediaId, 'media');

    let result: Record<string, unknown>;
    try {
      result = await idempotent(pool, user.userId, 'makeup_create', body.clientRequestId, body, async (connection) => {
        const access = await requireMember(connection, moduleId, user.userId, { lock: true });
        const [media] = await connection.execute<RowDataPacket[]>(
          `SELECT media_id FROM media_asset
            WHERE media_id = ? AND owner_user_id = ? AND module_id = ? AND member_instance_id = ?
              AND status = 'ready' AND cutout_status = 'succeeded'
            FOR UPDATE`,
          [mediaId, user.userId, moduleId, access.member_instance_id],
        );
        if (!media[0]) throw new AppError('MEDIA_NOT_READY', '图片或贴纸尚未处理完成', 409);
        const isSolo = access.module_mode === 'solo';
        const now = new Date();
        const recordStatus = isSolo ? 'locked' : 'pending';
        const [recordInsert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO life_record
             (module_id, member_instance_id, user_id, record_date, source, status, media_id, remark,
              display_name_snapshot, avatar_file_key_snapshot, join_sequence_snapshot, client_request_id,
              first_effective_at, approved_at, locked_at)
           VALUES (?, ?, ?, ?, 'makeup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [moduleId, access.member_instance_id, user.userId, body.recordDate, recordStatus, mediaId, body.remark || null,
            user.nickname, user.avatarFileKey, access.join_sequence, body.clientRequestId,
            isSolo ? now : null, isSolo ? now : null, isSolo ? now : null],
        );
        const recordId = String(recordInsert.insertId);
        await connection.execute(
          `INSERT INTO record_revision
             (record_id, revision_no, media_id, remark, changed_by_user_id, change_type)
           VALUES (?, 1, ?, ?, ?, 'create')`,
          [recordId, mediaId, body.remark || null, user.userId],
        );

        if (isSolo) {
          await emit(connection, recordId, 'makeup.approved', { recordId, moduleId, targetDate: body.recordDate });
          return {
            record: { recordId: publicId('r', recordId), status: 'locked', recordDate: body.recordDate },
            approval: null,
          };
        }

        const [[attempt]] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) + 1 AS attempt_number FROM makeup_approval
            WHERE module_id = ? AND applicant_member_instance_id = ? AND target_date = ?`,
          [moduleId, access.member_instance_id, body.recordDate],
        );
        const expireAt = addHours(now, 24);
        const [approvalInsert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO makeup_approval
             (module_id, record_id, applicant_user_id, applicant_member_instance_id, target_date,
              attempt_number, status, expire_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [moduleId, recordId, user.userId, access.member_instance_id, body.recordDate, attempt.attempt_number, expireAt],
        );
        const approvalId = String(approvalInsert.insertId);
        const [recipients] = await connection.execute<RowDataPacket[]>(
          `SELECT user_id FROM module_member
            WHERE module_id = ? AND status = 'active' AND user_id <> ?`,
          [moduleId, user.userId],
        );
        for (const recipient of recipients) {
          await connection.execute(
            `INSERT INTO module_inbox_item
               (module_id, recipient_user_id, type, title, content, target_type, target_id, record_date,
                status, dedupe_key, expire_at)
             VALUES (?, ?, 'makeup_approval', '新的补卡申请', ?, 'makeup_approval', ?, ?,
                     'unread', ?, ?)`,
            [moduleId, recipient.user_id, `「${user.nickname}」申请补记 ${body.recordDate}`, approvalId,
              body.recordDate, `makeup:${approvalId}:${recipient.user_id}`, expireAt],
          );
        }
        await emit(connection, recordId, 'makeup.requested', { recordId, approvalId, moduleId, targetDate: body.recordDate });
        return {
          record: { recordId: publicId('r', recordId), status: 'pending', recordDate: body.recordDate },
          approval: {
            approvalId: publicId('ma', approvalId),
            status: 'pending',
            expireAt: isoWithShanghaiOffset(expireAt),
          },
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new AppError('MAKEUP_ALREADY_PENDING', '该日期已有记录或待审批补卡', 409);
      throw error;
    }
    ok(response, result, 201);
  }));

  router.get('/makeup-applications/:approvalId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const approvalId = dbId(request.params.approvalId, 'ma');
    const approval = await loadApproval(pool, approvalId);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', '补卡申请不存在', 404);
    await requireMember(pool, String(approval.module_id), user.userId, { allowPendingDelete: true });
    ok(response, serializeApproval(approval));
  }));

  router.post('/makeup-applications/:approvalId/approve', resolveApproval(pool, 'approve'));
  router.post('/makeup-applications/:approvalId/reject', resolveApproval(pool, 'reject'));

  return router;
}

function resolveApproval(pool: Pool, action: 'approve' | 'reject') {
  return asyncRoute(async (request, response) => {
    const user = authUser(request);
    const approvalId = dbId(request.params.approvalId, 'ma');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, `makeup_${action}`, body.clientRequestId, body, async (connection) => {
      const [rows] = await connection.execute<ApprovalRow[]>(
        'SELECT * FROM makeup_approval WHERE approval_id = ? FOR UPDATE',
        [approvalId],
      );
      const approval = rows[0];
      if (!approval) throw new AppError('APPROVAL_NOT_FOUND', '补卡申请不存在', 404);
      const access = await requireMember(connection, String(approval.module_id), user.userId, { lock: true });
      if (String(approval.applicant_user_id) === user.userId) {
        throw new AppError('APPROVAL_SELF_NOT_ALLOWED', '不能审批自己的补卡申请', 403);
      }
      if (approval.status !== 'pending' || approval.expire_at <= new Date()) {
        throw new AppError('APPROVAL_ALREADY_RESOLVED', '补卡申请已被处理或过期', 409);
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE makeup_approval
            SET status = ?, resolved_at = UTC_TIMESTAMP(3), resolved_by_user_id = ?,
                resolved_by_member_instance_id = ?, version = version + 1
          WHERE approval_id = ? AND status = 'pending' AND expire_at > UTC_TIMESTAMP(3)`,
        [status, user.userId, access.member_instance_id, approvalId],
      );
      if (update.affectedRows !== 1) throw new AppError('APPROVAL_ALREADY_RESOLVED', '补卡申请已被其他成员处理', 409);
      if (action === 'approve') {
        await connection.execute(
          `UPDATE life_record
              SET status = 'locked', approved_at = UTC_TIMESTAMP(3), locked_at = UTC_TIMESTAMP(3),
                  first_effective_at = UTC_TIMESTAMP(3), version = version + 1
            WHERE record_id = ? AND status = 'pending'`,
          [approval.record_id],
        );
      } else {
        await connection.execute(
          `UPDATE life_record SET status = 'rejected', version = version + 1
            WHERE record_id = ? AND status = 'pending'`,
          [approval.record_id],
        );
      }
      await connection.execute(
        `INSERT INTO approval_action
           (approval_id, operator_user_id, operator_member_instance_id, action, result)
         VALUES (?, ?, ?, ?, 'accepted')`,
        [approvalId, user.userId, access.member_instance_id, action],
      );
      await connection.execute(
        `UPDATE module_inbox_item
            SET type = 'makeup_result', title = '补卡已处理', content = ?,
                status = IF(recipient_user_id = ?, 'read', 'unread'),
                updated_at = UTC_TIMESTAMP(3), expire_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
          WHERE target_type = 'makeup_approval' AND target_id = ?`,
        [`「${user.nickname}」已${action === 'approve' ? '通过' : '拒绝'}该补卡申请`, user.userId, approvalId],
      );
      await connection.execute(
        `INSERT IGNORE INTO module_inbox_item
           (module_id, recipient_user_id, type, title, content, target_type, target_id, record_date,
            status, dedupe_key, expire_at)
         VALUES (?, ?, 'makeup_result', ?, ?, 'record', ?, ?, 'unread', ?,
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY))`,
        [approval.module_id, approval.applicant_user_id,
          action === 'approve' ? '补卡已通过' : '补卡未通过',
          action === 'approve' ? '你的补卡记录已经生效' : '本次补卡申请被拒绝',
          approval.record_id, sqlDate(approval.target_date),
          `makeup_result:${approvalId}:${approval.applicant_user_id}`],
      );
      await connection.execute(
        `INSERT INTO notification
           (user_id, type, title, content, module_id, target_type, target_id, record_date,
            action_type, action_status)
         VALUES (?, 'makeup_result', ?, ?, ?, 'record', ?, ?, 'none', 'none')`,
        [approval.applicant_user_id, action === 'approve' ? '补卡已通过' : '补卡未通过',
          action === 'approve' ? '你的补卡记录已经生效' : '本次补卡申请被拒绝', approval.module_id,
          approval.record_id, sqlDate(approval.target_date)],
      );
      await emit(connection, approval.record_id, `makeup.${status}`, {
        approvalId, recordId: approval.record_id, moduleId: approval.module_id,
      });
      return { approvalId: publicId('ma', approvalId), recordId: publicId('r', approval.record_id), status };
    });
    ok(response, result);
  });
}

async function loadApproval(pool: Pool, id: string): Promise<ApprovalRow | undefined> {
  const [rows] = await pool.execute<ApprovalRow[]>('SELECT * FROM makeup_approval WHERE approval_id = ? LIMIT 1', [id]);
  return rows[0];
}

function serializeApproval(approval: ApprovalRow) {
  return {
    approvalId: publicId('ma', approval.approval_id),
    moduleId: publicId('m', approval.module_id),
    recordId: publicId('r', approval.record_id),
    applicantUserId: publicId('u', approval.applicant_user_id),
    applicantMemberInstanceId: publicId('mi', approval.applicant_member_instance_id),
    targetDate: sqlDate(approval.target_date),
    attemptNumber: approval.attempt_number,
    status: approval.status,
    expireAt: isoWithShanghaiOffset(approval.expire_at),
    resolvedAt: approval.resolved_at ? isoWithShanghaiOffset(approval.resolved_at) : null,
    resolutionReason: approval.resolution_reason,
    version: approval.version,
  };
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

async function emit(
  connection: { execute: Pool['execute'] },
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await connection.execute(
    `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload) VALUES ('record', ?, ?, ?)`,
    [aggregateId, eventType, JSON.stringify(payload)],
  );
}
