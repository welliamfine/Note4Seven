import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { addDays, isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent } from '../services/idempotency';
import type { StorageService } from '../services/storage';
import type { WechatService } from '../services/wechat';

const createBody = z.object({
  name: z.string().trim().min(1).max(10),
  description: z.string().trim().max(200).default(''),
  recordPolicy: z.enum(['strict', 'relaxed']),
  templateId: z.string().max(64).optional(),
  clientRequestId: z.string().min(8).max(64),
});

const pinBody = z.object({
  isPinned: z.boolean(),
  clientRequestId: z.string().min(8).max(64),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(10),
  description: z.string().trim().max(200),
  version: z.number().int().nonnegative(),
  clientRequestId: z.string().min(8).max(64),
});

const simpleWriteBody = z.object({ clientRequestId: z.string().min(8).max(64) });
const deleteBody = simpleWriteBody.extend({ confirmationName: z.string().trim().min(1).max(10).optional() });

interface TemplateRow extends RowDataPacket {
  template_id: string;
  template_code: string;
  display_name: string;
  name: string;
  description: string | null;
  sort_order: number;
}

interface ModuleRow extends RowDataPacket {
  module_id: string;
  name: string;
  description: string | null;
  mode: 'solo' | 'group';
  record_policy: 'strict' | 'relaxed';
  status: 'active' | 'pending_delete' | 'deleted';
  creator_user_id: string;
  active_member_count: number;
  member_limit: number;
  last_activity_at: Date;
  deleted_at: Date | null;
  recycle_expire_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  is_pinned?: number;
  current_role?: 'creator' | 'member';
  current_member_instance_id?: string;
  unread_inbox_count?: number;
}

interface MemberRow extends RowDataPacket {
  module_id: string;
  member_instance_id: string;
  user_id: string;
  role: 'creator' | 'member';
  join_sequence: number;
  nickname_snapshot: string;
  avatar_file_key_snapshot: string | null;
  joined_at: Date;
}

interface PreviewRow extends RowDataPacket {
  module_id: string;
  record_id: string;
  member_instance_id: string;
  first_effective_at: Date;
  sticker_thumbnail_file_key: string;
}

