import { Router } from 'express';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody, parseQuery } from '../lib/http';
import { opaqueToken, parsePublicId, publicId, sha256 } from '../lib/ids';
import { addDays, isoWithShanghaiOffset } from '../lib/time';
import { authUser, type AuthenticatedUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import {
  discoveryCursor,
  copyDiscoverySnapshot,
  type DiscoveryPostRow,
  effectiveRecruitmentStatus,
  monthRange,
  normalizePublicText,
  parseDiscoveryCursor,
  publicSnapshot,
  serializeDiscoveryPost,
  sqlDate,
} from '../services/discovery';
import { idempotent } from '../services/idempotency';
import type { StorageService } from '../services/storage';
import type { WechatService } from '../services/wechat';

type Queryable = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

const feedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});
const previewQuery = z.object({
  postType: z.enum(['record', 'calendar', 'board', 'easter_egg']),
  sourceId: z.string(),
  moduleId: z.string().optional(),
  month: z.string().optional(),
  stage: z.enum(['unlocked', 'redeemed']).optional(),
});
const recruitmentPreviewQuery = z.object({ moduleId: z.string() });
const publishBody = z.object({
  postType: z.enum(['record', 'calendar', 'board', 'easter_egg']),
  sourceId: z.string(),
  moduleId: z.string().optional(),
  month: z.string().optional(),
  stage: z.enum(['unlocked', 'redeemed']).optional(),
  publicText: z.string().max(500).optional().default(''),
  clientRequestId: z.string().min(8).max(64),
});
const recruitmentBody = z.object({
  moduleId: z.string(),
  publicDescription: z.string().trim().min(1).max(300),
  durationDays: z.union([z.literal(1), z.literal(3), z.literal(7)]),
  clientRequestId: z.string().min(8).max(64),
});
const likeBody = z.object({ liked: z.boolean(), clientRequestId: z.string().min(8).max(64) });
const commentBody = z.object({
  content: z.string().trim().min(1).max(500),
  parentCommentId: z.string().optional(),
  clientRequestId: z.string().min(8).max(64),
});
const simpleWriteBody = z.object({ clientRequestId: z.string().min(8).max(64) });
const reportBody = z.object({
  reason: z.enum(['spam', 'abuse', 'privacy', 'illegal', 'other']),
  detail: z.string().trim().max(300).optional().default(''),
  clientRequestId: z.string().min(8).max(64),
});

interface CommentRow extends RowDataPacket {
  comment_id: string;
  post_id: string;
  user_id: string;
  parent_comment_id: string | null;
  reply_to_user_id: string | null;
  author_name_snapshot: string;
  author_avatar_file_key_snapshot: string | null;
  content: string;
  created_at: Date;
  reply_to_name: string | null;
}

interface RecruitmentRow extends RowDataPacket {
  recruitment_id: string;
  module_id: string;
  post_id: string;
  creator_user_id: string;
  invite_token_id: string;
  public_description: string;
  member_count_at_publish: number;
  member_limit: number;
  recruitment_slots: number;
  expire_at: Date;
  status: string;
  module_name: string;
  module_description: string | null;
  module_status: string;
  module_mode: string;
  record_policy: string;
  active_member_count: number;
  creator_name: string;
  creator_avatar_file_key: string | null;
}

interface SnapshotBuildResult {
  sourceType: string;
  sourceReference: string;
  snapshot: Record<string, unknown>;
}

