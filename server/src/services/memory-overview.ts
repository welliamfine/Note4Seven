import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';
import { publicId } from '../lib/ids';
import type { StorageService } from './storage';

export type MemoryReportMode = 'week' | 'month';

interface MemoryModuleRow extends RowDataPacket {
  module_id: string;
  name: string;
  active_member_count: number;
}

export interface MemoryRecordRow extends RowDataPacket {
  record_id: string;
  module_id: string;
  record_date: Date | string;
  source: 'normal' | 'makeup';
  effective_time: string | null;
}

interface MemorySnapshotRow extends RowDataPacket {
  module_id: string;
  record_date: Date | string;
  required_member_count: number;
  is_all_completed: number;
}

interface MemoryStickerRow extends RowDataPacket {
  record_id: string;
  module_id: string;
  member_instance_id: string;
  record_date: Date | string;
  sticker_file_key: string;
}

interface MemoryReactionRow extends RowDataPacket {
  reaction_count: number;
  emoji_code: string | null;
}

export interface MemoryPeriod {
  mode: MemoryReportMode;
  key: string;
  start: string;
  endExclusive: string;
  end: string;
  previousStart: string;
  previousEndExclusive: string;
  isCurrent: boolean;
}

export interface MemoryOverviewOptions {
  mode: MemoryReportMode;
  period: string;
  moduleId?: string;
  groupSeed?: string;
  today: string;
}

export interface MemoryOverviewResult {
  reportMode: MemoryReportMode;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  isCurrentPeriod: boolean;
  moduleId: string;
  moduleName: string;
  modules: Array<{ moduleId: string; name: string }>;
  momentCount: number;
  previousMomentCount: number;
  recordedDays: number;
  previousRecordedDays: number;
  participatedModuleCount: number;
  longestStreakDays: number;
  previousLongestStreakDays: number;
  currentStreakDays: number;
  currentStreakOngoing: boolean;
  jointCompletedDays: number;
  previousJointCompletedDays: number;
  hasPartnerModules: boolean;
  earliestTime: string | null;
  latestTime: string | null;
  receivedReactionCount: number;
  mostUsedEmojiCode: string | null;
  latestStickerPath?: string;
  footprint: Array<{ date: string; recordCount: number; level: number; stickerPath?: string }>;
  items: Array<{ recordId: string; moduleId: string; recordDate: string; stickerPath: string; displayOrder: number }>;
}

export function resolveMemoryPeriod(mode: MemoryReportMode, period: string, today: string): MemoryPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('INVALID_TODAY');
  if (mode === 'month') {
    if (!/^(19\d{2}|20\d{2})-(0[1-9]|1[0-2])$/.test(period)) {
      throw new AppError('VALIDATION_ERROR', '月份格式不正确', 422);
    }
    if (period > today.slice(0, 7)) throw new AppError('VALIDATION_ERROR', '不能查看未来月份', 422);
    const start = `${period}-01`;
    const endExclusive = shiftMonthStart(period, 1);
    const previousStart = shiftMonthStart(period, -1);
    return {
      mode,
      key: period,
      start,
      endExclusive,
      end: minDate(addDateDays(endExclusive, -1), today),
      previousStart,
      previousEndExclusive: start,
      isCurrent: period === today.slice(0, 7),
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    throw new AppError('VALIDATION_ERROR', '周起始日期格式不正确', 422);
  }
  const start = mondayOf(period);
  if (start !== period) throw new AppError('VALIDATION_ERROR', '周起始日期必须是周一', 422);
  const currentWeek = mondayOf(today);
  if (start > currentWeek) throw new AppError('VALIDATION_ERROR', '不能查看未来周', 422);
  const endExclusive = addDateDays(start, 7);
  return {
    mode,
    key: start,
    start,
    endExclusive,
    end: minDate(addDateDays(endExclusive, -1), today),
    previousStart: addDateDays(start, -7),
    previousEndExclusive: start,
    isCurrent: start === currentWeek,
  };
}

export function mondayOf(date: string): string {
  const parsed = parseDate(date);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return formatDate(parsed);
}