export function moduleRoutes(pool: Pool, wechat: WechatService, storage: StorageService): Router {
  const router = Router();

  router.get('/module-templates', asyncRoute(async (_request, response) => {
    const [rows] = await pool.query<TemplateRow[]>(
      `SELECT template_id, template_code, display_name, name, description, sort_order
         FROM module_template WHERE status = 'active' ORDER BY sort_order, template_id`,
    );
    ok(response, {
      items: rows.map((row) => ({
        templateId: `tpl_${row.template_code}`,
        displayName: row.display_name,
        name: row.name,
        description: row.description ?? '',
        sortOrder: row.sort_order,
      })),
    });
  }));

  router.post('/modules', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(createBody, request);
    await wechat.assertTextAllowed(user.openId, `${body.name}\n${body.description}`);

    const result = await idempotent(pool, user.userId, 'create_module', body.clientRequestId, body, async (connection) => {
      let templateId: string | null = null;
      if (body.templateId) {
        const code = /^tpl_([a-zA-Z0-9_-]+)$/.exec(body.templateId)?.[1];
        if (!code) throw new AppError('VALIDATION_ERROR', '模板 ID 不正确', 422);
        const [templates] = await connection.execute<TemplateRow[]>(
          `SELECT template_id FROM module_template WHERE template_code = ? AND status = 'active' LIMIT 1`,
          [code],
        );
        if (!templates[0]) throw new AppError('TEMPLATE_NOT_FOUND', '模板不存在', 404);
        templateId = String(templates[0].template_id);
      }

      const [moduleInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO life_module
           (name, description, template_id, creator_user_id, creator_member_instance_id, record_policy)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        [body.name, body.description || null, templateId, user.userId, body.recordPolicy],
      );
      const moduleId = String(moduleInsert.insertId);
      const [memberInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO module_member
           (module_id, user_id, role, status, join_sequence, nickname_snapshot, avatar_file_key_snapshot)
         VALUES (?, ?, 'creator', 'active', 1, ?, ?)`,
        [moduleId, user.userId, user.nickname, user.avatarFileKey],
      );
      const memberId = String(memberInsert.insertId);
      await connection.execute('UPDATE life_module SET creator_member_instance_id = ? WHERE module_id = ?', [memberId, moduleId]);
      await connection.execute(
        `INSERT INTO user_module_preference (user_id, module_id, is_pinned) VALUES (?, ?, 0)`,
        [user.userId, moduleId],
      );
      await connection.execute(
        `INSERT INTO audit_log
           (module_id, operator_user_id, operator_member_instance_id, action_type, target_type, target_id, result)
         VALUES (?, ?, ?, 'module_create', 'module', ?, 'success')`,
        [moduleId, user.userId, memberId, moduleId],
      );
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('module', ?, 'module.created', JSON_OBJECT('moduleId', ?))`,
        [moduleId, moduleId],
      );
      return {
        moduleId: publicId('m', moduleId),
        mode: 'solo',
        recordPolicy: body.recordPolicy,
        status: 'active',
        currentMember: { memberInstanceId: publicId('mi', memberId), joinSequence: 1, role: 'creator' },
        redirect: { page: 'module_detail', params: { moduleId: publicId('m', moduleId) } },
      };
    });
    ok(response, result, 201);
  }));

  router.get('/home/modules', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const [modules] = await pool.execute<ModuleRow[]>(
      `SELECT m.*, COALESCE(p.is_pinned, 0) AS is_pinned,
              mm.role AS current_role, mm.member_instance_id AS current_member_instance_id,
              (SELECT COUNT(*) FROM module_inbox_item i
                WHERE i.module_id = m.module_id AND i.recipient_user_id = mm.user_id
                  AND i.status = 'unread' AND i.expire_at > CURRENT_TIMESTAMP(3)) AS unread_inbox_count
         FROM module_member mm
         JOIN life_module m ON m.module_id = mm.module_id
         LEFT JOIN user_module_preference p ON p.user_id = mm.user_id AND p.module_id = mm.module_id
        WHERE mm.user_id = ? AND mm.status = 'active' AND m.status = 'active'
        ORDER BY is_pinned DESC, m.last_activity_at DESC, m.module_id DESC`,
      [user.userId],
    );
    const moduleIds = modules.map((module) => String(module.module_id));
    const [members, previews] = moduleIds.length
      ? await Promise.all([loadMembers(pool, moduleIds), loadTodayPreviews(pool, moduleIds)])
      : [[], []] as [MemberRow[], PreviewRow[]];

    const groups = await Promise.all([
      { groupType: 'pinned', title: '置顶模块', items: modules.filter((item) => Boolean(item.is_pinned)) },
      { groupType: 'normal', title: '普通模块', items: modules.filter((item) => !item.is_pinned) },
    ].map(async (group) => ({
      ...group,
      items: await Promise.all(group.items.map((module) => homeModule(module, members, previews, storage))),
    })));
    ok(response, { groups });
  }));

  router.put('/modules/:moduleId/pin', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(pinBody, request);
    await requireMember(pool, moduleId, user.userId);
    const result = await idempotent(pool, user.userId, 'module_pin', body.clientRequestId, body, async (connection) => {
      await connection.execute(
        `INSERT INTO user_module_preference (user_id, module_id, is_pinned)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE is_pinned = VALUES(is_pinned), updated_at = CURRENT_TIMESTAMP(3)`,
        [user.userId, moduleId, body.isPinned],
      );
      return { moduleId: publicId('m', moduleId), isPinned: body.isPinned };
    });
    ok(response, result);
  }));

  router.get('/modules/recycle-bin', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const [rows] = await pool.execute<ModuleRow[]>(
      `SELECT m.* FROM life_module m
        JOIN module_member mm ON mm.module_id = m.module_id
       WHERE mm.user_id = ? AND mm.status = 'active' AND mm.role = 'creator'
         AND m.status = 'pending_delete'
       ORDER BY m.recycle_expire_at`,
      [user.userId],
    );
    ok(response, {
      items: rows.map((row) => ({
        moduleId: publicId('m', row.module_id),
        name: row.name,
        description: row.description ?? '',
        deletedAt: row.deleted_at ? isoWithShanghaiOffset(row.deleted_at) : null,
        recycleExpireAt: row.recycle_expire_at ? isoWithShanghaiOffset(row.recycle_expire_at) : null,
      })),
    });
  }));

  router.get('/modules/:moduleId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId);
    const [module, members] = await Promise.all([loadModule(pool, moduleId), loadMembers(pool, [moduleId])]);
    if (!module) throw new AppError('MODULE_NOT_FOUND', '模块不存在', 404);
    const today = shanghaiDate();
    const [records] = await pool.execute<RowDataPacket[]>(
      `SELECT member_instance_id, status FROM life_record
        WHERE module_id = ? AND record_date = ? AND status IN ('pending', 'active', 'locked')`,
      [moduleId, today],
    );
    const statusByMember = new Map(records.map((row) => [String(row.member_instance_id), String(row.status)]));
    ok(response, {
      module: {
        moduleId: publicId('m', moduleId),
        name: module.name,
        description: module.description ?? '',
        mode: module.mode,
        recordPolicy: module.record_policy,
        status: module.status,
        activeMemberCount: module.active_member_count,
        memberLimit: module.member_limit,
        currentUserRole: access.role,
        version: module.version,
        availableActions: moduleActions(access.role),
      },
      memberStatusBar: await Promise.all(members.map(async (member) => ({
        memberInstanceId: publicId('mi', member.member_instance_id),
        userId: publicId('u', member.user_id),
        joinSequence: member.join_sequence,
        nickname: member.nickname_snapshot,
        avatarUrl: member.avatar_file_key_snapshot ? await storage.signedUrl(member.avatar_file_key_snapshot) : null,
        isCurrentUser: String(member.user_id) === user.userId,
        role: member.role,
        joinedAt: isoWithShanghaiOffset(member.joined_at),
        todayRecordStatus: statusByMember.get(String(member.member_instance_id)) ?? 'not_recorded',
        isDimmed: !statusByMember.has(String(member.member_instance_id)),
        showCompletedBadge: ['active', 'locked'].includes(statusByMember.get(String(member.member_instance_id)) ?? ''),
      }))),
      serverDate: today,
    });
  }));

  router.patch('/modules/:moduleId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'recordPolicy')) {
      throw new AppError('RECORD_POLICY_IMMUTABLE', '记录模式创建后不能修改', 422);
    }
    const body = parseBody(updateBody, request);
    await wechat.assertTextAllowed(user.openId, `${body.name}\n${body.description}`);
    const result = await idempotent(pool, user.userId, 'module_update', body.clientRequestId, body, async (connection) => {
      await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE life_module SET name = ?, description = ?, version = version + 1
          WHERE module_id = ? AND version = ?`,
        [body.name, body.description || null, moduleId, body.version],
      );
      if (update.affectedRows !== 1) throw new AppError('VERSION_CONFLICT', '模块已被修改，请刷新后重试', 409);
      return { moduleId: publicId('m', moduleId), name: body.name, description: body.description, version: body.version + 1 };
    });
    ok(response, result);
  }));

  router.post('/modules/:moduleId/delete', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(deleteBody, request);
    const result = await idempotent(pool, user.userId, 'module_delete', body.clientRequestId, body, async (connection) => {
      await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      const [rows] = await connection.execute<ModuleRow[]>('SELECT status FROM life_module WHERE module_id = ? FOR UPDATE', [moduleId]);
      const module = rows[0];
      if (!module) throw new AppError('MODULE_NOT_FOUND', '模块不存在', 404);
      const now = new Date();
      const expireAt = addDays(now, 7);
      await connection.execute(
        `UPDATE life_module SET status = 'pending_delete', deleted_at = ?, recycle_expire_at = ?, version = version + 1
          WHERE module_id = ? AND status = 'active'`,
        [now, expireAt, moduleId],
      );
      await connection.execute(
        `UPDATE reminder_subscription SET enabled = 0, version = version + 1 WHERE module_id = ?`,
        [moduleId],
      );
      await connection.execute(
        `UPDATE discovery_recruitment
            SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE module_id = ? AND status = 'recruiting'`,
        [moduleId],
      );
      await audit(connection, moduleId, user.userId, 'module_delete', 'module', moduleId);
      return { moduleId: publicId('m', moduleId), status: 'pending_delete', recycleExpireAt: isoWithShanghaiOffset(expireAt) };
    });
    ok(response, result);
  }));

  router.post('/modules/:moduleId/restore', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'module_restore', body.clientRequestId, body, async (connection) => {
      await requireMember(connection, moduleId, user.userId, { creator: true, allowPendingDelete: true, lock: true });
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE life_module
            SET status = 'active', deleted_at = NULL, recycle_expire_at = NULL, version = version + 1
          WHERE module_id = ? AND status = 'pending_delete' AND recycle_expire_at > CURRENT_TIMESTAMP(3)`,
        [moduleId],
      );
      if (update.affectedRows !== 1) throw new AppError('MODULE_DELETED', '模块已无法恢复', 410);
      await audit(connection, moduleId, user.userId, 'module_restore', 'module', moduleId);
      return { moduleId: publicId('m', moduleId), status: 'active' };
    });
    ok(response, result);
  }));

  router.get('/modules/:moduleId/settings', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const module = await loadModule(pool, moduleId);
    ok(response, {
      moduleId: publicId('m', moduleId),
      name: module?.name,
      description: module?.description ?? '',
      recordPolicy: module?.record_policy,
      status: module?.status,
      version: module?.version,
      currentUserRole: access.role,
      availableActions: moduleActions(access.role),
    });
  }));

  return router;
}