export function discoveryRoutes(
  pool: Pool,
  storage: StorageService,
  wechat: WechatService,
): Router {
  const router = Router();

  router.get('/discovery/feed', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const query = parseQuery(feedQuery, request);
    const cursor = parseDiscoveryCursor(query.cursor);
    const [rows] = await pool.execute<DiscoveryPostRow[]>(
      `${postSelectSql()}
       WHERE p.status = 'published'
         AND (? IS NULL OR p.post_id < ?)
         AND NOT EXISTS (
           SELECT 1 FROM discovery_user_block b
            WHERE (b.blocker_user_id = ? AND b.blocked_user_id = p.author_user_id)
               OR (b.blocker_user_id = p.author_user_id AND b.blocked_user_id = ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM discovery_post_dismissal d
            WHERE d.post_id = p.post_id AND d.user_id = ?
         )
       ORDER BY p.post_id DESC LIMIT ?`,
      [user.userId, cursor, cursor, user.userId, user.userId, user.userId, query.limit + 1],
    );
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    ok(response, {
      items: await Promise.all(page.map((row) => serializeDiscoveryPost(storage, row, user.userId))),
      nextCursor: hasMore ? discoveryCursor(page[page.length - 1].post_id) : null,
      hasMore,
    });
  }));

  router.get('/discovery/posts/:postId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const post = await loadVisiblePost(pool, postId, user.userId);
    const [comments] = await pool.execute<CommentRow[]>(
      `SELECT c.*, ru.nickname AS reply_to_name
         FROM discovery_comment c
         LEFT JOIN user_account ru ON ru.user_id = c.reply_to_user_id
        WHERE c.post_id = ? AND c.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM discovery_user_block b
             WHERE (b.blocker_user_id = ? AND b.blocked_user_id = c.user_id)
                OR (b.blocker_user_id = c.user_id AND b.blocked_user_id = ?)
          )
        ORDER BY c.created_at ASC, c.comment_id ASC LIMIT 200`,
      [postId, user.userId, user.userId],
    );
    ok(response, {
      post: await serializeDiscoveryPost(storage, post, user.userId),
      comments: await Promise.all(comments.map((comment) => serializeComment(storage, comment, user.userId))),
    });
  }));

  router.get('/discovery/publish-preview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const query = parseQuery(previewQuery, request);
    const built = await buildSnapshot(pool, user, query);
    ok(response, {
      postType: query.postType,
      snapshot: await publicSnapshot(storage, built.snapshot),
      privacyNotice: query.postType === 'calendar'
        ? '发布后会公开当前月份内全部成员的贴纸记录，无需其他成员再次确认。'
        : '发布后会生成独立公开快照，原记录后续修改不会同步到动态。',
    });
  }));

  router.get('/discovery/recruitment-preview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const query = parseQuery(recruitmentPreviewQuery, request);
    const moduleId = dbId(query.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId, { creator: true });
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT name, description, mode, record_policy FROM life_module WHERE module_id = ? LIMIT 1`, [moduleId],
    );
    const module = rows[0];
    ok(response, {
      moduleId: publicId('m', moduleId),
      moduleName: String(module.name),
      moduleDescription: String(module.description ?? ''),
      mode: String(module.mode),
      recordPolicy: String(module.record_policy),
      memberCount: Number(access.active_member_count),
      memberLimit: Number(access.member_limit),
      openSlots: Math.max(0, Number(access.member_limit) - Number(access.active_member_count)),
      canRecruit: access.module_status === 'active' && Number(access.active_member_count) < Number(access.member_limit),
    });
  }));

  router.post('/discovery/posts', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(publishBody, request);
    const publicText = normalizePublicText(body.publicText);
    await wechat.assertTextAllowed(user.openId, publicText ?? '');
    const built = await buildSnapshot(pool, user, body);
    const snapshotPrefix = `discover/snapshots/${user.userId}/${body.clientRequestId}`;
    const [snapshot, authorAvatarFileKey] = await Promise.all([
      copyDiscoverySnapshot(storage, built.snapshot, snapshotPrefix),
      copyOptionalFile(storage, user.avatarFileKey, `${snapshotPrefix}/author-avatar`),
    ]);
    const result = await idempotent(pool, user.userId, `discovery_publish_${body.postType}`, body.clientRequestId, body, async (connection) => {
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO discovery_post
           (author_user_id, author_name_snapshot, author_avatar_file_key_snapshot,
            post_type, public_text, source_type, source_reference, snapshot_payload,
            status, reviewed_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [user.userId, user.nickname, authorAvatarFileKey, body.postType, publicText,
          built.sourceType, built.sourceReference, JSON.stringify(snapshot)],
      );
      return { postId: publicId('post', insert.insertId), status: 'published' };
    });
    ok(response, result, 201);
  }));

  router.post('/discovery/recruitments', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(recruitmentBody, request);
    const moduleId = dbId(body.moduleId, 'm');
    await wechat.assertTextAllowed(user.openId, body.publicDescription);
    const snapshotPrefix = `discover/snapshots/${user.userId}/${body.clientRequestId}`;
    const authorAvatarFileKey = await copyOptionalFile(storage, user.avatarFileKey, `${snapshotPrefix}/author-avatar`);
    const result = await idempotent(pool, user.userId, 'discovery_recruitment_publish', body.clientRequestId, body, async (connection) => {
      const access = await requireMember(connection, moduleId, user.userId, { creator: true, lock: true });
      if (access.module_status !== 'active') throw new AppError('MODULE_NOT_ACTIVE', '该模块当前不能招募成员', 409);
      if (access.active_member_count >= access.member_limit) throw new AppError('MODULE_MEMBER_LIMIT_REACHED', '模块成员已满', 409);
      const [moduleRows] = await connection.execute<RowDataPacket[]>(
        `SELECT name, description, mode, record_policy FROM life_module WHERE module_id = ? LIMIT 1`,
        [moduleId],
      );
      const module = moduleRows[0];
      await connection.execute(
        `UPDATE discovery_recruitment
            SET status = 'expired', closed_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE module_id = ? AND status = 'recruiting' AND expire_at <= CURRENT_TIMESTAMP(3)`,
        [moduleId],
      );
      const expireAt = addDays(new Date(), body.durationDays);
      const secret = opaqueToken(24);
      const [inviteInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO invite_token
           (module_id, created_by_user_id, created_by_member_instance_id, token_hash, token_prefix, status, expire_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [moduleId, user.userId, access.member_instance_id, sha256(secret), secret.slice(0, 8), expireAt],
      );
      const snapshot = {
        moduleName: String(module.name),
        moduleDescription: String(module.description ?? ''),
        mode: String(module.mode),
        recordPolicy: String(module.record_policy),
        memberCount: Number(access.active_member_count),
        memberLimit: Number(access.member_limit),
        openSlots: Number(access.member_limit) - Number(access.active_member_count),
        publicDescription: body.publicDescription,
        expireAt: isoWithShanghaiOffset(expireAt),
      };
      const [postInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO discovery_post
           (author_user_id, author_name_snapshot, author_avatar_file_key_snapshot,
            post_type, public_text, source_type, source_reference, snapshot_payload,
            status, reviewed_at, published_at)
         VALUES (?, ?, ?, 'module_recruitment', ?, 'module', ?, ?,
                 'published', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [user.userId, user.nickname, authorAvatarFileKey, body.publicDescription,
          `recruitment:${moduleId}:${body.clientRequestId}`, JSON.stringify(snapshot)],
      );
      const [recruitmentInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO discovery_recruitment
           (module_id, post_id, creator_user_id, invite_token_id, public_description,
            member_count_at_publish, member_limit, recruitment_slots, expire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [moduleId, postInsert.insertId, user.userId, inviteInsert.insertId, body.publicDescription,
          access.active_member_count, access.member_limit,
          Number(access.member_limit) - Number(access.active_member_count), expireAt],
      );
      const recruitmentId = publicId('recruit', recruitmentInsert.insertId);
      await connection.execute(
        `UPDATE discovery_post SET snapshot_payload = JSON_SET(snapshot_payload, '$.recruitmentId', ?)
          WHERE post_id = ?`,
        [recruitmentId, postInsert.insertId],
      );
      return { postId: publicId('post', postInsert.insertId), recruitmentId, status: 'recruiting' };
    });
    ok(response, result, 201);
  }));

  router.get('/discovery/recruitments/:recruitmentId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recruitmentId = dbId(request.params.recruitmentId, 'recruit');
    const recruitment = await loadRecruitment(pool, recruitmentId);
    await assertUsersNotBlocked(pool, user.userId, recruitment.creator_user_id);
    ok(response, await serializeRecruitment(storage, recruitment, user.userId));
  }));

  router.post('/discovery/recruitments/:recruitmentId/applications', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recruitmentId = dbId(request.params.recruitmentId, 'recruit');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'discovery_recruitment_apply', body.clientRequestId, body, async (connection) => {
      const recruitment = await loadRecruitment(connection, recruitmentId, true);
      await assertUsersNotBlocked(connection, user.userId, recruitment.creator_user_id);
      if (effectiveRecruitmentStatus(recruitment) !== 'recruiting') {
        throw new AppError('RECRUITMENT_NOT_ACTIVE', '该招募已经结束', 409);
      }
      if (String(recruitment.creator_user_id) === user.userId) throw new AppError('RECRUITMENT_CREATOR_CANNOT_APPLY', '创建者无需申请加入', 409);
      const [memberRows] = await connection.execute<RowDataPacket[]>(
        `SELECT member_instance_id FROM module_member
          WHERE module_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
        [recruitment.module_id, user.userId],
      );
      if (memberRows[0]) return { status: 'already_member', moduleId: publicId('m', recruitment.module_id) };
      const [previousRows] = await connection.execute<RowDataPacket[]>(
        `SELECT application_id, status, reapply_allowed_at FROM join_application
          WHERE module_id = ? AND applicant_user_id = ? ORDER BY application_id DESC LIMIT 1 FOR UPDATE`,
        [recruitment.module_id, user.userId],
      );
      const previous = previousRows[0];
      if (previous?.status === 'pending') throw new AppError('JOIN_APPLICATION_ALREADY_PENDING', '已有待处理的加入申请', 409);
      if (previous?.reapply_allowed_at && new Date(previous.reapply_allowed_at) > new Date()) {
        throw new AppError('JOIN_REAPPLY_COOLDOWN', '暂时不能再次申请', 429);
      }
      const expireAt = addDays(new Date(), 7);
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO join_application
           (module_id, applicant_user_id, invite_token_id, application_source, status,
            applicant_name_snapshot, applicant_avatar_file_key_snapshot, expire_at)
         VALUES (?, ?, ?, 'recruitment', 'pending', ?, ?, ?)`,
        [recruitment.module_id, user.userId, recruitment.invite_token_id,
          user.nickname, user.avatarFileKey, expireAt],
      );
      const applicationId = String(insert.insertId);
      await connection.execute(
        `INSERT INTO notification
           (user_id, type, title, content, module_id, target_type, target_id,
            page_type, action_type, action_status, expired_at, dedupe_key)
         VALUES (?, 'discovery_recruitment_application', '新的加入申请', ?, ?, 'join_application', ?,
                 'module_members', 'approve_join', 'actionable', ?, ?)`,
        [recruitment.creator_user_id, `「${user.nickname}」申请加入 ${recruitment.module_name}`,
          recruitment.module_id, applicationId, expireAt, `join_application:${applicationId}`],
      );
      return {
        applicationId: publicId('ja', applicationId),
        moduleId: publicId('m', recruitment.module_id),
        status: 'pending',
        expireAt: isoWithShanghaiOffset(expireAt),
      };
    });
    ok(response, result, 201);
  }));

  router.put('/discovery/posts/:postId/like', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const body = parseBody(likeBody, request);
    const result = await idempotent(pool, user.userId, `discovery_like_${postId}`, body.clientRequestId, body, async (connection) => {
      const post = await loadVisiblePost(connection, postId, user.userId, true);
      if (body.liked) {
        await connection.execute(
          `INSERT IGNORE INTO discovery_post_like (post_id, user_id) VALUES (?, ?)`,
          [postId, user.userId],
        );
        if (String(post.author_user_id) !== user.userId) {
          await connection.execute(
            `INSERT IGNORE INTO notification
               (user_id, type, title, content, target_type, target_id, page_type,
                action_type, action_status, dedupe_key)
             VALUES (?, 'discovery_like', '有人赞了你的记录', ?, 'discovery_post', ?,
                     'discover_post', 'none', 'none', ?)`,
            [post.author_user_id, `「${user.nickname}」赞了你的公开记录`, postId,
              `discovery_like:${postId}:${user.userId}`],
          );
        }
      } else {
        await connection.execute(`DELETE FROM discovery_post_like WHERE post_id = ? AND user_id = ?`, [postId, user.userId]);
        await connection.execute(
          `DELETE FROM notification WHERE user_id = ? AND dedupe_key = ?`,
          [post.author_user_id, `discovery_like:${postId}:${user.userId}`],
        );
      }
      const [countRows] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM discovery_post_like WHERE post_id = ?`, [postId],
      );
      const likeCount = Number(countRows[0].total);
      await connection.execute(`UPDATE discovery_post SET like_count = ? WHERE post_id = ?`, [likeCount, postId]);
      return { postId: publicId('post', postId), liked: body.liked, likeCount };
    });
    ok(response, result);
  }));

  router.post('/discovery/posts/:postId/comments', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const body = parseBody(commentBody, request);
    await wechat.assertTextAllowed(user.openId, body.content);
    const parentId = body.parentCommentId ? dbId(body.parentCommentId, 'comment') : null;
    const result = await idempotent(pool, user.userId, `discovery_comment_${postId}`, body.clientRequestId, body, async (connection) => {
      const post = await loadVisiblePost(connection, postId, user.userId, true);
      let parent: CommentRow | undefined;
      if (parentId) {
        const [parentRows] = await connection.execute<CommentRow[]>(
          `SELECT * FROM discovery_comment WHERE comment_id = ? AND post_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
          [parentId, postId],
        );
        parent = parentRows[0];
        if (!parent) throw new AppError('COMMENT_NOT_FOUND', '回复的评论不存在', 404);
        if (parent.parent_comment_id) throw new AppError('COMMENT_REPLY_DEPTH_LIMIT', '评论仅支持一层回复', 422);
      }
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO discovery_comment
           (post_id, user_id, parent_comment_id, reply_to_user_id,
            author_name_snapshot, author_avatar_file_key_snapshot, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [postId, user.userId, parentId, parent?.user_id ?? null,
          user.nickname, user.avatarFileKey, body.content],
      );
      const commentId = String(insert.insertId);
      const [countRows] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM discovery_comment WHERE post_id = ? AND status = 'active'`, [postId],
      );
      const commentCount = Number(countRows[0].total);
      await connection.execute(`UPDATE discovery_post SET comment_count = ? WHERE post_id = ?`, [commentCount, postId]);
      const recipientId = parent?.user_id ?? post.author_user_id;
      if (String(recipientId) !== user.userId) {
        await connection.execute(
          `INSERT IGNORE INTO notification
             (user_id, type, title, content, target_type, target_id, page_type,
              action_type, action_status, dedupe_key)
           VALUES (?, ?, ?, ?, 'discovery_post', ?, 'discover_post', 'none', 'none', ?)`,
          [recipientId, parent ? 'discovery_reply' : 'discovery_comment',
            parent ? '有人回复了你' : '有人评论了你的记录', body.content, postId,
            `discovery_comment:${commentId}`],
        );
      }
      return { commentId: publicId('comment', commentId), commentCount };
    });
    ok(response, result, 201);
  }));

  router.delete('/discovery/comments/:commentId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const commentId = dbId(request.params.commentId, 'comment');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, `discovery_comment_delete_${commentId}`, body.clientRequestId, body, async (connection) => {
      const [rows] = await connection.execute<CommentRow[]>(
        `SELECT * FROM discovery_comment WHERE comment_id = ? LIMIT 1 FOR UPDATE`, [commentId],
      );
      const comment = rows[0];
      if (!comment) throw new AppError('COMMENT_NOT_FOUND', '评论不存在', 404);
      if (String(comment.user_id) !== user.userId) throw new AppError('NO_COMMENT_PERMISSION', '只能删除自己的评论', 403);
      await connection.execute(
        `UPDATE discovery_comment SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP(3)
          WHERE comment_id = ? AND status = 'active'`, [commentId],
      );
      const [countRows] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM discovery_comment WHERE post_id = ? AND status = 'active'`, [comment.post_id],
      );
      const commentCount = Number(countRows[0].total);
      await connection.execute(`UPDATE discovery_post SET comment_count = ? WHERE post_id = ?`, [commentCount, comment.post_id]);
      return { commentId: publicId('comment', commentId), status: 'deleted', commentCount };
    });
    ok(response, result);
  }));

  router.delete('/discovery/posts/:postId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, `discovery_post_delete_${postId}`, body.clientRequestId, body, async (connection) => {
      const [rows] = await connection.execute<DiscoveryPostRow[]>(
        `SELECT p.*, 0 AS liked_by_viewer FROM discovery_post p WHERE p.post_id = ? LIMIT 1 FOR UPDATE`, [postId],
      );
      const post = rows[0];
      if (!post) throw new AppError('DISCOVERY_POST_NOT_FOUND', '动态不存在', 404);
      if (String(post.author_user_id) !== user.userId) throw new AppError('NO_DISCOVERY_POST_PERMISSION', '只能删除自己的动态', 403);
      await connection.execute(
        `UPDATE discovery_post SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE post_id = ? AND status <> 'deleted'`, [postId],
      );
      await connection.execute(
        `UPDATE discovery_recruitment SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE post_id = ? AND status = 'recruiting'`, [postId],
      );
      return { postId: publicId('post', postId), status: 'deleted' };
    });
    ok(response, result);
  }));

  router.post('/discovery/posts/:postId/report', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const body = parseBody(reportBody, request);
    await wechat.assertTextAllowed(user.openId, body.detail);
    const result = await idempotent(pool, user.userId, `discovery_report_${postId}`, body.clientRequestId, body, async (connection) => {
      await loadVisiblePost(connection, postId, user.userId, true);
      await connection.execute(
        `INSERT INTO discovery_report (reporter_user_id, target_type, target_id, reason, detail)
         VALUES (?, 'post', ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), detail = VALUES(detail), status = 'pending'`,
        [user.userId, postId, body.reason, body.detail || null],
      );
      return { postId: publicId('post', postId), reported: true };
    });
    ok(response, result, 201);
  }));

  router.post('/discovery/users/:userId/block', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const targetUserId = dbId(request.params.userId, 'u');
    const body = parseBody(simpleWriteBody, request);
    if (targetUserId === user.userId) throw new AppError('CANNOT_BLOCK_SELF', '不能屏蔽自己', 422);
    const result = await idempotent(pool, user.userId, `discovery_block_${targetUserId}`, body.clientRequestId, body, async (connection) => {
      const [targetRows] = await connection.execute<RowDataPacket[]>(
        `SELECT user_id FROM user_account WHERE user_id = ? AND status <> 'deleted' LIMIT 1`, [targetUserId],
      );
      if (!targetRows[0]) throw new AppError('USER_NOT_FOUND', '用户不存在', 404);
      await connection.execute(
        `INSERT IGNORE INTO discovery_user_block (blocker_user_id, blocked_user_id) VALUES (?, ?)`,
        [user.userId, targetUserId],
      );
      return { userId: publicId('u', targetUserId), blocked: true };
    });
    ok(response, result);
  }));

  router.post('/discovery/posts/:postId/dismiss', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const postId = dbId(request.params.postId, 'post');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, `discovery_dismiss_${postId}`, body.clientRequestId, body, async (connection) => {
      await loadVisiblePost(connection, postId, user.userId, true);
      await connection.execute(
        `INSERT IGNORE INTO discovery_post_dismissal (post_id, user_id) VALUES (?, ?)`, [postId, user.userId],
      );
      return { postId: publicId('post', postId), dismissed: true };
    });
    ok(response, result);
  }));

  router.post('/discovery/recruitments/:recruitmentId/close', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const recruitmentId = dbId(request.params.recruitmentId, 'recruit');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, `discovery_recruitment_close_${recruitmentId}`, body.clientRequestId, body, async (connection) => {
      const recruitment = await loadRecruitment(connection, recruitmentId, true);
      if (String(recruitment.creator_user_id) !== user.userId) throw new AppError('NO_RECRUITMENT_PERMISSION', '只有创建者可以结束招募', 403);
      await connection.execute(
        `UPDATE discovery_recruitment SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE recruitment_id = ? AND status = 'recruiting'`, [recruitmentId],
      );
      await connection.execute(`UPDATE invite_token SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3) WHERE invite_token_id = ? AND status = 'active'`, [recruitment.invite_token_id]);
      return { recruitmentId: publicId('recruit', recruitmentId), status: 'closed' };
    });
    ok(response, result);
  }));

  return router;
}

function postSelectSql(): string {
  return `SELECT p.*,
                 EXISTS(SELECT 1 FROM discovery_post_like l WHERE l.post_id = p.post_id AND l.user_id = ?) AS liked_by_viewer,
                 dr.status AS recruitment_status, dr.recruitment_slots,
                 dr.expire_at AS recruitment_expire_at
            FROM discovery_post p
            LEFT JOIN discovery_recruitment dr ON dr.post_id = p.post_id`;
}

async function loadVisiblePost(
  database: Queryable,
  postId: string,
  userId: string,
  lock = false,
): Promise<DiscoveryPostRow> {
  const [rows] = await database.execute<DiscoveryPostRow[]>(
    `${postSelectSql()}
      WHERE p.post_id = ? AND p.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM discovery_user_block b
           WHERE (b.blocker_user_id = ? AND b.blocked_user_id = p.author_user_id)
              OR (b.blocker_user_id = p.author_user_id AND b.blocked_user_id = ?)
        ) LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [userId, postId, userId, userId],
  );
  if (!rows[0]) throw new AppError('DISCOVERY_POST_NOT_FOUND', '动态不存在或已不可见', 404);
  return rows[0];
}