export function summarizeMemoryRecords(
  rows: MemoryRecordRow[],
  start: string,
  endExclusive: string,
  effectiveEnd: string,
): {
  momentCount: number;
  recordedDays: number;
  participatedModuleCount: number;
  longestStreakDays: number;
  currentStreakDays: number;
  currentStreakOngoing: boolean;
  earliestTime: string | null;
  latestTime: string | null;
} {
  const selected = rows.filter((row) => {
    const date = sqlDate(row.record_date);
    return date >= start && date < endExclusive && date <= effectiveEnd;
  });
  const dates = new Set(selected.map((row) => sqlDate(row.record_date)));
  const normalTimes = selected
    .filter((row) => row.source !== 'makeup' && row.effective_time)
    .map((row) => String(row.effective_time).slice(0, 5))
    .sort();
  return {
    momentCount: selected.length,
    recordedDays: dates.size,
    participatedModuleCount: new Set(selected.map((row) => String(row.module_id))).size,
    longestStreakDays: longestStreak(dates),
    currentStreakDays: trailingStreak(dates, effectiveEnd),
    currentStreakOngoing: dates.has(effectiveEnd),
    earliestTime: normalTimes[0] ?? null,
    latestTime: normalTimes.at(-1) ?? null,
  };
}

export async function getMemoryOverview(
  pool: Pool,
  storage: StorageService,
  userId: string,
  options: MemoryOverviewOptions,
): Promise<MemoryOverviewResult> {
  const period = resolveMemoryPeriod(options.mode, options.period, options.today);
  const [moduleRows] = await pool.execute<MemoryModuleRow[]>(
    `SELECT m.module_id, m.name, m.active_member_count
       FROM module_member mine
       JOIN life_module m ON m.module_id = mine.module_id
      WHERE mine.user_id = ? AND mine.status = 'active' AND m.status = 'active'
      ORDER BY m.updated_at DESC, m.module_id DESC`,
    [userId],
  );
  const selectedModule = options.moduleId
    ? moduleRows.find((row) => String(row.module_id) === options.moduleId)
    : undefined;
  if (options.moduleId && !selectedModule) {
    throw new AppError('MODULE_ACCESS_DENIED', '你已不在该模块中', 403);
  }
  const scopeModules = selectedModule ? [selectedModule] : moduleRows;
  const modules = moduleRows.map((row) => ({ moduleId: publicId('m', row.module_id), name: String(row.name) }));
  if (!scopeModules.length) return emptyOverview(period, modules);

  const scopeIds = scopeModules.map((row) => String(row.module_id));
  const placeholders = scopeIds.map(() => '?').join(', ');
  const [recordRows] = await pool.execute<MemoryRecordRow[]>(
    `SELECT r.record_id, r.module_id, r.record_date, r.source,
            TIME_FORMAT(r.first_effective_at, '%H:%i') AS effective_time
       FROM life_record r
      WHERE r.user_id = ? AND r.module_id IN (${placeholders})
        AND r.record_date < ? AND r.record_date <= ?
        AND r.status IN ('active', 'locked')
      ORDER BY r.record_date ASC, r.first_effective_at ASC`,
    [userId, ...scopeIds, period.endExclusive, options.today],
  );
  const current = summarizeMemoryRecords(recordRows, period.start, period.endExclusive, period.end);
  const previousEffectiveEnd = addDateDays(period.previousEndExclusive, -1);
  const previous = summarizeMemoryRecords(
    recordRows,
    period.previousStart,
    period.previousEndExclusive,
    previousEffectiveEnd,
  );
  const allRecordedDates = new Set(recordRows
    .map((row) => sqlDate(row.record_date))
    .filter((date) => date <= period.end));
  const currentStreakDays = trailingStreak(allRecordedDates, period.end);
  const currentStreakOngoing = allRecordedDates.has(period.end);

  const [snapshotRows] = await pool.execute<MemorySnapshotRow[]>(
    `SELECT s.module_id, s.record_date, s.required_member_count, s.is_all_completed
       FROM daily_module_snapshot s
      WHERE s.module_id IN (${placeholders})
        AND s.record_date >= ? AND s.record_date < ? AND s.record_date <= ?`,
    [...scopeIds, period.previousStart, period.endExclusive, options.today],
  );
  const jointCompletedDays = countJointCompletions(snapshotRows, period.start, period.endExclusive, period.end);
  const previousJointCompletedDays = countJointCompletions(
    snapshotRows,
    period.previousStart,
    period.previousEndExclusive,
    previousEffectiveEnd,
  );
  const hasPartnerModules = scopeModules.some((row) => Number(row.active_member_count) > 1)
    || snapshotRows.some((row) => Number(row.required_member_count) > 1);

  const seed = createHash('sha256')
    .update(`${userId}:${period.mode}:${period.key}:${options.moduleId ?? 'all'}:${options.groupSeed ?? 'stable'}`)
    .digest('hex');
  const [latestStickerRows] = await pool.execute<MemoryStickerRow[]>(
    `SELECT r.record_id, r.module_id, r.member_instance_id, r.record_date,
            COALESCE(ma.sticker_thumbnail_file_key, ma.thumbnail_file_key, ma.original_file_key) AS sticker_file_key
       FROM life_record r
       JOIN media_asset ma ON ma.media_id = r.media_id
      WHERE r.user_id = ? AND r.module_id IN (${placeholders})
        AND r.record_date >= ? AND r.record_date < ? AND r.record_date <= ?
        AND r.status IN ('active', 'locked') AND ma.status = 'ready'
      ORDER BY r.first_effective_at DESC, r.record_id DESC
      LIMIT 1`,
    [userId, ...scopeIds, period.start, period.endExclusive, options.today],
  );
  const latestStickerPath = latestStickerRows[0]?.sticker_file_key
    ? await storage.signedUrl(String(latestStickerRows[0].sticker_file_key))
    : undefined;
  const [stickerCandidates] = await pool.execute<MemoryStickerRow[]>(
    `SELECT r.record_id, r.module_id, r.member_instance_id, r.record_date,
            CASE WHEN r.media_variant = 'original'
              THEN IF(ma.thumbnail_file_key IS NULL OR ma.thumbnail_file_key = ma.sticker_thumbnail_file_key,
                ma.original_file_key, ma.thumbnail_file_key)
              ELSE ma.sticker_thumbnail_file_key END AS sticker_file_key
       FROM life_record r
       JOIN media_asset ma ON ma.media_id = r.media_id
      WHERE r.module_id IN (${placeholders})
        AND r.record_date >= ? AND r.record_date < ? AND r.record_date <= ?
        AND r.status IN ('active', 'locked') AND ma.status = 'ready'
      ORDER BY SHA2(CONCAT(r.record_id, ?), 256)
      LIMIT 512`,
    [...scopeIds, period.start, period.endExclusive, options.today, seed],
  );
  const stickerRows = selectBalancedStickerRows(stickerCandidates, 8);
  const items = await Promise.all(stickerRows.map(async (row, index) => ({
    recordId: publicId('r', row.record_id),
    moduleId: publicId('m', row.module_id),
    recordDate: sqlDate(row.record_date),
    stickerPath: await storage.signedUrl(String(row.sticker_file_key)),
    displayOrder: index,
  })));

  const [reactionRows] = await pool.execute<MemoryReactionRow[]>(
    `SELECT re.emoji_code, COUNT(*) AS reaction_count
       FROM reaction re
       JOIN life_record own_record ON own_record.record_id = re.record_id
      WHERE own_record.user_id = ? AND own_record.module_id IN (${placeholders})
        AND own_record.record_date >= ? AND own_record.record_date < ?
        AND own_record.record_date <= ? AND own_record.status IN ('active', 'locked')
        AND re.status = 'active'
      GROUP BY re.emoji_code
      ORDER BY reaction_count DESC, re.emoji_code ASC`,
    [userId, ...scopeIds, period.start, period.endExclusive, options.today],
  );

  const countByDate = new Map<string, number>();
  recordRows.forEach((row) => {
    const date = sqlDate(row.record_date);
    if (date >= period.start && date < period.endExclusive && date <= period.end) {
      countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
    }
  });
  const featuredSticker = items[0];
  const footprint = [...countByDate.entries()].map(([date, recordCount]) => ({
    date,
    recordCount,
    level: Math.min(4, recordCount),
    ...(featuredSticker?.recordDate === date ? { stickerPath: featuredSticker.stickerPath } : {}),
  }));

  return {
    reportMode: period.mode,
    periodKey: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    isCurrentPeriod: period.isCurrent,
    moduleId: selectedModule ? publicId('m', selectedModule.module_id) : '',
    moduleName: selectedModule ? String(selectedModule.name) : '',
    modules,
    momentCount: current.momentCount,
    previousMomentCount: previous.momentCount,
    recordedDays: current.recordedDays,
    previousRecordedDays: previous.recordedDays,
    participatedModuleCount: current.participatedModuleCount,
    longestStreakDays: current.longestStreakDays,
    previousLongestStreakDays: previous.longestStreakDays,
    currentStreakDays,
    currentStreakOngoing,
    jointCompletedDays,
    previousJointCompletedDays,
    hasPartnerModules,
    earliestTime: current.earliestTime,
    latestTime: current.latestTime,
    receivedReactionCount: reactionRows.reduce((total, row) => total + Number(row.reaction_count ?? 0), 0),
    mostUsedEmojiCode: reactionRows[0]?.emoji_code ? String(reactionRows[0].emoji_code) : null,
    ...(latestStickerPath ? { latestStickerPath } : {}),
    footprint,
    items,
  };
}