async function loadModule(pool: Pool, moduleId: string): Promise<ModuleRow | undefined> {
  const [rows] = await pool.execute<ModuleRow[]>('SELECT * FROM life_module WHERE module_id = ? LIMIT 1', [moduleId]);
  return rows[0];
}

async function loadMembers(pool: Pool, moduleIds: string[]): Promise<MemberRow[]> {
  if (!moduleIds.length) return [];
  const placeholders = moduleIds.map(() => '?').join(',');
  const [rows] = await pool.query<MemberRow[]>(
    `SELECT mm.module_id, mm.member_instance_id, mm.user_id, mm.role, mm.join_sequence,
            u.nickname AS nickname_snapshot, u.avatar_file_key AS avatar_file_key_snapshot, mm.joined_at
       FROM module_member mm
       JOIN user_account u ON u.user_id = mm.user_id
      WHERE mm.module_id IN (${placeholders}) AND mm.status = 'active'
      ORDER BY mm.module_id, mm.join_sequence`,
    moduleIds,
  );
  return rows;
}

async function loadTodayPreviews(pool: Pool, moduleIds: string[]): Promise<PreviewRow[]> {
  const placeholders = moduleIds.map(() => '?').join(',');
  const [rows] = await pool.query<PreviewRow[]>(
    `SELECT r.module_id, r.record_id, r.member_instance_id, r.first_effective_at,
            CASE WHEN r.media_variant = 'original'
              THEN IF(ma.thumbnail_file_key IS NULL OR ma.thumbnail_file_key = ma.sticker_thumbnail_file_key,
                ma.original_file_key, ma.thumbnail_file_key)
              ELSE ma.sticker_thumbnail_file_key END AS sticker_thumbnail_file_key
       FROM life_record r
       JOIN module_member mm ON mm.member_instance_id = r.member_instance_id
        AND mm.module_id = r.module_id AND mm.status = 'active'
       JOIN media_asset ma ON ma.media_id = r.media_id
      WHERE r.module_id IN (${placeholders}) AND r.record_date = ?
        AND r.status IN ('active', 'locked') AND ma.status = 'ready'
      ORDER BY r.module_id, r.first_effective_at ASC`,
    [...moduleIds, shanghaiDate()],
  );
  return rows;
}

