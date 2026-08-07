import type { MemoryCollageItem, MemoryStickerItem } from '../services/api';

const EDITOR_STICKER_LAYER_OFFSET = 10;
export const MAX_MEMORY_COLLAGE_ITEMS = 20;
// Shared non-transparent source frame for the seven same-format 1024px boards.
export const MEMORY_COLLAGE_BOARD_SOURCE_FRAME = {
  left: 119 / 1024,
  top: 44 / 1024,
  right: 902 / 1024,
  bottom: 945 / 1024,
};
export const MEMORY_COLLAGE_EDITABLE_BOUNDS: MemoryCollageEditableBounds = {
  left: 0.045,
  top: 0.13,
  right: 0.955,
  bottom: 0.945,
};
export const MEMORY_COLLAGE_MOVABLE_AREA_STYLE = 'left:4.5%;top:13%;width:91%;height:81.5%';

export interface MemoryCollageEditableBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MemoryCollageMovableGeometry {
  moveX: number;
  moveY: number;
  width: number;
  height: number;
}

const DEFAULT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.17, 0.36, 8],
  [0.39, 0.33, -6],
  [0.61, 0.33, 4],
  [0.83, 0.36, -8],
  [0.17, 0.62, 7],
  [0.39, 0.59, -5],
  [0.61, 0.59, 5],
  [0.83, 0.62, -7],
];

export function buildDefaultMemoryCollageItems(stickers: MemoryStickerItem[]): MemoryCollageItem[] {
  return stickers.slice(0, 8).map((sticker, index) => {
    const [x, y, rotation] = DEFAULT_POSITIONS[index] ?? [0.5, 0.5, 0];
    return {
      itemId: `draft-${sticker.recordId}`,
      assetType: 'record_sticker',
      recordId: sticker.recordId,
      moduleId: sticker.moduleId,
      recordDate: sticker.recordDate,
      imagePath: sticker.stickerPath,
      x,
      y,
      width: 0.22,
      height: 0.28,
      rotation,
      zIndex: index,
    };
  });
}

export function memoryCollageItemStyle(item: MemoryCollageItem): string {
  return [
    `left:${round(item.x * 100)}%`,
    `top:${round(item.y * 100)}%`,
    `width:${round(item.width * 100)}%`,
    `height:${round(item.height * 100)}%`,
    `z-index:${item.zIndex + EDITOR_STICKER_LAYER_OFFSET}`,
    `transform:translate(-50%,-50%) rotate(${round(item.rotation)}deg)`,
  ].join(';');
}

export function memoryCollageMovableGeometry(
  item: MemoryCollageItem,
  bounds: MemoryCollageEditableBounds,
  boardSize: number,
): MemoryCollageMovableGeometry {
  return {
    moveX: (item.x - item.width / 2 - bounds.left) * boardSize,
    moveY: (item.y - item.height / 2 - bounds.top) * boardSize,
    width: item.width * boardSize,
    height: item.height * boardSize,
  };
}

export function memoryCollagePositionFromMovable(
  item: MemoryCollageItem,
  moveX: number,
  moveY: number,
  bounds: MemoryCollageEditableBounds,
  boardSize: number,
): Pick<MemoryCollageItem, 'x' | 'y'> {
  return {
    x: bounds.left + (moveX + item.width * boardSize / 2) / boardSize,
    y: bounds.top + (moveY + item.height * boardSize / 2) / boardSize,
  };
}

export function memoryCollageBoardBackgroundStyle(): string {
  const width = MEMORY_COLLAGE_BOARD_SOURCE_FRAME.right - MEMORY_COLLAGE_BOARD_SOURCE_FRAME.left;
  const height = MEMORY_COLLAGE_BOARD_SOURCE_FRAME.bottom - MEMORY_COLLAGE_BOARD_SOURCE_FRAME.top;
  return [
    `left:${round(-MEMORY_COLLAGE_BOARD_SOURCE_FRAME.left / width * 100)}%`,
    `top:${round(-MEMORY_COLLAGE_BOARD_SOURCE_FRAME.top / height * 100)}%`,
    `width:${round(100 / width)}%`,
    `height:${round(100 / height)}%`,
  ].join(';');
}

export function normalizeMemoryCollageLayers(items: MemoryCollageItem[]): MemoryCollageItem[] {
  return [...items]
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((item, index) => ({ ...item, zIndex: index }));
}

export function reorderMemoryCollageItem(
  items: MemoryCollageItem[],
  itemId: string,
  toFront: boolean,
): MemoryCollageItem[] {
  const normalized = normalizeMemoryCollageLayers(items);
  const selected = normalized.find((item) => item.itemId === itemId);
  if (!selected) return normalized;
  const remaining = normalized.filter((item) => item.itemId !== itemId);
  const reordered = toFront ? [...remaining, selected] : [selected, ...remaining];
  return reordered.map((item, zIndex) => ({ ...item, zIndex }));
}

export function clampMemoryCollageTransform(item: MemoryCollageItem): MemoryCollageItem {
  return {
    ...item,
    x: clamp(item.x, -0.2, 1.2),
    y: clamp(item.y, -0.2, 1.2),
    width: clamp(item.width, 0.08, 0.7),
    height: clamp(item.height, 0.08, 0.7),
    rotation: normalizeRotation(item.rotation),
  };
}

export function clampMemoryCollageTransformToBounds(
  item: MemoryCollageItem,
  bounds: MemoryCollageEditableBounds = { left: 0, top: 0, right: 1, bottom: 1 },
): MemoryCollageItem {
  const maxWidth = Math.min(0.7, Math.max(0.08, bounds.right - bounds.left));
  const maxHeight = Math.min(0.7, Math.max(0.08, bounds.bottom - bounds.top));
  const width = clamp(item.width, 0.08, maxWidth);
  const height = clamp(item.height, 0.08, maxHeight);
  return {
    ...item,
    x: clamp(item.x, bounds.left + width / 2, bounds.right - width / 2),
    y: clamp(item.y, bounds.top + height / 2, bounds.bottom - height / 2),
    width,
    height,
    rotation: normalizeRotation(item.rotation),
  };
}

export function shortMemoryRecordDate(date: string): string {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return `${month}月${day}日`;
}

function normalizeRotation(rotation: number): number {
  let normalized = rotation;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
