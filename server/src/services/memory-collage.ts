import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/errors';
import { publicId } from '../lib/ids';
import { shanghaiDate } from '../lib/time';
import type { StorageService } from './storage';
import { resolveMemoryPeriod, type MemoryReportMode, type MemoryOverviewResult } from './memory-overview';

export type MemoryCollageAssetType = 'record_sticker' | 'decorative_sticker';

export interface MemoryCollageEditableBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MemoryCollageTransform {
  assetType: MemoryCollageAssetType;
  recordId?: string;
  stickerAssetId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
}

export interface SaveMemoryCollageInput {
  reportMode: MemoryReportMode;
  periodKey: string;
  moduleId?: string;
  boardAssetId?: string;
  baseVersion: number;
  force: boolean;
  items: MemoryCollageTransform[];
}

interface CollageRow extends RowDataPacket {
  collage_id: string;
  board_asset_id: string | null;
  version: number;
  saved_at: Date | string;
  board_name: string | null;
  board_thumbnail_file_key: string | null;
  board_original_file_key: string | null;
  board_editable_left: string | number | null;
  board_editable_top: string | number | null;
  board_editable_right: string | number | null;
  board_editable_bottom: string | number | null;
}

interface CollageItemRow extends RowDataPacket {
  item_id: string;
  asset_type: MemoryCollageAssetType;
  record_id: string | null;
  sticker_asset_id: string | null;
  position_x: string | number;
  position_y: string | number;
  width_ratio: string | number;
  height_ratio: string | number;
  rotation_degrees: string | number;
  z_index: number;
  record_date: Date | string | null;
  record_module_id: string | null;
  record_file_key: string | null;
  record_accessible: number;
  sticker_name: string | null;
  sticker_file_key: string | null;
}

interface BoardAssetRow extends RowDataPacket {
  board_asset_id: string;
  name: string;
  category: string;
  thumbnail_file_key: string;
  original_file_key: string;
  editable_left: string | number;
  editable_top: string | number;
  editable_right: string | number;
  editable_bottom: string | number;
}

interface StickerAssetRow extends RowDataPacket {
  sticker_asset_id: string;
  name: string;
  category: string;
  thumbnail_file_key: string;
  original_file_key: string;
  default_width: string | number;
  default_height: string | number;
}

export function memoryCollageScopeKey(moduleId?: string): string {
  return moduleId ? `module:${moduleId}` : 'all';
}

export function validateMemoryCollageItems(items: MemoryCollageTransform[]): void {
  if (items.length > 20) throw new AppError('COLLAGE_ITEM_LIMIT', '画板最多放置 20 个贴纸', 422);
  const zIndexes = new Set<number>();
  for (const item of items) {
    if (item.assetType === 'record_sticker' ? !item.recordId || item.stickerAssetId : !item.stickerAssetId || item.recordId) {
      throw new AppError('VALIDATION_ERROR', '贴纸资源类型不正确', 422);
    }
    if (item.x < -0.2 || item.x > 1.2 || item.y < -0.2 || item.y > 1.2
      || item.width < 0.08 || item.width > 0.7 || item.height < 0.08 || item.height > 0.7
      || item.rotation < -180 || item.rotation > 180 || item.zIndex < 0 || item.zIndex > 999) {
      throw new AppError('VALIDATION_ERROR', '贴纸布局超出允许范围', 422);
    }
    if (zIndexes.has(item.zIndex)) throw new AppError('VALIDATION_ERROR', '贴纸层级不能重复', 422);
    zIndexes.add(item.zIndex);
  }
}

