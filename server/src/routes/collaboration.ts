import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { opaqueToken, publicId, sha256 } from '../lib/ids';
import { addDays, addHours, isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent, isDuplicateKey } from '../services/idempotency';
import type { StorageService } from '../services/storage';

const writeBody = z.object({ clientRequestId: z.string().min(8).max(64) });
const transferBody = z.object({
  targetMemberInstanceId: z.string(),
  clientRequestId: z.string().min(8).max(64),
});

interface InviteRow extends RowDataPacket {
  invite_token_id: string;
  module_id: string;
  created_by_user_id: string;
  created_by_member_instance_id: string;
  token_hash: string;
  status: string;
  expire_at: Date;
  mini_program_code_file_key: string | null;
  module_name: string;
  module_description: string | null;
  module_status: string;
  active_member_count: number;
  member_limit: number;
  inviter_name: string;
  inviter_avatar_file_key: string | null;
}

interface ApplicationRow extends RowDataPacket {
  application_id: string;
  module_id: string;
  applicant_user_id: string;
  invite_token_id: string;
  status: string;
  applicant_name_snapshot: string;
  applicant_avatar_file_key_snapshot: string | null;
  expire_at: Date;
  reapply_allowed_at: Date | null;
  resolved_at: Date | null;
  resolved_by_user_id: string | null;
  result_member_instance_id: string | null;
  resolution_reason: string | null;
  version: number;
}

interface MemberRow extends RowDataPacket {
  member_instance_id: string;
  module_id: string;
  user_id: string;
  role: 'creator' | 'member';
  status: string;
  join_sequence: number;
  nickname_snapshot: string;
  avatar_file_key_snapshot: string | null;
  joined_at: Date;
}

