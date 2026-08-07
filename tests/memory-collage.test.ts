import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MemoryCollageItem, MemoryStickerItem } from '../src/services/api';
import {
  buildDefaultMemoryCollageItems,
  clampMemoryCollageTransform,
  clampMemoryCollageTransformToBounds,
  MEMORY_COLLAGE_EDITABLE_BOUNDS,
  MEMORY_COLLAGE_MOVABLE_AREA_STYLE,
  MAX_MEMORY_COLLAGE_ITEMS,
  memoryCollageBoardBackgroundStyle,
  memoryCollageItemStyle,
  memoryCollageMovableGeometry,
  memoryCollagePositionFromMovable,
  normalizeMemoryCollageLayers,
  reorderMemoryCollageItem,
  shortMemoryRecordDate,
} from '../src/utils/memory-collage';

const sticker = (index: number): MemoryStickerItem => ({
  recordId: `r_${index}`,
  moduleId: 'm_1',
  recordDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
  stickerPath: `https://example.invalid/${index}.png`,
  displayOrder: index,
});

describe('memory collage editor', () => {
  it('builds a deterministic initial layout from at most eight real record stickers', () => {
    const items = buildDefaultMemoryCollageItems(Array.from({ length: 10 }, (_, index) => sticker(index)));

    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ recordId: 'r_0', x: 0.17, y: 0.36, rotation: 8, zIndex: 0 });
    expect(items[7]).toMatchObject({ recordId: 'r_7', x: 0.83, y: 0.62, zIndex: 7 });
    expect(items.every((item) => item.assetType === 'record_sticker')).toBe(true);
  });

  it('normalizes layers and clamps transforms to the server contract', () => {
    const item: MemoryCollageItem = {
      ...buildDefaultMemoryCollageItems([sticker(0)])[0],
      x: 2,
      y: -1,
      width: 0.01,
      height: 1,
      rotation: 540,
      zIndex: 8,
    };
    expect(clampMemoryCollageTransform(item)).toMatchObject({
      x: 1.2,
      y: -0.2,
      width: 0.08,
      height: 0.7,
      rotation: 180,
    });
    expect(normalizeMemoryCollageLayers([{ ...item, zIndex: 8 }, { ...item, itemId: 'second', zIndex: 2 }])
      .map((candidate) => candidate.zIndex)).toEqual([0, 1]);
    expect(clampMemoryCollageTransformToBounds(
      { ...item, x: 0, y: 1, width: 0.2, height: 0.2 },
      { left: 0.15, top: 0.1, right: 0.85, bottom: 0.88 },
    )).toMatchObject({ x: 0.25, y: 0.78, width: 0.2, height: 0.2 });
    expect(MAX_MEMORY_COLLAGE_ITEMS).toBe(20);
    expect(MEMORY_COLLAGE_EDITABLE_BOUNDS).toEqual({
      left: 0.045, top: 0.13, right: 0.955, bottom: 0.945,
    });
  });

  it('moves the selected sticker to the front or back without restoring its old layer', () => {
    const items = buildDefaultMemoryCollageItems([sticker(0), sticker(1), sticker(2)]);

    const movedToFront = reorderMemoryCollageItem(items, items[0].itemId, true);
    expect(movedToFront.map((item) => item.itemId)).toEqual([
      items[1].itemId,
      items[2].itemId,
      items[0].itemId,
    ]);
    expect(movedToFront.map((item) => item.zIndex)).toEqual([0, 1, 2]);

    const movedToBack = reorderMemoryCollageItem(items, items[2].itemId, false);
    expect(movedToBack.map((item) => item.itemId)).toEqual([
      items[2].itemId,
      items[0].itemId,
      items[1].itemId,
    ]);
    expect(movedToBack.map((item) => item.zIndex)).toEqual([0, 1, 2]);
  });

  it('round-trips sticker coordinates through the native movable area', () => {
    const item = buildDefaultMemoryCollageItems([sticker(0)])[0];
    const bounds = MEMORY_COLLAGE_EDITABLE_BOUNDS;
    const geometry = memoryCollageMovableGeometry(item, bounds, 345);

    expect(geometry.width).toBeCloseTo(75.9);
    expect(geometry.height).toBeCloseTo(96.6);
    const position = memoryCollagePositionFromMovable(
      item,
      geometry.moveX,
      geometry.moveY,
      bounds,
      345,
    );
    expect(position.x).toBeCloseTo(item.x);
    expect(position.y).toBeCloseTo(item.y);
  });

  it('lets stickers reach the shared right and bottom safe edges', () => {
    const bounds = MEMORY_COLLAGE_EDITABLE_BOUNDS;
    const boardSize = 345;
    const item = clampMemoryCollageTransformToBounds({
      ...buildDefaultMemoryCollageItems([sticker(0)])[0],
      x: 1,
      y: 1,
      width: 0.2,
      height: 0.2,
    }, bounds);
    const geometry = memoryCollageMovableGeometry(item, bounds, boardSize);

    expect(item.x).toBeCloseTo(bounds.right - item.width / 2);
    expect(item.y).toBeCloseTo(bounds.bottom - item.height / 2);
    expect(geometry.moveX).toBeCloseTo((bounds.right - bounds.left - item.width) * boardSize);
    expect(geometry.moveY).toBeCloseTo((bounds.bottom - bounds.top - item.height) * boardSize);
    expect(MEMORY_COLLAGE_MOVABLE_AREA_STYLE).toBe('left:4.5%;top:13%;width:91%;height:81.5%');
  });

  it('creates stable responsive styles and date labels', () => {
    const item = buildDefaultMemoryCollageItems([sticker(0)])[0];
    expect(memoryCollageItemStyle(item)).toContain('left:17%');
    expect(memoryCollageItemStyle(item)).toContain('rotate(8deg)');
    expect(memoryCollageItemStyle({ ...item, zIndex: 0 })).toContain('z-index:10');
    expect(shortMemoryRecordDate('2026-08-04')).toBe('8月4日');
  });

  it('uses the shared font tokens and keeps empty board/decor states', () => {
    const wxml = readFileSync('src/subpackages/memory-collage-editor/index.wxml', 'utf8');
    const styles = readFileSync('src/subpackages/memory-collage-editor/index.wxss', 'utf8');
    const page = readFileSync('src/subpackages/memory-collage-editor/index.ts', 'utf8');

    expect(wxml).toContain('暂无可选画板');
    expect(wxml).toContain('暂无装饰贴纸');
    expect(wxml).toContain('collageItemCount}} / 20');
    expect(wxml).not.toContain('{{item.name}}');
    expect(wxml).toContain('recordStickers');
    expect(wxml).toContain('<movable-area class="editor-sticker-movable-area" style="{{movableAreaStyle}}">');
    expect(wxml).toContain('<movable-view');
    expect(wxml).toContain('bindchange="onStickerPositionChange"');
    expect(wxml).not.toContain('onStickerTouchMove');
    expect(wxml).not.toContain('catchtouchmove="onStickerTouchMove"');
    expect(wxml).toContain('style="{{item.frameStyle}}"');
    expect(wxml).toContain('style="{{item.rotationStyle}}"');
    expect(wxml).toContain('wx:for="{{visibleDecorativeStickers}}"');
    expect(wxml).toContain('bindscrolltolower="loadMoreDecorativeStickers"');
    expect(wxml).toContain('src="{{item.displayPath}}"');
    expect(wxml).toContain("draggingItemId === item.itemId ? 'gesture-active' : ''");
    expect(wxml).toContain('class="editor-board-background"');
    expect(wxml).toContain('mode="scaleToFill"');
    expect(wxml).toContain('style="{{item.backgroundStyle}}"');
    expect(wxml).not.toContain('editor-board-base');
    expect(styles).toContain('var(--font-size-caption)');
    expect(styles).toContain('var(--font-size-body)');
    expect(styles).toMatch(/\.collage-editor-board\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(styles).toContain('.editor-board-background');
    expect(styles).toContain('width: min(92vw, 690rpx)');
    expect(styles).not.toContain('.gesture-active .editor-collage-image');
    expect(styles).toMatch(/\.editor-sticker-movable-area\s*\{[\s\S]*?position:\s*absolute;/);
    expect(styles).not.toMatch(/\.editor-sticker-movable-area\s*\{[\s\S]*?left:\s*4\.5%;/);
    expect(styles).not.toMatch(/font-size:\s*\d+rpx/);
    expect(page).toContain('getMemoryCollage(');
    expect(page).toContain('saveMemoryCollage({');
    expect(page).toContain("DEFAULT_BOARD_ASSET_ID = 'default-brown-board'");
    expect(page).toContain("DEFAULT_BOARD_PATH = '/assets/ui/memory-collage-board.webp'");
    expect(page).toContain("DEFAULT_BOARD_BACKGROUND_STYLE = 'left:-8.007%;top:-3.826%;width:119.181%;height:111.304%'");
    expect(page).toContain('DEFAULT_BOARD_SOURCE_FRAME = { left: 43, top: 22, width: 537, height: 575 }');
    expect(page).toContain('const boards = [defaultBoardAsset(), ...view.boards.map(presentBoardAsset)]');
    expect(page).toContain('const activeBoard = savedBoard ?? boards[0]');
    expect(page.match(/editableBounds: MEMORY_COLLAGE_EDITABLE_BOUNDS/g)).toHaveLength(3);
    expect(page).not.toContain('DEFAULT_BOARD_EDITABLE_BOUNDS');
    expect(page).toContain("this.data.boardAssetId !== DEFAULT_BOARD_ASSET_ID");
    expect(page).toContain('TRANSFORM_UPDATE_INTERVAL_MS = 16');
    expect(page).toContain("this.setData({ [`items[${index}]`]: item }, callback)");
    expect(page).toContain('transformUpdateInFlight');
    expect(page).toContain('DECORATIVE_STICKER_PAGE_SIZE = 30');
    expect(page).toContain('loadMoreDecorativeStickers()');
    expect(page).toContain('onStickerPositionChange(');
    expect(page).toContain("event.detail.source !== 'touch'");
    expect(page).toContain('source.thumbnailPath');
    expect(page).toContain('context.clearRect(0, 0, 900, 900)');
    expect(page).toContain("fileType: 'png'");
    expect(page).not.toContain('mock');
    expect(memoryCollageBoardBackgroundStyle()).toBe('left:-15.198%;top:-4.883%;width:130.779%;height:113.651%');
  });

  it('uses layout-stable view controls instead of native buttons in the editor', () => {
    const wxml = readFileSync('src/subpackages/memory-collage-editor/index.wxml', 'utf8');
    const styles = readFileSync('src/subpackages/memory-collage-editor/index.wxss', 'utf8');

    expect(wxml).not.toMatch(/<\/?button\b/);
    expect(wxml).toContain('role="button"');
    expect(wxml).toContain('catchtouchend="deleteItem"');
    expect(wxml).toContain('data-id="{{item.itemId}}"');
    expect(wxml).toContain('catchtap="sendSelectedToBack"');
    expect(wxml).toContain('catchtap="bringSelectedToFront"');
    expect(styles).toContain('grid-template-columns: 80rpx minmax(0, 1fr) 80rpx');
    expect(styles).toContain('.editor-record-asset,');
    expect(styles).toMatch(/\.editor-record-asset,[\s\S]*?min-width:\s*0;/);
    expect(styles).toMatch(/\.item-delete-handle,[\s\S]*?width:\s*52rpx;/);
    expect(styles).toMatch(/\.editor-asset-tab\s*\{[\s\S]*?overflow:\s*hidden;/);
  });
});
