import type { RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';
import { isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import type { StorageService } from './storage';

export const discoveryPostTypes = [
  'record',
  'calendar',
  'board',
  'easter_egg',
  'module_recruitment',
] as const;

export type DiscoveryPostType = (typeof discoveryPostTypes)[number];

export interface DiscoveryPostRow extends RowDataPacket {
  post_id: string;
  author_user_id: string;
  author_name_snapshot: string;
  author_avatar_file_key_snapshot: string | null;
  post_type: DiscoveryPostType;
  public_text: string | null;
  snapshot_payload: string | Record<string, unknown>;
  status: string;
  like_count: number;
  comment_count: number;
  published_at: Date;
  liked_by_viewer: number;
  recruitment_status: string | null;
  recruitment_slots: number | null;
  recruitment_expire_at: Date | null;
}

export function parseDiscoveryCursor(cursor?: string): string | null {
  if (!cursor) return null;
  const match = /^dp_(\d+)$/.exec(cursor);
  if (!match) throw new AppError('VALIDATION_ERROR', '分页游标格式不正确', 422);
  return match[1];
}

export function discoveryCursor(postId: string | number): string {
  return `dp_${postId}`;
}

export function normalizePublicText(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().replace(/\r\n/g, '\n');
  return normalized || null;
}

export function assertMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', '月份格式不正确', 422);
  }
}

export function monthRange(month: string): { start: string; endExclusive: string } {
  assertMonth(month);
  const [year, monthNumber] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return { start: `${month}-01`, endExclusive: next.toISOString().slice(0, 10) };
}

export function sqlDate(value: Date | string): string {
  return value instanceof Date ? shanghaiDate(value) : String(value).slice(0, 10);
}

export function parseSnapshot(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new AppError('DISCOVERY_SNAPSHOT_INVALID', '公开快照暂时无法读取', 500);
  }
}

export async function publicSnapshot(
  storage: StorageService,
  value: string | Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return resolveFileKeys(storage, parseSnapshot(value)) as Promise<Record<string, unknown>>;
}

export async function copyDiscoverySnapshot(
  storage: StorageService,
  snapshot: Record<string, unknown>,
  prefix: string,
): Promise<Record<string, unknown>> {
  const sourceKeys = [...collectFileKeys(snapshot)];
  const copiedEntries = await Promise.all(sourceKeys.map(async (sourceKey, index) => {
    const extensionMatch = /\.[a-zA-Z0-9]{2,5}$/.exec(sourceKey);
    const destinationKey = `${prefix}/asset-${String(index + 1).padStart(3, '0')}${extensionMatch?.[0].toLowerCase() ?? ''}`;
    await storage.copyObject(sourceKey, destinationKey);
    return [sourceKey, destinationKey] as const;
  }));
  return replaceFileKeys(snapshot, new Map(copiedEntries)) as Record<string, unknown>;
}

function collectFileKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFileKeys(item, keys));
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    if (key.endsWith('FileKey') && typeof item === 'string' && item) keys.add(item);
    else collectFileKeys(item, keys);
  });
  return keys;
}

function replaceFileKeys(value: unknown, copies: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceFileKeys(item, copies));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key.endsWith('FileKey') && typeof item === 'string' ? (copies.get(item) ?? item) : replaceFileKeys(item, copies),
  ]));
}

async function resolveFileKeys(storage: StorageService, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveFileKeys(storage, item)));
  if (!value || typeof value !== 'object') return value;
  const entries = await Promise.all(Object.entries(value as Record<string, unknown>).map(async ([key, item]) => {
    if (key.endsWith('FileKey')) {
      const publicKey = `${key.slice(0, -7)}Url`;
      return [publicKey, typeof item === 'string' && item ? await storage.signedUrl(item) : null] as const;
    }
    return [key, await resolveFileKeys(storage, item)] as const;
  }));
  return Object.fromEntries(entries);
}

export async function serializeDiscoveryPost(
  storage: StorageService,
  row: DiscoveryPostRow,
  viewerUserId: string,
) {
  const snapshot = await publicSnapshot(storage, row.snapshot_payload);
  if (row.post_type === 'module_recruitment' && row.recruitment_status) {
    snapshot.openSlots = Number(row.recruitment_slots ?? 0);
    snapshot.recruitmentStatus = row.recruitment_status === 'recruiting'
      && row.recruitment_expire_at && row.recruitment_expire_at <= new Date()
      ? 'expired'
      : row.recruitment_status;
  }
  return {
    postId: `post_${row.post_id}`,
    postType: row.post_type,
    author: {
      userId: `u_${row.author_user_id}`,
      name: row.author_name_snapshot,
      avatarUrl: row.author_avatar_file_key_snapshot
        ? await storage.signedUrl(row.author_avatar_file_key_snapshot)
        : null,
      isCurrentUser: String(row.author_user_id) === viewerUserId,
    },
    publicText: row.public_text ?? '',
    snapshot,
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    likedByViewer: Boolean(row.liked_by_viewer),
    publishedAt: isoWithShanghaiOffset(row.published_at),
  };
}

export function effectiveRecruitmentStatus(row: {
  status: string;
  expire_at: Date;
  module_status: string;
  active_member_count: number;
  member_limit: number;
}): 'recruiting' | 'full' | 'expired' | 'closed' {
  if (row.status === 'closed' || row.module_status !== 'active') return 'closed';
  if (row.status === 'full' || Number(row.active_member_count) >= Number(row.member_limit)) return 'full';
  if (row.status === 'expired' || row.expire_at <= new Date()) return 'expired';
  return 'recruiting';
}
