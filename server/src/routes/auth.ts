import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket, Pool, PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { AppError } from '../lib/errors';
import { opaqueToken, publicId, sha256 } from '../lib/ids';
import { addHours, isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { idempotent } from '../services/idempotency';
import type { StorageService } from '../services/storage';
import type { WechatService } from '../services/wechat';

const loginBody = z.object({
  wxCode: z.string().max(256).optional(),
  clientRequestId: z.string().min(8).max(64),
});

const profileBody = z.object({
  nickname: z.string().trim().min(1).max(20),
  avatarMediaId: z.string().optional(),
  clientRequestId: z.string().min(8).max(64),
});

interface UserRow extends RowDataPacket {
  user_id: string;
  nickname: string;
  avatar_file_key: string | null;
}

export function authRoutes(pool: Pool, config: AppConfig, storage: StorageService, wechat: WechatService): Router {
  const router = Router();

  router.post('/auth/wechat/login', asyncRoute(async (request, response) => {
    parseBody(loginBody, request);
    const openId = trustedOpenId(request.headers, config);
    const unionId = headerValue(request.headers['x-wx-unionid']);

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO user_account (open_id, union_id, nickname, last_login_at)
       VALUES (?, ?, '微信用户', UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         union_id = COALESCE(VALUES(union_id), union_id),
         last_login_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3)`,
      [openId, unionId],
    );
    const [users] = await pool.execute<UserRow[]>(
      'SELECT user_id, nickname, avatar_file_key FROM user_account WHERE open_id = ? LIMIT 1',
      [openId],
    );
    const user = users[0];
    if (!user) throw new AppError('LOGIN_FAILED', '微信登录失败', 500);

    const token = opaqueToken();
    const expiresAt = addHours(new Date(), config.sessionTtlSeconds / 3600);
    await pool.execute(
      'INSERT INTO auth_session (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.user_id, sha256(token), expiresAt],
    );

    ok(response, {
      accessToken: token,
      expiresIn: config.sessionTtlSeconds,
      isNewUser: result.affectedRows === 1,
      user: {
        userId: publicId('u', user.user_id),
        nickname: user.nickname,
        avatarUrl: user.avatar_file_key ? await storage.signedUrl(user.avatar_file_key) : null,
      },
    });
  }));

  router.post('/auth/logout', asyncRoute(async (request, response) => {
    const user = authUser(request);
    await pool.execute('UPDATE auth_session SET revoked_at = UTC_TIMESTAMP(3) WHERE session_id = ?', [user.sessionId]);
    ok(response, {});
  }));

  router.get('/users/me', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const [[stats]] = await pool.query<RowDataPacket[]>(
      `SELECT
         COUNT(DISTINCT CASE WHEN r.status IN ('active', 'locked') AND r.record_date <= ? THEN r.record_date END) AS recorded_days,
         COUNT(DISTINCT CASE WHEN mm.status = 'active' AND m.status = 'active' THEN mm.module_id END) AS active_module_count,
         (SELECT COUNT(*) FROM notification n
           WHERE n.user_id = ? AND n.is_read = 0 AND n.action_status <> 'resolved') AS unread_count
       FROM user_account u
       LEFT JOIN life_record r ON r.user_id = u.user_id
       LEFT JOIN module_member mm ON mm.user_id = u.user_id
       LEFT JOIN life_module m ON m.module_id = mm.module_id
       WHERE u.user_id = ?`,
      [shanghaiDate(), user.userId, user.userId],
    );
    ok(response, {
      userId: publicId('u', user.userId),
      nickname: user.nickname,
      avatarUrl: user.avatarFileKey ? await storage.signedUrl(user.avatarFileKey) : null,
      recordedDays: Number(stats.recorded_days ?? 0),
      activeModuleCount: Number(stats.active_module_count ?? 0),
      unreadNotificationCount: Number(stats.unread_count ?? 0),
      accountStatus: user.status,
    });
  }));

  router.patch('/users/me', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(profileBody, request);
    await wechat.assertTextAllowed(user.openId, body.nickname);
    const result = await idempotent(pool, user.userId, 'update_profile', body.clientRequestId, body, async (connection) => {
      let avatarFileKey: string | null = user.avatarFileKey;
      if (body.avatarMediaId) {
        const mediaId = numericPublicId(body.avatarMediaId, 'media');
        const [media] = await connection.execute<RowDataPacket[]>(
          `SELECT sticker_file_key FROM media_asset
            WHERE media_id = ? AND owner_user_id = ? AND status = 'ready' LIMIT 1`,
          [mediaId, user.userId],
        );
        if (!media[0]) throw new AppError('MEDIA_NOT_READY', '头像图片尚未处理完成', 409);
        avatarFileKey = media[0].sticker_file_key as string;
      }
      await connection.execute(
        `UPDATE user_account SET nickname = ?, avatar_file_key = ?, version = version + 1 WHERE user_id = ?`,
        [body.nickname, avatarFileKey, user.userId],
      );
      await syncProfileReferences(connection, user.userId, body.nickname, avatarFileKey);
      return {
        userId: publicId('u', user.userId),
        nickname: body.nickname,
        avatarUrl: avatarFileKey ? await storage.signedUrl(avatarFileKey) : null,
      };
    });
    ok(response, result);
  }));

  return router;
}

export async function syncProfileReferences(
  connection: Pick<PoolConnection, 'execute'>,
  userId: string,
  nickname: string,
  avatarFileKey: string | null,
): Promise<void> {
  await connection.execute(
    `UPDATE module_member
        SET nickname_snapshot = ?, avatar_file_key_snapshot = ?, version = version + 1
      WHERE user_id = ? AND status = 'active'`,
    [nickname, avatarFileKey, userId],
  );
  await connection.execute(
    `UPDATE life_record r
       JOIN module_member mm ON mm.member_instance_id = r.member_instance_id
        SET r.display_name_snapshot = ?, r.avatar_file_key_snapshot = ?
      WHERE r.user_id = ? AND mm.status = 'active'`,
    [nickname, avatarFileKey, userId],
  );
  await connection.execute(
    `UPDATE reaction re
       JOIN module_member mm ON mm.member_instance_id = re.reactor_member_instance_id
        SET re.reactor_name_snapshot = ?, re.reactor_avatar_file_key_snapshot = ?
      WHERE re.reactor_user_id = ? AND mm.status = 'active'`,
    [nickname, avatarFileKey, userId],
  );
  await connection.execute(
    `UPDATE join_application
        SET applicant_name_snapshot = ?, applicant_avatar_file_key_snapshot = ?
      WHERE applicant_user_id = ?`,
    [nickname, avatarFileKey, userId],
  );
}

export function trustedOpenId(headers: Record<string, string | string[] | undefined>, config: AppConfig): string {
  const cloudOpenId = headerValue(headers['x-wx-openid']);
  const authMethod = headerValue(headers['x-authmethod']);
  const requestAppId = headerValue(headers['x-wx-appid']);
  const requestEnvironment = headerValue(headers['x-wx-env']);
  if (
    cloudOpenId
    && requestAppId === config.appId
    && requestEnvironment === config.cloudEnvId
    && authMethod?.toUpperCase() === 'WX_SERVER_AUTH'
  ) return cloudOpenId;

  const devOpenId = headerValue(headers['x-dev-openid']);
  if (config.allowDevAuth && config.nodeEnv !== 'production' && devOpenId) return devOpenId;
  throw new AppError('WECHAT_IDENTITY_REQUIRED', '请从微信小程序进入', 401);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function numericPublicId(value: string, prefix: string): string {
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(value);
  if (!match) throw new AppError('VALIDATION_ERROR', `${prefix} ID 不正确`, 422);
  return match[1];
}
