import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';

export interface MemberAccess extends RowDataPacket {
  module_id: string;
  module_status: string;
  module_mode: 'solo' | 'group';
  creator_user_id: string;
  active_member_count: number;
  member_limit: number;
  next_join_sequence: number;
  member_instance_id: string;
  user_id: string;
  role: 'creator' | 'member';
  join_sequence: number;
  nickname_snapshot: string;
  avatar_file_key_snapshot: string | null;
}

type Queryable = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

export async function requireMember(
  database: Queryable,
  moduleId: string,
  userId: string,
  options: { creator?: boolean; allowPendingDelete?: boolean; lock?: boolean } = {},
): Promise<MemberAccess> {
  const lock = options.lock ? ' FOR UPDATE' : '';
  const [rows] = await database.execute<MemberAccess[]>(
    `SELECT m.module_id, m.status AS module_status, m.mode AS module_mode,
            m.creator_user_id, m.active_member_count, m.member_limit, m.next_join_sequence,
            mm.member_instance_id, mm.user_id, mm.role, mm.join_sequence,
            mm.nickname_snapshot, mm.avatar_file_key_snapshot
       FROM life_module m
       JOIN module_member mm ON mm.module_id = m.module_id
      WHERE m.module_id = ? AND mm.user_id = ? AND mm.status = 'active'
      LIMIT 1${lock}`,
    [moduleId, userId],
  );
  const member = rows[0];
  if (!member) throw new AppError('NO_MODULE_PERMISSION', '无权访问该模块', 403);
  if (member.module_status === 'deleted') throw new AppError('MODULE_DELETED', '模块已永久删除', 410);
  if (member.module_status === 'pending_delete' && !options.allowPendingDelete) {
    throw new AppError('MODULE_PENDING_DELETE', '模块正在回收期', 409);
  }
  if (options.creator && member.role !== 'creator') {
    throw new AppError('NO_MODULE_PERMISSION', '只有创建者可以执行此操作', 403);
  }
  return member;
}