export async function getMemoryCollageView(
  pool: Pool,
  storage: StorageService,
  userId: string,
  overview: MemoryOverviewResult,
  moduleId?: string,
) {
  const scopeKey = memoryCollageScopeKey(moduleId);
  const [[collages], [boards], [stickers]] = await Promise.all([
    pool.execute<CollageRow[]>(
      `SELECT c.collage_id, c.board_asset_id, c.version, c.saved_at,
              b.name AS board_name, b.thumbnail_file_key AS board_thumbnail_file_key,
              b.original_file_key AS board_original_file_key,
              b.editable_left AS board_editable_left, b.editable_top AS board_editable_top,
              b.editable_right AS board_editable_right, b.editable_bottom AS board_editable_bottom
         FROM memory_collage c
         LEFT JOIN memory_collage_board_asset b ON b.board_asset_id = c.board_asset_id
        WHERE c.user_id = ? AND c.scope_key = ? AND c.report_mode = ? AND c.period_key = ?
          AND c.status = 'active' LIMIT 1`,
      [userId, scopeKey, overview.reportMode, overview.periodKey],
    ),
    pool.execute<BoardAssetRow[]>(
      `SELECT board_asset_id, name, category, thumbnail_file_key, original_file_key,
              editable_left, editable_top, editable_right, editable_bottom
         FROM memory_collage_board_asset WHERE status = 'active'
        ORDER BY sort_order ASC, board_asset_id ASC`,
    ),
    pool.execute<StickerAssetRow[]>(
      `SELECT sticker_asset_id, name, category, thumbnail_file_key, original_file_key,
              default_width, default_height
         FROM memory_collage_sticker_asset WHERE status = 'active'
        ORDER BY sort_order ASC, sticker_asset_id ASC`,
    ),
  ]);
  const collage = collages[0];
  const items = collage
    ? await loadCollageItems(pool, storage, userId, String(collage.collage_id))
    : [];
  const boardAssets = await Promise.all(boards.map(async (board) => ({
    boardAssetId: publicId('cboard', board.board_asset_id),
    name: String(board.name),
    category: String(board.category),
    thumbnailUrl: await storage.signedUrl(String(board.thumbnail_file_key)),
    imageUrl: await storage.signedUrl(String(board.original_file_key)),
    editableBounds: editableBoundsFromBoardRow(board),
  })));
  const decorativeStickers = await Promise.all(stickers.map(async (sticker) => ({
    stickerAssetId: publicId('csticker', sticker.sticker_asset_id),
    name: String(sticker.name),
    category: String(sticker.category),
    thumbnailUrl: await storage.signedUrl(String(sticker.thumbnail_file_key)),
    imageUrl: await storage.signedUrl(String(sticker.original_file_key)),
    defaultWidth: Number(sticker.default_width),
    defaultHeight: Number(sticker.default_height),
  })));
  return {
    reportMode: overview.reportMode,
    periodKey: overview.periodKey,
    scopeKey,
    moduleId: overview.moduleId,
    moduleName: overview.moduleName,
    collage: collage ? {
      collageId: publicId('collage', collage.collage_id),
      version: Number(collage.version),
      savedAt: isoDateTime(collage.saved_at),
      board: collage.board_asset_id && collage.board_original_file_key ? {
        boardAssetId: publicId('cboard', collage.board_asset_id),
        name: String(collage.board_name ?? ''),
        thumbnailUrl: await storage.signedUrl(String(collage.board_thumbnail_file_key)),
        imageUrl: await storage.signedUrl(String(collage.board_original_file_key)),
        editableBounds: editableBoundsFromCollageRow(collage),
      } : null,
      items,
    } : null,
    availableRecordStickers: overview.items,
    boards: boardAssets,
    decorativeStickers,
    decorativeStickerCategories: [...new Set(decorativeStickers.map((item) => item.category))],
  };
}

function editableBoundsFromBoardRow(row: BoardAssetRow): MemoryCollageEditableBounds {
  return {
    left: Number(row.editable_left),
    top: Number(row.editable_top),
    right: Number(row.editable_right),
    bottom: Number(row.editable_bottom),
  };
}

function editableBoundsFromCollageRow(row: CollageRow): MemoryCollageEditableBounds {
  return {
    left: Number(row.board_editable_left),
    top: Number(row.board_editable_top),
    right: Number(row.board_editable_right),
    bottom: Number(row.board_editable_bottom),
  };
}