export function collaborationRoutes(pool: Pool, storage: StorageService): Router {
  const router = Router();

  router.post('/modules/:moduleId/invites', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(writeBody, request);
    const secret = opaqueToken(24);
    const result = await idempotent(pool, user.userId, 'invite_create', body.clientRequestId, body, async (connection) => {
      const access = await requireMember(connection, moduleId, user.userId, { lock: true });
      if (access.active_member_count >= access.member_limit) throw new AppError('MODULE_MEMBER_LIMIT_REACHED', '模块成员已满', 409);
      const expireAt = addHours(new Date(), 24);
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO invite_token
           (module_id, created_by_user_id, created_by_member_instance_id, token_hash, token_prefix, status, expire_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [moduleId, user.userId, access.member_instance_id, sha256(secret), secret.slice(0, 8), expireAt],
      );
      const inviteId = String(insert.insertId);
      const publicInviteId = invitePublicId(inviteId, secret);
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('invite', ?, 'invite.code_requested', ?)`,
        [inviteId, JSON.stringify({ inviteId, publicInviteId })],
      );
      return {
        inviteId: publicInviteId,
        expireAt: isoWithShanghaiOffset(expireAt),
        sharePath: `/pages/invite-intro/index?inviteId=${encodeURIComponent(publicInviteId)}`,
        miniProgramCodeUrl: null,
        codeStatus: 'processing',
      };
    });
    ok(response, result, 201);
  }));

  router.get('/invites/:inviteId/share-preview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const token = parseInvite(request.params.inviteId);
    const invite = await loadInvite(pool, token.id, token.secret);
    await requireMember(pool, invite.module_id, user.userId);
    ok(response, await invitePreview(invite, request.params.inviteId, storage));
  }));

  router.get('/public/invites/:inviteId', asyncRoute(async (request, response) => {
    const token = parseInvite(request.params.inviteId);
    const invite = await loadInvite(pool, token.id, token.secret);
    assertInviteUsable(invite);
    ok(response, await invitePreview(invite, request.params.inviteId, storage));
  }));

  router.get('/public/invite-scenes/:secret', asyncRoute(async (request, response) => {
    const secret = Array.isArray(request.params.secret) ? request.params.secret[0] : request.params.secret;
    if (!/^[a-zA-Z0-9_-]{20,32}$/.test(secret ?? '')) throw new AppError('INVITE_EXPIRED', '邀请不存在或已失效', 410);
    const invite = await loadInviteBySecret(pool, secret);
    assertInviteUsable(invite);
    ok(response, await invitePreview(invite, secret, storage));
  }));

  router.post('/invites/:inviteId/applications', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(writeBody, request);
    const token = parseInvite(request.params.inviteId);
    const result = await idempotent(pool, user.userId, 'join_apply', body.clientRequestId, body, async (connection) => {
      const invite = await loadInvite(connection, token.id, token.secret, true);
      assertInviteUsable(invite);
      const [existingMember] = await connection.execute<RowDataPacket[]>(
        `SELECT member_instance_id FROM module_member WHERE module_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
        [invite.module_id, user.userId],
      );
      if (existingMember[0]) return { status: 'already_member', moduleId: publicId('m', invite.module_id) };

      const [previous] = await connection.execute<ApplicationRow[]>(
        `SELECT * FROM join_application
          WHERE module_id = ? AND applicant_user_id = ?
          ORDER BY application_id DESC LIMIT 1 FOR UPDATE`,
        [invite.module_id, user.userId],
      );
      if (previous[0]?.status === 'pending') {
        throw new AppError('JOIN_APPLICATION_ALREADY_PENDING', '已有待处理的加入申请', 409, {
          applicationId: publicId('ja', previous[0].application_id),
        });
      }
      if (previous[0]?.reapply_allowed_at && previous[0].reapply_allowed_at > new Date()) {
        throw new AppError('JOIN_REAPPLY_COOLDOWN', '暂时不能再次申请', 429, {
          reapplyAllowedAt: isoWithShanghaiOffset(previous[0].reapply_allowed_at),
        });
      }
      const expireAt = addDays(new Date(), 7);
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO join_application
           (module_id, applicant_user_id, invite_token_id, status, applicant_name_snapshot,
            applicant_avatar_file_key_snapshot, expire_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        [invite.module_id, user.userId, invite.invite_token_id, user.nickname, user.avatarFileKey, expireAt],
      );
      const applicationId = String(insert.insertId);
      await connection.execute(
        `INSERT INTO notification
           (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status, expired_at,
            dedupe_key)
         VALUES (?, 'join_application_created', '新的加入申请', ?, ?, 'join_application', ?,
                 'approve_join', 'actionable', ?, ?)`,
        [invite.created_by_user_id, `「${user.nickname}」申请加入 ${invite.module_name}`, invite.module_id,
          applicationId, expireAt, `join_application:${applicationId}`],
      );
      return {
        applicationId: publicId('ja', applicationId),
        moduleId: publicId('m', invite.module_id),
        status: 'pending',
        expireAt: isoWithShanghaiOffset(expireAt),
      };
    });
    ok(response, result, 201);
  }));

  router.post('/modules/:moduleId/invites/revoke', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'invite_revoke_all', body.clientRequestId, body, async (connection) => {
      await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE invite_token SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3)
          WHERE module_id = ? AND status = 'active'`,
        [moduleId],
      );
      await audit(connection, moduleId, user.userId, 'invite_revoke_all', 'module', moduleId);
      return { moduleId: publicId('m', moduleId), revokedCount: update.affectedRows };
    });
    ok(response, result);
  }));

  router.get('/join-applications/:applicationId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const applicationId = dbId(request.params.applicationId, 'ja');
    const application = await loadApplication(pool, applicationId);
    if (!application) throw new AppError('JOIN_APPLICATION_NOT_FOUND', '加入申请不存在', 404);
    const access = await optionalMember(pool, application.module_id, user.userId);
    if (String(application.applicant_user_id) !== user.userId && access?.role !== 'creator') {
      throw new AppError('NO_MODULE_PERMISSION', '无权查看该申请', 403);
    }
    ok(response, serializeApplication(application));
  }));

  router.post('/join-applications/:applicationId/approve', resolveJoin(pool, 'approve'));
  router.post('/join-applications/:applicationId/reject', resolveJoin(pool, 'reject'));

  router.get('/modules/:moduleId/members', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const [members] = await pool.execute<MemberRow[]>(
      `SELECT * FROM module_member WHERE module_id = ? AND status = 'active' ORDER BY join_sequence`,
      [moduleId],
    );
    const [todayRecords] = await pool.execute<RowDataPacket[]>(
      `SELECT member_instance_id, status FROM life_record
        WHERE module_id = ? AND record_date = ? AND status IN ('pending', 'active', 'locked')`,
      [moduleId, shanghaiDate()],
    );
    const statusByMember = new Map(todayRecords.map((row) => [String(row.member_instance_id), String(row.status)]));
    ok(response, {
      activeMemberCount: members.length,
      memberLimit: 4,
      inviteAvailable: members.length < 4 && access.module_status === 'active',
      inviteValidityHours: 24,
      members: await Promise.all(members.map(async (member) => ({
        memberInstanceId: publicId('mi', member.member_instance_id),
        userId: publicId('u', member.user_id),
        joinSequence: member.join_sequence,
        nickname: member.nickname_snapshot,
        avatarUrl: member.avatar_file_key_snapshot ? await storage.signedUrl(member.avatar_file_key_snapshot) : null,
        role: member.role,
        isCurrentUser: String(member.user_id) === user.userId,
        joinedAt: isoWithShanghaiOffset(member.joined_at),
        todayRecordStatus: statusByMember.get(String(member.member_instance_id)) ?? 'not_recorded',
        availableActions: access.role === 'creator' && member.role !== 'creator'
          ? ['transfer_creator', 'remove']
          : [],
      }))),
      creatorExitRestriction: '创建者不能直接退出，需先转让创建者身份或删除模块。',
    });
  }));

  router.post('/modules/:moduleId/creator-transfer', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(transferBody, request);
    const targetId = dbId(body.targetMemberInstanceId, 'mi');
    const result = await idempotent(pool, user.userId, 'creator_transfer', body.clientRequestId, body, async (connection) => {
      const current = await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      const [targets] = await connection.execute<MemberRow[]>(
        `SELECT * FROM module_member WHERE member_instance_id = ? AND module_id = ? AND status = 'active' FOR UPDATE`,
        [targetId, moduleId],
      );
      const target = targets[0];
      if (!target || target.role === 'creator') throw new AppError('TARGET_MEMBER_NOT_FOUND', '目标成员不存在', 404);
      await connection.execute(`UPDATE module_member SET role = 'member', version = version + 1 WHERE member_instance_id = ?`, [current.member_instance_id]);
      await connection.execute(`UPDATE module_member SET role = 'creator', version = version + 1 WHERE member_instance_id = ?`, [targetId]);
      await connection.execute(
        `UPDATE life_module SET creator_user_id = ?, creator_member_instance_id = ?, version = version + 1 WHERE module_id = ?`,
        [target.user_id, targetId, moduleId],
      );
      await connection.execute(
        `INSERT INTO notification (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status)
         VALUES (?, 'creator_transferred', '你已成为创建者', '模块创建者身份已转让给你', ?, 'member', ?, 'none', 'none')`,
        [target.user_id, moduleId, targetId],
      );
      await audit(connection, moduleId, user.userId, 'creator_transfer', 'member', targetId);
      return { moduleId: publicId('m', moduleId), creatorMemberInstanceId: publicId('mi', targetId) };
    });
    ok(response, result);
  }));

  router.post('/modules/:moduleId/members/:memberInstanceId/remove', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const targetId = dbId(request.params.memberInstanceId, 'mi');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'member_remove', body.clientRequestId, body, async (connection) => {
      await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      const [targets] = await connection.execute<MemberRow[]>(
        `SELECT * FROM module_member WHERE member_instance_id = ? AND module_id = ? AND status = 'active' FOR UPDATE`,
        [targetId, moduleId],
      );
      const target = targets[0];
      if (!target || target.role === 'creator') throw new AppError('TARGET_MEMBER_NOT_FOUND', '目标成员不存在', 404);
      await deactivateMember(connection, target, 'removed');
      await connection.execute(`UPDATE life_module SET active_member_count = active_member_count - 1, version = version + 1 WHERE module_id = ?`, [moduleId]);
      await connection.execute(
        `INSERT INTO notification (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status)
         VALUES (?, 'member_removed', '你已被移出模块', '你已不再是该模块成员', ?, 'member', ?, 'none', 'none')`,
        [target.user_id, moduleId, targetId],
      );
      await audit(connection, moduleId, user.userId, 'member_remove', 'member', targetId);
      return { moduleId: publicId('m', moduleId), memberInstanceId: publicId('mi', targetId), status: 'removed' };
    });
    ok(response, result);
  }));

  router.post('/modules/:moduleId/leave', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, 'module_leave', body.clientRequestId, body, async (connection) => {
      const access = await requireMember(connection, moduleId, user.userId, { lock: true });
      if (access.role === 'creator') throw new AppError('CREATOR_CANNOT_LEAVE', '创建者需先转让身份或删除模块', 409);
      const [rows] = await connection.execute<MemberRow[]>('SELECT * FROM module_member WHERE member_instance_id = ? FOR UPDATE', [access.member_instance_id]);
      await deactivateMember(connection, rows[0], 'self_exit');
      await connection.execute(`UPDATE life_module SET active_member_count = active_member_count - 1, version = version + 1 WHERE module_id = ?`, [moduleId]);
      await audit(connection, moduleId, user.userId, 'member_leave', 'member', String(access.member_instance_id));
      return { moduleId: publicId('m', moduleId), status: 'exited' };
    });
    ok(response, result);
  }));

  return router;
}

function resolveJoin(pool: Pool, action: 'approve' | 'reject') {
  return asyncRoute(async (request, response) => {
    const user = authUser(request);
    const applicationId = dbId(request.params.applicationId, 'ja');
    const body = parseBody(writeBody, request);
    const result = await idempotent(pool, user.userId, `join_${action}`, body.clientRequestId, body, async (connection) => {
      const [applications] = await connection.execute<ApplicationRow[]>(
        'SELECT * FROM join_application WHERE application_id = ? FOR UPDATE',
        [applicationId],
      );
      const application = applications[0];
      if (!application) throw new AppError('JOIN_APPLICATION_NOT_FOUND', '加入申请不存在', 404);
      const access = await requireMember(connection, String(application.module_id), user.userId, { creator: true, lock: true });
      if (application.status !== 'pending' || application.expire_at <= new Date()) {
        throw new AppError('JOIN_APPLICATION_ALREADY_RESOLVED', '申请已经处理或过期', 409);
      }

      let memberId: string | null = null;
      if (action === 'approve') {
        if (access.active_member_count >= access.member_limit) throw new AppError('MODULE_MEMBER_LIMIT_REACHED', '模块成员已满', 409);
        const [existing] = await connection.execute<RowDataPacket[]>(
          `SELECT member_instance_id FROM module_member
            WHERE module_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
          [application.module_id, application.applicant_user_id],
        );
        if (existing[0]) throw new AppError('JOIN_APPLICATION_ALREADY_RESOLVED', '申请人已经是成员', 409);
        const sequence = access.next_join_sequence;
        const [insert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO module_member
             (module_id, user_id, role, status, join_sequence, nickname_snapshot, avatar_file_key_snapshot)
           VALUES (?, ?, 'member', 'active', ?, ?, ?)`,
          [application.module_id, application.applicant_user_id, sequence,
            application.applicant_name_snapshot, application.applicant_avatar_file_key_snapshot],
        );
        memberId = String(insert.insertId);
        await connection.execute(
          `UPDATE life_module
              SET active_member_count = active_member_count + 1, next_join_sequence = next_join_sequence + 1,
                  mode = 'group', group_activated_at = COALESCE(group_activated_at, UTC_TIMESTAMP(3)), version = version + 1
            WHERE module_id = ?`,
          [application.module_id],
        );
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      await connection.execute(
        `UPDATE join_application
            SET status = ?, resolved_at = UTC_TIMESTAMP(3), resolved_by_user_id = ?, result_member_instance_id = ?,
                reapply_allowed_at = ${action === 'reject' ? 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)' : 'NULL'},
                version = version + 1
          WHERE application_id = ? AND status = 'pending'`,
        [status, user.userId, memberId, applicationId],
      );
      await connection.execute(
        `UPDATE notification SET action_status = 'resolved', updated_at = UTC_TIMESTAMP(3)
          WHERE target_type = 'join_application' AND target_id = ?`,
        [applicationId],
      );
      await connection.execute(
        `INSERT INTO notification
           (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status)
         VALUES (?, 'join_result', ?, ?, ?, 'join_application', ?, 'none', 'none')`,
        [application.applicant_user_id, action === 'approve' ? '加入申请已通过' : '加入申请未通过',
          action === 'approve' ? '你已经加入模块' : '创建者拒绝了本次申请', application.module_id, applicationId],
      );
      await audit(connection, String(application.module_id), user.userId, `join_${action}`, 'join_application', applicationId);
      return {
        applicationId: publicId('ja', applicationId),
        status,
        memberInstanceId: memberId ? publicId('mi', memberId) : null,
      };
    });
    ok(response, result);
  });
}

async function loadInvite(
  database: { execute: Pool['execute'] },
  id: string,
  secret: string,
  lock = false,
): Promise<InviteRow> {
  const [rows] = await database.execute<InviteRow[]>(
    `SELECT i.*, m.name AS module_name, m.description AS module_description, m.status AS module_status,
            m.active_member_count, m.member_limit, mm.nickname_snapshot AS inviter_name,
            mm.avatar_file_key_snapshot AS inviter_avatar_file_key
       FROM invite_token i
       JOIN life_module m ON m.module_id = i.module_id
       JOIN module_member mm ON mm.member_instance_id = i.created_by_member_instance_id
      WHERE i.invite_token_id = ? AND i.token_hash = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [id, sha256(secret)],
  );
  if (!rows[0]) throw new AppError('INVITE_EXPIRED', '邀请不存在或已失效', 410);
  return rows[0];
}