async function homeModule(
  module: ModuleRow,
  members: MemberRow[],
  previews: PreviewRow[],
  storage: StorageService,
) {
  const moduleId = String(module.module_id);
  const activeMembers = members.filter((member) => String(member.module_id) === moduleId);
  const todayPreviews = previews.filter((record) => String(record.module_id) === moduleId).slice(-4);
  return {
    moduleId: publicId('m', moduleId),
    moduleName: module.name,
    description: module.description ?? '',
    mode: module.mode,
    recordPolicy: module.record_policy,
    status: module.status,
    creatorUserId: publicId('u', module.creator_user_id),
    createdAt: isoWithShanghaiOffset(module.created_at),
    updatedAt: isoWithShanghaiOffset(module.updated_at),
    version: module.version,
    currentUserRole: module.current_role ?? 'member',
    isPinned: Boolean(module.is_pinned),
    unreadInboxCount: Number(module.unread_inbox_count ?? 0),
    lastActivityAt: isoWithShanghaiOffset(module.last_activity_at),
    activeMembers: await Promise.all(activeMembers.map(async (member) => ({
      memberInstanceId: publicId('mi', member.member_instance_id),
      userId: publicId('u', member.user_id),
      joinSequence: member.join_sequence,
      nickname: member.nickname_snapshot,
      role: member.role,
      joinedAt: isoWithShanghaiOffset(member.joined_at),
      avatarUrl: member.avatar_file_key_snapshot ? await storage.signedUrl(member.avatar_file_key_snapshot) : null,
    }))),
    todayPreviewItems: await Promise.all(todayPreviews.map(async (record, index) => ({
      recordId: publicId('r', record.record_id),
      memberInstanceId: publicId('mi', record.member_instance_id),
      stickerThumbnailUrl: await storage.signedUrl(record.sticker_thumbnail_file_key),
      firstEffectiveAt: isoWithShanghaiOffset(record.first_effective_at),
      displayOrder: index,
    }))),
    availableActions: moduleActions(module.current_role ?? 'member').filter((action) => action !== 'edit_module'),
  };
}

function moduleActions(role: 'creator' | 'member'): string[] {
  return role === 'creator'
    ? ['open', 'edit_module', 'invite', 'manage_members', 'record_today', 'delete_module']
    : ['open', 'record_today', 'leave'];
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