async function loadCollageItems(pool: Pool, storage: StorageService, userId: string, collageId: string) {
  const [rows] = await pool.execute<CollageItemRow[]>(
    `SELECT i.item_id, i.asset_type, i.record_id, i.sticker_asset_id,
            i.position_x, i.position_y, i.width_ratio, i.height_ratio,
            i.rotation_degrees, i.z_index,
            r.record_date, r.module_id AS record_module_id,
            CASE WHEN r.media_variant = 'original'
              THEN IF(ma.thumbnail_file_key IS NULL OR ma.thumbnail_file_key = ma.sticker_thumbnail_file_key,
                ma.original_file_key, ma.thumbnail_file_key)
              ELSE ma.sticker_thumbnail_file_key END AS record_file_key,
            EXISTS(
              SELECT 1 FROM module_member access
               WHERE access.module_id = r.module_id AND access.user_id = ? AND access.status = 'active'
            ) AS record_accessible,
            s.name AS sticker_name, s.original_file_key AS sticker_file_key
       FROM memory_collage_item i
       LEFT JOIN life_record r ON r.record_id = i.record_id AND r.status IN ('active', 'locked')
       LEFT JOIN media_asset ma ON ma.media_id = r.media_id AND ma.status = 'ready'
       LEFT JOIN memory_collage_sticker_asset s ON s.sticker_asset_id = i.sticker_asset_id
      WHERE i.collage_id = ? ORDER BY i.z_index ASC`,
    [userId, collageId],
  );
  const visible = rows.filter((row) => row.asset_type === 'record_sticker'
    ? row.record_id && row.record_file_key && Number(row.record_accessible) === 1
    : row.sticker_asset_id && row.sticker_file_key);
  return Promise.all(visible.map(async (row) => ({
    itemId: publicId('citem', row.item_id),
    assetType: row.asset_type,
    ...(row.record_id ? {
      recordId: publicId('r', row.record_id),
      moduleId: publicId('m', String(row.record_module_id)),
      recordDate: sqlDate(row.record_date),
    } : {}),
    ...(row.sticker_asset_id ? {
      stickerAssetId: publicId('csticker', row.sticker_asset_id),
      name: String(row.sticker_name ?? ''),
    } : {}),
    imageUrl: await storage.signedUrl(String(row.record_file_key ?? row.sticker_file_key)),
    x: Number(row.position_x),
    y: Number(row.position_y),
    width: Number(row.width_ratio),
    height: Number(row.height_ratio),
    rotation: Number(row.rotation_degrees),
    zIndex: Number(row.z_index),
  })));
}