async function loadInviteBySecret(database: { execute: Pool['execute'] }, secret: string): Promise<InviteRow> {
  const [rows] = await database.execute<InviteRow[]>(
    `SELECT i.*, m.name AS module_name, m.description AS module_description, m.status AS module_status,
            m.active_member_count, m.member_limit, mm.nickname_snapshot AS inviter_name,
            mm.avatar_file_key_snapshot AS inviter_avatar_file_key
       FROM invite_token i
       JOIN life_module m ON m.module_id = i.module_id
       JOIN module_member mm ON mm.member_instance_id = i.created_by_member_instance_id
      WHERE i.token_hash = ? LIMIT 1`,
    [sha256(secret)],
  );
  if (!rows[0]) throw new AppError('INVITE_EXPIRED', '邀请不存在或已失效', 410);
  return rows[0];
}

function assertInviteUsable(invite: InviteRow): void {
  if (invite.status === 'revoked') throw new AppError('INVITE_REVOKED', '邀请已撤销', 410);
  if (invite.status !== 'active' || invite.expire_at <= new Date()) throw new AppError('INVITE_EXPIRED', '邀请已过期', 410);
  if (invite.module_status !== 'active') throw new AppError('MODULE_PENDING_DELETE', '模块暂不可加入', 409);
  if (invite.active_member_count >= invite.member_limit) throw new AppError('MODULE_MEMBER_LIMIT_REACHED', '模块成员已满', 409);
}