export function selectBalancedStickerRows(rows: MemoryStickerRow[], limit: number): MemoryStickerRow[] {
  const selected: MemoryStickerRow[] = [];
  const selectedIds = new Set<string>();
  const representedMembers = new Set<string>();
  for (const row of rows) {
    const memberId = String(row.member_instance_id);
    if (representedMembers.has(memberId) || !row.sticker_file_key) continue;
    selected.push(row);
    selectedIds.add(String(row.record_id));
    representedMembers.add(memberId);
    if (selected.length === limit) return selected;
  }
  for (const row of rows) {
    if (!row.sticker_file_key || selectedIds.has(String(row.record_id))) continue;
    selected.push(row);
    if (selected.length === limit) break;
  }
  return selected;
}

function emptyOverview(
  period: MemoryPeriod,
  modules: Array<{ moduleId: string; name: string }>,
): MemoryOverviewResult {
  return {
    reportMode: period.mode,
    periodKey: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    isCurrentPeriod: period.isCurrent,
    moduleId: '',
    moduleName: '',
    modules,
    momentCount: 0,
    previousMomentCount: 0,
    recordedDays: 0,
    previousRecordedDays: 0,
    participatedModuleCount: 0,
    longestStreakDays: 0,
    previousLongestStreakDays: 0,
    currentStreakDays: 0,
    currentStreakOngoing: false,
    jointCompletedDays: 0,
    previousJointCompletedDays: 0,
    hasPartnerModules: false,
    earliestTime: null,
    latestTime: null,
    receivedReactionCount: 0,
    mostUsedEmojiCode: null,
    footprint: [],
    items: [],
  };
}

function countJointCompletions(
  rows: MemorySnapshotRow[],
  start: string,
  endExclusive: string,
  effectiveEnd: string,
): number {
  return rows.filter((row) => {
    const date = sqlDate(row.record_date);
    return date >= start && date < endExclusive && date <= effectiveEnd
      && Number(row.required_member_count) > 1 && Boolean(row.is_all_completed);
  }).length;
}

function longestStreak(dates: Set<string>): number {
  let longest = 0;
  let current = 0;
  let previous = '';
  [...dates].sort().forEach((date) => {
    current = previous && addDateDays(previous, 1) === date ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  });
  return longest;
}

function trailingStreak(dates: Set<string>, end: string): number {
  let cursor = dates.has(end) ? end : addDateDays(end, -1);
  let count = 0;
  while (dates.has(cursor)) {
    count += 1;
    cursor = addDateDays(cursor, -1);
  }
  return count;
}

function shiftMonthStart(month: string, amount: number): string {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 1 + amount, 1));
  return formatDate(date);
}

function addDateDays(date: string, amount: number): string {
  const parsed = parseDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return formatDate(parsed);
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function sqlDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