async function serializeComment(storage: StorageService, row: CommentRow, viewerUserId: string) {
  return {
    commentId: publicId('comment', row.comment_id),
    postId: publicId('post', row.post_id),
    parentCommentId: row.parent_comment_id ? publicId('comment', row.parent_comment_id) : null,
    author: {
      userId: publicId('u', row.user_id),
      name: row.author_name_snapshot,
      avatarUrl: row.author_avatar_file_key_snapshot
        ? await storage.signedUrl(row.author_avatar_file_key_snapshot)
        : null,
      isCurrentUser: String(row.user_id) === viewerUserId,
    },
    replyToName: row.reply_to_name,
    content: row.content,
    createdAt: isoWithShanghaiOffset(row.created_at),
  };
}

async function buildSnapshot(
  database: Queryable,
  user: AuthenticatedUser,
  input: {
    postType: 'record' | 'calendar' | 'board' | 'easter_egg';
    sourceId: string;
    moduleId?: string;
    month?: string;
    stage?: 'unlocked' | 'redeemed';
  },
): Promise<SnapshotBuildResult> {
  if (input.postType === 'record') return buildRecordSnapshot(database, user.userId, input.sourceId);
  if (input.postType === 'calendar') {
    if (!input.moduleId || !input.month) throw new AppError('VALIDATION_ERROR', '日历发布缺少模块或月份', 422);
    return buildCalendarSnapshot(database, user.userId, input.moduleId, input.month);
  }
  if (input.postType === 'board') return buildBoardSnapshot(database, user.userId, input.sourceId);
  return buildEggSnapshot(database, user.userId, input.sourceId, input.stage ?? 'unlocked');
}