async function invitePreview(invite: InviteRow, inviteId: string | string[], storage: StorageService) {
  const candidate = Array.isArray(inviteId) ? inviteId[0] : inviteId;
  return {
    inviteId: candidate.startsWith('inv_') ? candidate : invitePublicId(invite.invite_token_id, candidate),
    moduleId: publicId('m', invite.module_id),
    moduleName: invite.module_name,
    description: invite.module_description ?? '',
    inviterName: invite.inviter_name,
    inviterAvatarUrl: invite.inviter_avatar_file_key
      ? await storage.signedUrl(invite.inviter_avatar_file_key)
      : null,
    activeMemberCount: invite.active_member_count,
    memberLimit: invite.member_limit,
    status: invite.status,
    expireAt: isoWithShanghaiOffset(invite.expire_at),
    miniProgramCodeUrl: invite.mini_program_code_file_key
      ? await storage.signedUrl(invite.mini_program_code_file_key)
      : null,
    codeStatus: invite.mini_program_code_file_key ? 'ready' : 'processing',
  };
}

async function loadApplication(pool: Pool, id: string): Promise<ApplicationRow | undefined> {
  const [rows] = await pool.execute<ApplicationRow[]>('SELECT * FROM join_application WHERE application_id = ? LIMIT 1', [id]);
  return rows[0];
}