export async function saveMemoryCollage(
  connection: PoolConnection,
  userId: string,
  input: SaveMemoryCollageInput,
): Promise<{ collageId: string; version: number }> {
  validateMemoryCollageItems(input.items);
  const period = resolveMemoryPeriod(input.reportMode, input.periodKey, shanghaiDate());
  const [memberships] = await connection.execute<RowDataPacket[]>(
    `SELECT mm.module_id FROM module_member mm
      JOIN life_module m ON m.module_id = mm.module_id
     WHERE mm.user_id = ? AND mm.status = 'active' AND m.status = 'active'`,
    [userId],
  );
  const accessibleModuleIds = new Set(memberships.map((row) => String(row.module_id)));
  if (input.moduleId && !accessibleModuleIds.has(input.moduleId)) {
    throw new AppError('MODULE_ACCESS_DENIED', '你已不在该模块中', 403);
  }
  const scopeIds = input.moduleId ? [input.moduleId] : [...accessibleModuleIds];

  if (input.boardAssetId) {
    const [boardRows] = await connection.execute<RowDataPacket[]>(
      'SELECT board_asset_id FROM memory_collage_board_asset WHERE board_asset_id = ? LIMIT 1',
      [input.boardAssetId],
    );
    if (!boardRows[0]) throw new AppError('COLLAGE_BOARD_NOT_FOUND', '所选画板已不可用', 422);
  }

  const recordIds = [...new Set(input.items.flatMap((item) => item.recordId ? [item.recordId] : []))];
  if (recordIds.length) {
    if (!scopeIds.length) throw new AppError('COLLAGE_RECORD_NOT_FOUND', '打卡贴纸已不可用', 422);
    const [records] = await connection.execute<RowDataPacket[]>(
      `SELECT r.record_id FROM life_record r
        JOIN media_asset ma ON ma.media_id = r.media_id
       WHERE r.record_id IN (${recordIds.map(() => '?').join(', ')})
         AND r.module_id IN (${scopeIds.map(() => '?').join(', ')})
         AND r.record_date >= ? AND r.record_date < ? AND r.record_date <= ?
         AND r.status IN ('active', 'locked') AND ma.status = 'ready'`,
      [...recordIds, ...scopeIds, period.start, period.endExclusive, period.end],
    );
    const validIds = new Set(records.map((row) => String(row.record_id)));
    if (recordIds.some((recordId) => !validIds.has(recordId))) {
      throw new AppError('COLLAGE_RECORD_NOT_FOUND', '部分打卡贴纸已不可用，请刷新后重试', 422);
    }
  }

  const decorativeIds = [...new Set(input.items.flatMap((item) => item.stickerAssetId ? [item.stickerAssetId] : []))];
  if (decorativeIds.length) {
    const [assets] = await connection.execute<RowDataPacket[]>(
      `SELECT sticker_asset_id FROM memory_collage_sticker_asset
        WHERE sticker_asset_id IN (${decorativeIds.map(() => '?').join(', ')})`,
      decorativeIds,
    );
    const validIds = new Set(assets.map((row) => String(row.sticker_asset_id)));
    if (decorativeIds.some((assetId) => !validIds.has(assetId))) {
      throw new AppError('COLLAGE_STICKER_NOT_FOUND', '部分装饰贴纸已不可用，请刷新后重试', 422);
    }
  }

  const scopeKey = memoryCollageScopeKey(input.moduleId);
  const [existingRows] = await connection.execute<RowDataPacket[]>(
    `SELECT collage_id, version FROM memory_collage
      WHERE user_id = ? AND scope_key = ? AND report_mode = ? AND period_key = ?
      LIMIT 1 FOR UPDATE`,
    [userId, scopeKey, input.reportMode, period.key],
  );
  const existing = existingRows[0];
  if (existing && Number(existing.version) !== input.baseVersion && !input.force) {
    throw new AppError('COLLAGE_VERSION_CONFLICT', '作品已在其他设备更新', 409);
  }

  let collageId: string;
  let version: number;
  if (existing) {
    collageId = String(existing.collage_id);
    version = Number(existing.version) + 1;
    await connection.execute(
      `UPDATE memory_collage SET module_id = ?, board_asset_id = ?, status = 'active',
              version = ?, saved_at = CURRENT_TIMESTAMP(3)
        WHERE collage_id = ?`,
      [input.moduleId ?? null, input.boardAssetId ?? null, version, collageId],
    );
  } else {
    if (input.baseVersion !== 0 && !input.force) {
      throw new AppError('COLLAGE_VERSION_CONFLICT', '作品版本已变化，请重新加载', 409);
    }
    const [insert] = await connection.execute<ResultSetHeader>(
      `INSERT INTO memory_collage
         (user_id, scope_key, module_id, report_mode, period_key, board_asset_id, status, version, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 1, CURRENT_TIMESTAMP(3))`,
      [userId, scopeKey, input.moduleId ?? null, input.reportMode, period.key, input.boardAssetId ?? null],
    );
    collageId = String(insert.insertId);
    version = 1;
  }

  await connection.execute('DELETE FROM memory_collage_item WHERE collage_id = ?', [collageId]);
  if (input.items.length) {
    const values = input.items.flatMap((item) => [
      collageId,
      item.assetType,
      item.recordId ?? null,
      item.stickerAssetId ?? null,
      item.x,
      item.y,
      item.width,
      item.height,
      item.rotation,
      item.zIndex,
    ]);
    await connection.execute(
      `INSERT INTO memory_collage_item
         (collage_id, asset_type, record_id, sticker_asset_id, position_x, position_y,
          width_ratio, height_ratio, rotation_degrees, z_index)
       VALUES ${input.items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      values,
    );
  }
  return { collageId: publicId('collage', collageId), version };
}

function sqlDate(value: Date | string | null): string {
  if (!value) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function isoDateTime(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}