async function buildRecordSnapshot(database: Queryable, userId: string, sourceId: string): Promise<SnapshotBuildResult> {
  const recordId = dbId(sourceId, 'r');
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT r.record_id, r.record_date, r.media_variant, m.name AS module_name,
            CASE WHEN r.media_variant = 'original'
              THEN COALESCE(NULLIF(ma.thumbnail_file_key, ma.sticker_thumbnail_file_key), ma.original_file_key)
              ELSE ma.sticker_thumbnail_file_key END AS sticker_file_key
       FROM life_record r
       JOIN life_module m ON m.module_id = r.module_id
       JOIN media_asset ma ON ma.media_id = r.media_id
      WHERE r.record_id = ? AND r.user_id = ? AND r.status IN ('active', 'locked')
        AND ma.status = 'ready' AND ma.content_check_status = 'passed' LIMIT 1`,
    [recordId, userId],
  );
  const record = rows[0];
  if (!record?.sticker_file_key) throw new AppError('DISCOVERY_RECORD_NOT_PUBLISHABLE', '该记录暂时不能公开发布', 422);
  return {
    sourceType: 'record',
    sourceReference: `record:${recordId}`,
    snapshot: {
      recordDate: sqlDate(record.record_date),
      moduleName: String(record.module_name),
      mediaVariant: String(record.media_variant),
      stickerFileKey: String(record.sticker_file_key),
    },
  };
}

async function buildCalendarSnapshot(
  database: Queryable,
  userId: string,
  modulePublicId: string,
  month: string,
): Promise<SnapshotBuildResult> {
  const moduleId = dbId(modulePublicId, 'm');
  const range = monthRange(month);
  await requireMember(database, moduleId, userId);
  const [[moduleRows], [memberRows], [recordRows]] = await Promise.all([
    database.execute<RowDataPacket[]>(
      `SELECT name FROM life_module WHERE module_id = ? AND status = 'active' LIMIT 1`, [moduleId],
    ),
    database.execute<RowDataPacket[]>(
      `SELECT member_instance_id, join_sequence, nickname_snapshot, avatar_file_key_snapshot
         FROM module_member WHERE module_id = ? AND status = 'active' ORDER BY join_sequence`, [moduleId],
    ),
    database.execute<RowDataPacket[]>(
      `SELECT r.record_date, r.member_instance_id, r.display_name_snapshot,
              CASE WHEN r.media_variant = 'original'
                THEN COALESCE(NULLIF(ma.thumbnail_file_key, ma.sticker_thumbnail_file_key), ma.original_file_key)
                ELSE ma.sticker_thumbnail_file_key END AS sticker_file_key
         FROM life_record r
         JOIN media_asset ma ON ma.media_id = r.media_id
        WHERE r.module_id = ? AND r.record_date >= ? AND r.record_date < ?
          AND r.status IN ('active', 'locked') AND ma.status = 'ready'
          AND ma.content_check_status = 'passed'
        ORDER BY r.record_date, r.first_effective_at, r.record_id`,
      [moduleId, range.start, range.endExclusive],
    ),
  ]);
  if (!moduleRows[0]) throw new AppError('MODULE_NOT_ACTIVE', '该模块当前不能分享', 409);
  return {
    sourceType: 'calendar',
    sourceReference: `calendar:${moduleId}:${month}`,
    snapshot: {
      month,
      moduleName: String(moduleRows[0].name),
      members: memberRows.map((member) => ({
        memberKey: `member_${member.member_instance_id}`,
        name: String(member.nickname_snapshot),
        joinSequence: Number(member.join_sequence),
        avatarFileKey: member.avatar_file_key_snapshot ? String(member.avatar_file_key_snapshot) : null,
      })),
      records: recordRows.filter((record) => record.sticker_file_key).map((record) => ({
        recordDate: sqlDate(record.record_date),
        memberKey: `member_${record.member_instance_id}`,
        memberName: String(record.display_name_snapshot),
        stickerFileKey: String(record.sticker_file_key),
      })),
    },
  };
}

async function buildBoardSnapshot(database: Queryable, userId: string, sourceId: string): Promise<SnapshotBuildResult> {
  const collageId = dbId(sourceId, 'collage');
  const [collageRows] = await database.execute<RowDataPacket[]>(
    `SELECT c.collage_id, c.report_mode, c.period_key, b.name AS board_name,
            b.original_file_key AS board_file_key
       FROM memory_collage c
       LEFT JOIN memory_collage_board_asset b ON b.board_asset_id = c.board_asset_id
      WHERE c.collage_id = ? AND c.user_id = ? AND c.status = 'active' LIMIT 1`,
    [collageId, userId],
  );
  const collage = collageRows[0];
  if (!collage) throw new AppError('DISCOVERY_BOARD_NOT_FOUND', '拼贴画不存在', 404);
  const [items] = await database.execute<RowDataPacket[]>(
    `SELECT i.asset_type, i.position_x, i.position_y, i.width_ratio, i.height_ratio,
            i.rotation_degrees, i.z_index,
            r.user_id AS record_owner_user_id,
            CASE WHEN r.media_variant = 'original'
              THEN COALESCE(NULLIF(ma.thumbnail_file_key, ma.sticker_thumbnail_file_key), ma.original_file_key)
              ELSE ma.sticker_thumbnail_file_key END AS record_file_key,
            ma.content_check_status,
            s.name AS sticker_name, s.original_file_key AS decorative_file_key
       FROM memory_collage_item i
       LEFT JOIN life_record r ON r.record_id = i.record_id AND r.status IN ('active', 'locked')
       LEFT JOIN media_asset ma ON ma.media_id = r.media_id AND ma.status = 'ready'
       LEFT JOIN memory_collage_sticker_asset s ON s.sticker_asset_id = i.sticker_asset_id AND s.status = 'active'
      WHERE i.collage_id = ? ORDER BY i.z_index`,
    [collageId],
  );
  if (!items.length) throw new AppError('DISCOVERY_BOARD_EMPTY', '拼贴画中还没有可公开的贴纸', 422);
  for (const item of items) {
    if (item.asset_type === 'record_sticker'
      && (String(item.record_owner_user_id) !== userId || !item.record_file_key || item.content_check_status !== 'passed')) {
      throw new AppError('DISCOVERY_BOARD_CONTAINS_PRIVATE_RECORD', '拼贴画只能发布你自己的已审核记录', 422);
    }
    if (item.asset_type === 'decorative_sticker' && !item.decorative_file_key) {
      throw new AppError('DISCOVERY_BOARD_ASSET_UNAVAILABLE', '拼贴画中的装饰贴纸已不可用', 422);
    }
  }
  return {
    sourceType: 'board',
    sourceReference: `board:${collageId}`,
    snapshot: {
      reportMode: String(collage.report_mode),
      periodKey: String(collage.period_key),
      boardName: String(collage.board_name ?? ''),
      boardFileKey: collage.board_file_key ? String(collage.board_file_key) : null,
      items: items.map((item) => ({
        assetType: String(item.asset_type),
        name: String(item.sticker_name ?? ''),
        imageFileKey: String(item.record_file_key ?? item.decorative_file_key),
        x: Number(item.position_x),
        y: Number(item.position_y),
        width: Number(item.width_ratio),
        height: Number(item.height_ratio),
        rotation: Number(item.rotation_degrees),
        zIndex: Number(item.z_index),
      })),
    },
  };
}

async function buildEggSnapshot(
  database: Queryable,
  userId: string,
  sourceId: string,
  stage: 'unlocked' | 'redeemed',
): Promise<SnapshotBuildResult> {
  const drawId = dbId(sourceId, 'rd');
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT d.reward_draw_id, d.result_type, d.revealed_at, d.redeemed_at,
            e.sponsor_name_snapshot, e.prize_title_snapshot, e.prize_description_snapshot,
            rr.streak_days, ma.sticker_thumbnail_file_key AS sticker_file_key,
            cm.sticker_thumbnail_file_key AS cover_file_key
       FROM streak_reward_draw d
       JOIN streak_reward_event e ON e.reward_event_id = d.reward_event_id
       JOIN streak_reward_rule rr ON rr.reward_rule_id = e.reward_rule_id
       LEFT JOIN life_record sr ON sr.record_id = d.sticker_record_id
       LEFT JOIN media_asset ma ON ma.media_id = sr.media_id AND ma.content_check_status = 'passed'
       LEFT JOIN media_asset cm ON cm.media_id = e.cover_media_id_snapshot AND cm.content_check_status = 'passed'
      WHERE d.reward_draw_id = ? AND d.recipient_user_id = ? AND d.status = 'revealed' LIMIT 1`,
    [drawId, userId],
  );
  const draw = rows[0];
  if (!draw) throw new AppError('DISCOVERY_EGG_NOT_FOUND', '这份彩蛋还不能公开', 404);
  if (stage === 'redeemed' && !draw.redeemed_at) throw new AppError('DISCOVERY_EGG_NOT_REDEEMED', '请先确认已经兑换', 409);
  return {
    sourceType: 'easter_egg',
    sourceReference: `easter_egg:${drawId}:${stage}`,
    snapshot: {
      stage,
      resultType: String(draw.result_type),
      sponsorName: String(draw.sponsor_name_snapshot),
      streakDays: Number(draw.streak_days),
      title: draw.result_type === 'gift' ? String(draw.prize_title_snapshot) : `${draw.streak_days}日纪念贴`,
      rewardText: '',
      stickerFileKey: draw.result_type === 'sticker' && draw.sticker_file_key ? String(draw.sticker_file_key) : null,
      coverFileKey: draw.result_type === 'gift' && draw.cover_file_key ? String(draw.cover_file_key) : null,
      unlockedAt: isoWithShanghaiOffset(draw.revealed_at),
      redeemedAt: draw.redeemed_at ? isoWithShanghaiOffset(draw.redeemed_at) : null,
    },
  };
}