function serializeApplication(application: ApplicationRow) {
  return {
    applicationId: publicId('ja', application.application_id),
    moduleId: publicId('m', application.module_id),
    applicantUserId: publicId('u', application.applicant_user_id),
    applicantName: application.applicant_name_snapshot,
    status: application.status,
    expireAt: isoWithShanghaiOffset(application.expire_at),
    reapplyAllowedAt: application.reapply_allowed_at ? isoWithShanghaiOffset(application.reapply_allowed_at) : null,
    resolvedAt: application.resolved_at ? isoWithShanghaiOffset(application.resolved_at) : null,
    memberInstanceId: application.result_member_instance_id ? publicId('mi', application.result_member_instance_id) : null,
    version: application.version,
  };
}

async function optionalMember(pool: Pool, moduleId: string, userId: string): Promise<MemberRow | undefined> {
  const [rows] = await pool.execute<MemberRow[]>(
    `SELECT * FROM module_member WHERE module_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    [moduleId, userId],
  );
  return rows[0];
}

async function deactivateMember(
  connection: { execute: Pool['execute'] },
  member: MemberRow,
  reason: 'removed' | 'self_exit',
): Promise<void> {
  await connection.execute(
    `UPDATE module_member SET status = ?, left_at = UTC_TIMESTAMP(3), leave_reason = ?, version = version + 1
      WHERE member_instance_id = ? AND status = 'active'`,
    [reason === 'removed' ? 'removed' : 'exited', reason, member.member_instance_id],
  );
  await connection.execute(
    `UPDATE life_record SET display_name_snapshot = '已退出成员', avatar_file_key_snapshot = NULL
      WHERE member_instance_id = ?`,
    [member.member_instance_id],
  );
  await connection.execute(
    `UPDATE reaction SET reactor_name_snapshot = '已退出成员', reactor_avatar_file_key_snapshot = NULL
      WHERE reactor_member_instance_id = ?`,
    [member.member_instance_id],
  );
  await connection.execute(`UPDATE reminder_subscription SET enabled = 0 WHERE member_instance_id = ?`, [member.member_instance_id]);
}

function invitePublicId(id: string, secret: string): string {
  return `inv_${id}_${secret}`;
}

function parseInvite(value: string | string[] | undefined): { id: string; secret: string } {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = /^inv_(\d+)_([a-zA-Z0-9_-]{20,64})$/.exec(candidate ?? '');
  if (!match) throw new AppError('INVITE_EXPIRED', '邀请不存在或已失效', 410);
  return { id: match[1], secret: match[2] };
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(candidate ?? '');
  if (!match) throw new AppError('VALIDATION_ERROR', '资源 ID 不正确', 422);
  return match[1];
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
