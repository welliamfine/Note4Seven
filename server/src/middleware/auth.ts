import type { NextFunction, Request, Response } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';
import { sha256 } from '../lib/ids';

export interface AuthenticatedUser {
  userId: string;
  openId: string;
  nickname: string;
  avatarFileKey: string | null;
  status: string;
  sessionId: string;
}

interface AuthRow extends RowDataPacket {
  session_id: string;
  user_id: string;
  open_id: string;
  nickname: string;
  avatar_file_key: string | null;
  status: string;
}

export function requireAuth(pool: Pool) {
  return authenticate(pool, true);
}

export function optionalAuth(pool: Pool) {
  return authenticate(pool, false);
}

function authenticate(pool: Pool, required: boolean) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = request.header('authorization');
      const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
      if (!match) {
        if (required) throw new AppError('UNAUTHORIZED', '登录状态已失效', 401);
        next();
        return;
      }

      const [rows] = await pool.execute<AuthRow[]>(
        `SELECT s.session_id, u.user_id, u.open_id, u.nickname, u.avatar_file_key, u.status
           FROM auth_session s
           JOIN user_account u ON u.user_id = s.user_id
          WHERE s.token_hash = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > CURRENT_TIMESTAMP(3)
            AND u.status IN ('active', 'deletion_pending')
          LIMIT 1`,
        [sha256(match[1])],
      );
      const row = rows[0];
      if (!row) {
        if (required) throw new AppError('UNAUTHORIZED', '登录状态已失效', 401);
        next();
        return;
      }

      request.auth = {
        userId: String(row.user_id),
        openId: row.open_id,
        nickname: row.nickname,
        avatarFileKey: row.avatar_file_key,
        status: row.status,
        sessionId: String(row.session_id),
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function authUser(request: Request): AuthenticatedUser {
  if (!request.auth) throw new AppError('UNAUTHORIZED', '登录状态已失效', 401);
  return request.auth;
}