async function loadRecruitment(database: Queryable, recruitmentId: string, lock = false): Promise<RecruitmentRow> {
  const [rows] = await database.execute<RecruitmentRow[]>(
    `SELECT r.*, m.name AS module_name, m.description AS module_description,
            m.status AS module_status, m.mode AS module_mode, m.record_policy,
            m.active_member_count, u.nickname AS creator_name,
            u.avatar_file_key AS creator_avatar_file_key
       FROM discovery_recruitment r
       JOIN life_module m ON m.module_id = r.module_id
       JOIN user_account u ON u.user_id = r.creator_user_id
      WHERE r.recruitment_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [recruitmentId],
  );
  if (!rows[0]) throw new AppError('RECRUITMENT_NOT_FOUND', '招募不存在', 404);
  return rows[0];
}

async function serializeRecruitment(storage: StorageService, row: RecruitmentRow, viewerUserId: string) {
  const status = effectiveRecruitmentStatus(row);
  return {
    recruitmentId: publicId('recruit', row.recruitment_id),
    postId: publicId('post', row.post_id),
    moduleName: row.module_name,
    moduleDescription: row.module_description ?? '',
    mode: row.module_mode,
    recordPolicy: row.record_policy,
    publicDescription: row.public_description,
    memberCount: Number(row.active_member_count),
    memberLimit: Number(row.member_limit),
    openSlots: Math.max(0, Number(row.member_limit) - Number(row.active_member_count)),
    status,
    expireAt: isoWithShanghaiOffset(row.expire_at),
    creator: {
      userId: publicId('u', row.creator_user_id),
      name: row.creator_name,
      avatarUrl: row.creator_avatar_file_key ? await storage.signedUrl(row.creator_avatar_file_key) : null,
      isCurrentUser: String(row.creator_user_id) === viewerUserId,
    },
    canApply: status === 'recruiting' && String(row.creator_user_id) !== viewerUserId,
  };
}

async function assertUsersNotBlocked(database: Queryable, firstUserId: string, secondUserId: string): Promise<void> {
  const [rows] = await database.execute<RowDataPacket[]>(
    `SELECT block_id FROM discovery_user_block
      WHERE (blocker_user_id = ? AND blocked_user_id = ?)
         OR (blocker_user_id = ? AND blocked_user_id = ?) LIMIT 1`,
    [firstUserId, secondUserId, secondUserId, firstUserId],
  );
  if (rows[0]) throw new AppError('DISCOVERY_USER_UNAVAILABLE', '该用户在发现页不可见', 404);
}

async function copyOptionalFile(
  storage: StorageService,
  sourceKey: string | null,
  destinationBase: string,
): Promise<string | null> {
  if (!sourceKey) return null;
  const extensionMatch = /\.[a-zA-Z0-9]{2,5}$/.exec(sourceKey);
  const destinationKey = `${destinationBase}${extensionMatch?.[0].toLowerCase() ?? ''}`;
  await storage.copyObject(sourceKey, destinationKey);
  return destinationKey;
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  try {
    return parsePublicId(String(value ?? ''), prefix);
  } catch {
    throw new AppError('VALIDATION_ERROR', '资源编号格式不正确', 422);
  }
}
