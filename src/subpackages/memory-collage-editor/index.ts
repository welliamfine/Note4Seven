import {
  getMemoryCollage,
  saveMemoryCollage,
  type MemoryCollageBoardAsset,
  type MemoryCollageItem,
  type MemoryCollageStickerAsset,
  type MemoryReportMode,
  type MemoryStickerItem,
} from '../../services/api';
import { track } from '../../services/tracker';
import { monthLabel, weekRangeLabel } from '../../utils/date';
import { createId } from '../../utils/id';
import {
  buildDefaultMemoryCollageItems,
  clampMemoryCollageTransformToBounds,
  MEMORY_COLLAGE_EDITABLE_BOUNDS,
  MEMORY_COLLAGE_MOVABLE_AREA_STYLE,
  MEMORY_COLLAGE_BOARD_SOURCE_FRAME,
  memoryCollageBoardBackgroundStyle,
  memoryCollageMovableGeometry,
  memoryCollagePositionFromMovable,
  MAX_MEMORY_COLLAGE_ITEMS,
  normalizeMemoryCollageLayers,
  reorderMemoryCollageItem,
  shortMemoryRecordDate,
  type MemoryCollageEditableBounds,
} from '../../utils/memory-collage';
import { drawStickerWithOutline } from '../../utils/sticker-outline';

interface EditorItem extends MemoryCollageItem {
  displayPath: string;
  frameStyle: string;
  rotationStyle: string;
  moveX: number;
  moveY: number;
}

interface EditorRecordSticker extends MemoryStickerItem {
  added: boolean;
  dateLabel: string;
}

interface EditorBoardAsset extends MemoryCollageBoardAsset {
  backgroundStyle: string;
  usesSourceFrame: boolean;
}

interface BoardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
}

interface GestureState {
  mode: 'move' | 'transform';
  itemId: string;
  startItem: MemoryCollageItem;
  startTouches: TouchPoint[];
  startDistance: number;
  startAngle: number;
  centerX: number;
  centerY: number;
}

interface NativeMoveDetail {
  x: number;
  y: number;
  source: string;
}

type DialogType = '' | 'exit' | 'clear' | 'load-error' | 'save-error' | 'conflict' | 'export' | 'export-settings';

const FALLBACK_BOARD_COLOR = '#e7dbc6';
const BOARD_TEXTURE = '/assets/ui/material-texture.jpg';
const DEFAULT_BOARD_ASSET_ID = 'default-brown-board';
const DEFAULT_BOARD_PATH = '/assets/ui/memory-collage-board.webp';
const FULL_BOARD_BACKGROUND_STYLE = 'left:0;top:0;width:100%;height:100%';
const DEFAULT_BOARD_BACKGROUND_STYLE = 'left:-8.007%;top:-3.826%;width:119.181%;height:111.304%';
const DEFAULT_BOARD_SOURCE_FRAME = { left: 43, top: 22, width: 537, height: 575 };
const TRANSFORM_UPDATE_INTERVAL_MS = 16;
const DECORATIVE_STICKER_PAGE_SIZE = 30;
let boardRect: BoardRect | null = null;
let gesture: GestureState | null = null;
let pendingTransform: MemoryCollageItem | null = null;
let transformUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let transformUpdateInFlight = false;
let lastTransformUpdateAt = 0;
let pendingNativeMove: { itemId: string; x: number; y: number } | null = null;

const defaultBoardAsset = (): EditorBoardAsset => ({
  boardAssetId: DEFAULT_BOARD_ASSET_ID,
  name: '经典棕色',
  category: 'default',
  thumbnailPath: DEFAULT_BOARD_PATH,
  imagePath: DEFAULT_BOARD_PATH,
  editableBounds: MEMORY_COLLAGE_EDITABLE_BOUNDS,
  backgroundStyle: DEFAULT_BOARD_BACKGROUND_STYLE,
  usesSourceFrame: false,
});

const presentBoardAsset = (board: MemoryCollageBoardAsset): EditorBoardAsset => ({
  ...board,
  editableBounds: MEMORY_COLLAGE_EDITABLE_BOUNDS,
  backgroundStyle: memoryCollageBoardBackgroundStyle(),
  usesSourceFrame: true,
});

function estimatedBoardSize(): number {
  const windowInfo = wx.getWindowInfo?.();
  const windowWidth = windowInfo?.windowWidth ?? 375;
  return windowWidth * ((windowInfo?.windowHeight ?? 800) <= 700 ? 0.8 : 0.92);
}

function editorItemGeometry(
  item: MemoryCollageItem,
  bounds: MemoryCollageEditableBounds,
  size = boardRect?.width ?? estimatedBoardSize(),
) {
  const geometry = memoryCollageMovableGeometry(item, bounds, size);
  return {
    moveX: geometry.moveX,
    moveY: geometry.moveY,
    frameStyle: [
      `width:${geometry.width}px`,
      `height:${geometry.height}px`,
      `z-index:${item.zIndex + 10}`,
    ].join(';'),
    rotationStyle: `transform:rotate(${item.rotation}deg)`,
  };
}

function styledItems(
  items: MemoryCollageItem[],
  decorativeStickers: MemoryCollageStickerAsset[] = [],
  bounds: MemoryCollageEditableBounds = MEMORY_COLLAGE_EDITABLE_BOUNDS,
): EditorItem[] {
  const decorativeThumbnails = new Map(decorativeStickers.map((item) => [item.stickerAssetId, item.thumbnailPath]));
  return items.map((item) => ({
    ...item,
    displayPath: (item as Partial<EditorItem>).displayPath
      ?? (item.stickerAssetId ? decorativeThumbnails.get(item.stickerAssetId) : undefined)
      ?? item.imagePath,
    ...editorItemGeometry(item, bounds),
  }));
}

function touchesOf(event: WechatMiniprogram.TouchEvent): TouchPoint[] {
  return Array.from(event.touches ?? []).map((touch) => ({
    clientX: touch.clientX,
    clientY: touch.clientY,
  }));
}

function distance(left: TouchPoint, right: TouchPoint): number {
  return Math.hypot(right.clientX - left.clientX, right.clientY - left.clientY);
}

function angle(left: TouchPoint, right: TouchPoint): number {
  return Math.atan2(right.clientY - left.clientY, right.clientX - left.clientX) * 180 / Math.PI;
}

function canvasImagePath(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: source, success: ({ path }) => resolve(path), fail: reject });
  });
}

Page({
  data: {
    statusBarHeight: 24,
    title: '回忆拼贴',
    moduleId: '',
    reportMode: 'month' as MemoryReportMode,
    periodKey: '',
    version: 0,
    loading: true,
    saving: false,
    exporting: false,
    dirty: false,
    items: [] as EditorItem[],
    selectedItemId: '',
    draggingItemId: '',
    transformingItemId: '',
    boardAssetId: '',
    boardImagePath: '',
    boardBackgroundStyle: FULL_BOARD_BACKGROUND_STYLE,
    boardUsesSourceFrame: false,
    editableBounds: MEMORY_COLLAGE_EDITABLE_BOUNDS,
    movableAreaStyle: MEMORY_COLLAGE_MOVABLE_AREA_STYLE,
    boards: [] as EditorBoardAsset[],
    recordStickers: [] as EditorRecordSticker[],
    collageItemCount: 0,
    decorativeStickers: [] as MemoryCollageStickerAsset[],
    filteredDecorativeStickers: [] as MemoryCollageStickerAsset[],
    visibleDecorativeStickers: [] as MemoryCollageStickerAsset[],
    decorativeCategories: [] as string[],
    decorativeCategory: 'all',
    activeAssetTab: 'record' as 'board' | 'record' | 'decorative',
    dialogOpen: false,
    dialogType: '' as DialogType,
    dialogTitle: '',
    dialogMessage: '',
    dialogShowCancel: true,
    dialogCancelText: '继续编辑',
    dialogConfirmText: '确定',
  },

  onLoad(options: Record<string, string | undefined>) {
    const reportMode: MemoryReportMode = options.mode === 'week' ? 'week' : 'month';
    const periodKey = decodeURIComponent(options.period ?? '');
    const moduleId = decodeURIComponent(options.moduleId ?? '');
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
      reportMode,
      periodKey,
      moduleId,
      title: reportMode === 'month' ? monthLabel(periodKey) : weekRangeLabel(periodKey),
    });
    void this.loadEditor();
  },

  onReady() {
    this.measureBoard();
  },

  onUnload() {
    if (transformUpdateTimer) clearTimeout(transformUpdateTimer);
    transformUpdateTimer = null;
    pendingTransform = null;
    pendingNativeMove = null;
    transformUpdateInFlight = false;
    gesture = null;
    boardRect = null;
    this.disableLeaveAlert();
  },

  async loadEditor() {
    this.setData({ loading: true, selectedItemId: '' });
    try {
      const view = await getMemoryCollage(
        this.data.moduleId || undefined,
        this.data.periodKey,
        this.data.reportMode,
      );
      const sourceItems = view.collage?.items.length
        ? view.collage.items
        : buildDefaultMemoryCollageItems(view.availableRecordStickers);
      const boards = [defaultBoardAsset(), ...view.boards.map(presentBoardAsset)];
      const savedBoard = view.collage?.board
        ? boards.find((board) => board.boardAssetId === view.collage?.board?.boardAssetId)
          ?? presentBoardAsset(view.collage.board)
        : null;
      const activeBoard = savedBoard ?? boards[0];
      const editableBounds = activeBoard.editableBounds;
      const items = styledItems(normalizeMemoryCollageLayers(
        sourceItems.map((item) => clampMemoryCollageTransformToBounds(item, editableBounds)),
      ), view.decorativeStickers);
      const recordStickers = this.presentRecordStickers(view.availableRecordStickers, items);
      this.setData({
        version: view.collage?.version ?? 0,
        items,
        boardAssetId: activeBoard?.boardAssetId ?? '',
        boardImagePath: activeBoard?.imagePath ?? '',
        boardBackgroundStyle: activeBoard?.backgroundStyle ?? FULL_BOARD_BACKGROUND_STYLE,
        boardUsesSourceFrame: activeBoard?.usesSourceFrame ?? false,
        editableBounds,
        boards,
        recordStickers,
        collageItemCount: items.length,
        decorativeStickers: view.decorativeStickers,
        filteredDecorativeStickers: view.decorativeStickers,
        visibleDecorativeStickers: view.decorativeStickers.slice(0, DECORATIVE_STICKER_PAGE_SIZE),
        decorativeCategories: view.decorativeStickerCategories,
        decorativeCategory: 'all',
        loading: false,
        dirty: false,
      }, () => this.measureBoard());
      this.disableLeaveAlert();
      track('memory_collage_edit_open', {
        mode: view.reportMode,
        period: view.periodKey,
        scope: view.scopeKey,
        hasSaved: Boolean(view.collage),
      });
    } catch {
      this.setData({ loading: false });
      this.openDialog('load-error', '暂时无法打开', '回忆素材加载失败，请稍后重试。', '返回', false);
    }
  },

  measureBoard() {
    wx.createSelectorQuery().in(this).select('.collage-editor-board').boundingClientRect().exec((result) => {
      const rect = result[0] as WechatMiniprogram.BoundingClientRectCallbackResult | undefined;
      if (!rect) return;
      boardRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      if (this.data.items.length) {
        this.setData({
          items: styledItems(this.data.items, this.data.decorativeStickers, this.data.editableBounds),
        });
      }
    });
  },

  setAssetTab(event: WechatMiniprogram.TouchEvent) {
    const activeAssetTab = event.currentTarget.dataset.tab as 'board' | 'record' | 'decorative';
    this.setData({ activeAssetTab });
  },

  setDecorativeCategory(event: WechatMiniprogram.TouchEvent) {
    const category = String(event.currentTarget.dataset.category ?? 'all');
    const filteredDecorativeStickers = category === 'all'
      ? this.data.decorativeStickers
      : this.data.decorativeStickers.filter((item) => item.category === category);
    this.setData({
      decorativeCategory: category,
      filteredDecorativeStickers,
      visibleDecorativeStickers: filteredDecorativeStickers.slice(0, DECORATIVE_STICKER_PAGE_SIZE),
    });
  },

  loadMoreDecorativeStickers() {
    const visibleCount = this.data.visibleDecorativeStickers.length;
    if (visibleCount >= this.data.filteredDecorativeStickers.length) return;
    this.setData({
      visibleDecorativeStickers: this.data.filteredDecorativeStickers.slice(
        0,
        visibleCount + DECORATIVE_STICKER_PAGE_SIZE,
      ),
    });
  },

  selectBoard(event: WechatMiniprogram.TouchEvent) {
    const boardAssetId = String(event.currentTarget.dataset.id ?? '');
    const board = this.data.boards.find((item) => item.boardAssetId === boardAssetId);
    if (!board || boardAssetId === this.data.boardAssetId) return;
    const editableBounds = board.editableBounds;
    const items = this.data.items.map((item) => clampMemoryCollageTransformToBounds(
      item,
      editableBounds,
    ));
    this.setData({
      boardAssetId,
      boardImagePath: board.imagePath,
      boardBackgroundStyle: board.backgroundStyle,
      boardUsesSourceFrame: board.usesSourceFrame,
      editableBounds,
      items: styledItems(items, this.data.decorativeStickers, editableBounds),
      collageItemCount: items.length,
    });
    this.markDirty();
    track('memory_collage_board_change', { boardAssetId });
  },

  addRecordSticker(event: WechatMiniprogram.TouchEvent) {
    const recordId = String(event.currentTarget.dataset.id ?? '');
    const source = this.data.recordStickers.find((item) => item.recordId === recordId);
    if (!source) return;
    if (this.data.items.length >= MAX_MEMORY_COLLAGE_ITEMS) {
      wx.showToast({ title: '最多添加 20 个贴纸', icon: 'none' });
      return;
    }
    this.addItem({
      itemId: createId('draft_item'),
      assetType: 'record_sticker',
      recordId: source.recordId,
      moduleId: source.moduleId,
      recordDate: source.recordDate,
      imagePath: source.stickerPath,
      x: 0.5 + Math.min(0.12, this.data.items.length * 0.015),
      y: 0.5 + Math.min(0.12, this.data.items.length * 0.015),
      width: 0.22,
      height: 0.28,
      rotation: 0,
      zIndex: this.nextZIndex(),
    });
    track('memory_collage_sticker_add', { assetType: 'record_sticker', category: 'record' });
  },

  addDecorativeSticker(event: WechatMiniprogram.TouchEvent) {
    const stickerAssetId = String(event.currentTarget.dataset.id ?? '');
    const source = this.data.decorativeStickers.find((item) => item.stickerAssetId === stickerAssetId);
    if (!source) return;
    if (this.data.items.length >= MAX_MEMORY_COLLAGE_ITEMS) {
      wx.showToast({ title: '最多添加 20 个贴纸', icon: 'none' });
      return;
    }
    this.addItem({
      itemId: createId('draft_item'),
      assetType: 'decorative_sticker',
      stickerAssetId: source.stickerAssetId,
      name: source.name,
      imagePath: source.imagePath,
      x: 0.5,
      y: 0.5,
      width: source.defaultWidth,
      height: source.defaultHeight,
      rotation: 0,
      zIndex: this.nextZIndex(),
    }, source.thumbnailPath);
    track('memory_collage_sticker_add', { assetType: 'decorative_sticker', category: source.category });
  },

  addItem(item: MemoryCollageItem, displayPath = (item as Partial<EditorItem>).displayPath ?? item.imagePath) {
    const safeItem = clampMemoryCollageTransformToBounds(item, this.data.editableBounds);
    const items = [...this.data.items, {
      ...safeItem,
      displayPath,
      ...editorItemGeometry(safeItem, this.data.editableBounds),
    }];
    this.updateItems(items, item.itemId);
  },

  selectItem(event: WechatMiniprogram.TouchEvent) {
    const selectedItemId = String(event.currentTarget.dataset.id ?? '');
    if (selectedItemId && selectedItemId !== this.data.selectedItemId) this.setData({ selectedItemId });
  },

  clearSelection() {
    if (this.data.selectedItemId) this.setData({ selectedItemId: '' });
  },

  onStickerTouchStart(event: WechatMiniprogram.TouchEvent) {
    const itemId = String(event.currentTarget.dataset.id ?? '');
    const item = this.data.items.find((candidate) => candidate.itemId === itemId);
    const touches = touchesOf(event);
    if (!item || !touches.length) return;
    pendingNativeMove = null;
    this.setData({ selectedItemId: itemId, draggingItemId: itemId, transformingItemId: '' });
    gesture = this.createGesture('move', item, touches);
  },

  onStickerPositionChange(event: WechatMiniprogram.CustomEvent<NativeMoveDetail>) {
    if (event.detail.source !== 'touch' || !boardRect) return;
    const itemId = String(event.currentTarget.dataset.id ?? '');
    const item = this.data.items.find((candidate) => candidate.itemId === itemId);
    if (!item) return;
    const position = memoryCollagePositionFromMovable(
      item,
      event.detail.x,
      event.detail.y,
      this.data.editableBounds,
      boardRect.width,
    );
    pendingNativeMove = {
      itemId,
      ...position,
    };
  },

  onTransformHandleTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (!boardRect) return;
    const itemId = String(event.currentTarget.dataset.id ?? '');
    const item = this.data.items.find((candidate) => candidate.itemId === itemId);
    const touches = touchesOf(event);
    if (!item || !touches.length) return;
    pendingNativeMove = null;
    this.setData({ selectedItemId: itemId, draggingItemId: itemId, transformingItemId: itemId });
    lastTransformUpdateAt = 0;
    gesture = this.createGesture('transform', item, touches);
  },

  onTransformHandleTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (!gesture || gesture.mode !== 'transform' || !boardRect) return;
    const touch = touchesOf(event)[0];
    if (!touch) return;
    const currentDistance = Math.hypot(touch.clientX - gesture.centerX, touch.clientY - gesture.centerY);
    const currentAngle = Math.atan2(touch.clientY - gesture.centerY, touch.clientX - gesture.centerX) * 180 / Math.PI;
    const scale = currentDistance / Math.max(1, gesture.startDistance);
    this.queueItemTransform({
      ...gesture.startItem,
      width: gesture.startItem.width * scale,
      height: gesture.startItem.height * scale,
      rotation: gesture.startItem.rotation + currentAngle - gesture.startAngle,
    });
  },

  onStickerTouchEnd(event: WechatMiniprogram.TouchEvent) {
    const activeGesture = gesture;
    if (!activeGesture) return;
    if (activeGesture.mode === 'move' && boardRect) {
      const finalMove = pendingNativeMove?.itemId === activeGesture.itemId ? pendingNativeMove : null;
      const changedTouch = Array.from(event.changedTouches ?? [])[0];
      const fallbackX = changedTouch
        ? activeGesture.startItem.x + (changedTouch.clientX - activeGesture.startTouches[0].clientX) / boardRect.width
        : activeGesture.startItem.x;
      const fallbackY = changedTouch
        ? activeGesture.startItem.y + (changedTouch.clientY - activeGesture.startTouches[0].clientY) / boardRect.height
        : activeGesture.startItem.y;
      this.replaceItem({
        ...activeGesture.startItem,
        x: finalMove?.x ?? fallbackX,
        y: finalMove?.y ?? fallbackY,
      });
    } else {
      this.flushItemTransform();
    }
    track('memory_collage_sticker_transform', { operation: activeGesture.mode });
    gesture = null;
    pendingNativeMove = null;
    if (this.data.draggingItemId || this.data.transformingItemId) {
      this.setData({ draggingItemId: '', transformingItemId: '' });
    }
  },

  createGesture(mode: 'move' | 'transform', item: MemoryCollageItem, touches: TouchPoint[]): GestureState {
    const centerX = (boardRect?.left ?? 0) + item.x * (boardRect?.width ?? 1);
    const centerY = (boardRect?.top ?? 0) + item.y * (boardRect?.height ?? 1);
    const first = touches[0];
    return {
      mode,
      itemId: item.itemId,
      startItem: { ...item },
      startTouches: touches,
      startDistance: touches.length >= 2
        ? distance(touches[0], touches[1])
        : Math.hypot(first.clientX - centerX, first.clientY - centerY),
      startAngle: touches.length >= 2
        ? angle(touches[0], touches[1])
        : Math.atan2(first.clientY - centerY, first.clientX - centerX) * 180 / Math.PI,
      centerX,
      centerY,
    };
  },

  replaceItem(nextItem: MemoryCollageItem, callback?: () => void) {
    const safeItem = clampMemoryCollageTransformToBounds(nextItem, this.data.editableBounds);
    const index = this.data.items.findIndex((item) => item.itemId === safeItem.itemId);
    if (index < 0) return;
    const current = this.data.items[index];
    const item: EditorItem = {
      ...safeItem,
      displayPath: current.displayPath,
      ...editorItemGeometry(safeItem, this.data.editableBounds),
    };
    this.setData({ [`items[${index}]`]: item }, callback);
    this.markDirty();
  },

  queueItemTransform(nextItem: MemoryCollageItem) {
    pendingTransform = nextItem;
    const remaining = TRANSFORM_UPDATE_INTERVAL_MS - (Date.now() - lastTransformUpdateAt);
    if (remaining <= 0 && !transformUpdateTimer) {
      this.flushItemTransform();
      return;
    }
    if (transformUpdateTimer) return;
    transformUpdateTimer = setTimeout(() => {
      transformUpdateTimer = null;
      this.flushItemTransform();
    }, Math.max(0, remaining));
  },

  flushItemTransform() {
    if (transformUpdateTimer) clearTimeout(transformUpdateTimer);
    transformUpdateTimer = null;
    if (!pendingTransform || transformUpdateInFlight) return;
    const nextItem = pendingTransform;
    pendingTransform = null;
    lastTransformUpdateAt = Date.now();
    transformUpdateInFlight = true;
    this.replaceItem(nextItem, () => {
      transformUpdateInFlight = false;
      if (pendingTransform) this.queueItemTransform(pendingTransform);
    });
  },

  deleteItem(event: WechatMiniprogram.TouchEvent) {
    const itemId = String(event.currentTarget.dataset.id ?? this.data.selectedItemId ?? '');
    if (!itemId) return;
    if (gesture?.itemId === itemId) gesture = null;
    const items = this.data.items.filter((item) => item.itemId !== itemId);
    if (items.length === this.data.items.length) return;
    this.updateItems(items, '');
    track('memory_collage_sticker_delete', { itemCount: items.length });
  },

  copySelected() {
    const selected = this.data.items.find((item) => item.itemId === this.data.selectedItemId);
    if (!selected) return;
    if (this.data.items.length >= MAX_MEMORY_COLLAGE_ITEMS) {
      wx.showToast({ title: '最多添加 20 个贴纸', icon: 'none' });
      return;
    }
    const copy = clampMemoryCollageTransformToBounds({
      ...selected,
      itemId: createId('draft_item'),
      x: selected.x + 0.04,
      y: selected.y + 0.04,
      zIndex: this.nextZIndex(),
    }, this.data.editableBounds);
    this.addItem(copy);
  },

  sendSelectedToBack() {
    this.reorderSelected(false);
  },

  bringSelectedToFront() {
    this.reorderSelected(true);
  },

  reorderSelected(toFront: boolean) {
    const selected = this.data.items.find((item) => item.itemId === this.data.selectedItemId);
    if (!selected) return;
    const items = reorderMemoryCollageItem(this.data.items, selected.itemId, toFront);
    this.updateItems(styledItems(items), selected.itemId);
    track('memory_collage_sticker_layer_change', { operation: toFront ? 'front' : 'back' });
  },

  requestClear() {
    if (this.data.loading || !this.data.items.length) return;
    this.openDialog('clear', '清空画板', '清空后需要重新添加贴纸，确定清空吗？', '清空');
  },

  saveEditor() {
    if (this.data.loading || this.data.saving) return;
    void this.persist(false);
  },

  async persist(force: boolean) {
    if (this.data.saving) return;
    this.setData({ saving: true, dialogOpen: false });
    track('memory_collage_save_start', { itemCount: this.data.items.length });
    const startedAt = Date.now();
    try {
      const view = await saveMemoryCollage({
        ...(this.data.moduleId ? { moduleId: this.data.moduleId } : {}),
        reportMode: this.data.reportMode,
        periodKey: this.data.periodKey,
        ...(this.data.boardAssetId && this.data.boardAssetId !== DEFAULT_BOARD_ASSET_ID
          ? { boardAssetId: this.data.boardAssetId }
          : {}),
        baseVersion: this.data.version,
        force,
        items: this.data.items.map((item) => ({
          assetType: item.assetType,
          ...(item.recordId ? { recordId: item.recordId } : {}),
          ...(item.stickerAssetId ? { stickerAssetId: item.stickerAssetId } : {}),
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          rotation: item.rotation,
          zIndex: item.zIndex,
        })),
      });
      this.setData({ saving: false, dirty: false, version: view.collage?.version ?? this.data.version });
      this.disableLeaveAlert();
      wx.setStorageSync('notemylife.memory.collage.saved', true);
      wx.showToast({ title: '回忆已保存', icon: 'success' });
      track('memory_collage_save_success', { itemCount: this.data.items.length, durationMs: Date.now() - startedAt });
      setTimeout(() => wx.navigateBack(), 350);
    } catch (error) {
      this.setData({ saving: false });
      const code = String((error as Error & { code?: string }).code ?? (error as Error).message ?? 'UNKNOWN');
      track('memory_collage_save_fail', { errorCode: code });
      if (code === 'COLLAGE_VERSION_CONFLICT') {
        this.openDialog('conflict', '作品已更新', '这张回忆已在其他设备保存。可以重新加载最新版本，或用当前画板覆盖。', '覆盖保存', true, '重新加载');
      } else {
        this.openDialog('save-error', '保存失败', '当前编辑内容仍然保留，请检查网络后重试。', '知道了', false);
      }
    }
  },

  requestExport() {
    if (this.data.loading || this.data.exporting) return;
    if (this.data.dirty) {
      this.openDialog('export', '导出当前画板', '导出不会自动保存本次修改。', '继续导出');
      return;
    }
    void this.exportCard();
  },

  async exportCard() {
    this.setData({ exporting: true, dialogOpen: false });
    wx.showLoading({ title: '正在生成回忆' });
    const startedAt = Date.now();
    try {
      const sources = [this.data.boardImagePath || BOARD_TEXTURE, ...this.data.items.map((item) => item.imagePath)];
      const paths = await Promise.all(sources.map(canvasImagePath));
      const context = wx.createCanvasContext('collageEditorExportCanvas', this);
      if (this.data.boardImagePath) {
        context.clearRect(0, 0, 900, 900);
        if (this.data.boardUsesSourceFrame) {
          context.drawImage(
            paths[0],
            MEMORY_COLLAGE_BOARD_SOURCE_FRAME.left * 1024,
            MEMORY_COLLAGE_BOARD_SOURCE_FRAME.top * 1024,
            (MEMORY_COLLAGE_BOARD_SOURCE_FRAME.right - MEMORY_COLLAGE_BOARD_SOURCE_FRAME.left) * 1024,
            (MEMORY_COLLAGE_BOARD_SOURCE_FRAME.bottom - MEMORY_COLLAGE_BOARD_SOURCE_FRAME.top) * 1024,
            0,
            0,
            900,
            900,
          );
        } else if (this.data.boardAssetId === DEFAULT_BOARD_ASSET_ID) {
          context.drawImage(
            paths[0],
            DEFAULT_BOARD_SOURCE_FRAME.left,
            DEFAULT_BOARD_SOURCE_FRAME.top,
            DEFAULT_BOARD_SOURCE_FRAME.width,
            DEFAULT_BOARD_SOURCE_FRAME.height,
            0,
            0,
            900,
            900,
          );
        } else {
          context.drawImage(paths[0], 0, 0, 900, 900);
        }
      } else {
        context.setFillStyle(FALLBACK_BOARD_COLOR);
        context.fillRect(0, 0, 900, 900);
        context.setGlobalAlpha(.28);
        context.drawImage(paths[0], 0, 0, 900, 900);
        context.setGlobalAlpha(1);
      }
      [...this.data.items].sort((left, right) => left.zIndex - right.zIndex).forEach((item, index) => {
        const width = item.width * 900;
        const height = item.height * 900;
        context.save();
        context.translate(item.x * 900, item.y * 900);
        context.rotate(item.rotation * Math.PI / 180);
        drawStickerWithOutline(context, paths[index + 1], -width / 2, -height / 2, width, height);
        context.restore();
      });
      await new Promise<void>((resolve) => context.draw(false, resolve));
      const tempFilePath = await new Promise<string>((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'collageEditorExportCanvas',
          width: 900,
          height: 900,
          destWidth: 1800,
          destHeight: 1800,
          fileType: 'png',
          success: ({ tempFilePath: path }) => resolve(path),
          fail: reject,
        }, this);
      });
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({
        filePath: tempFilePath,
        success: () => resolve(),
        fail: reject,
      }));
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showToast({ title: '已保存到相册' });
      track('memory_collage_export_success', { itemCount: this.data.items.length, durationMs: Date.now() - startedAt });
    } catch {
      wx.hideLoading();
      this.setData({ exporting: false });
      this.openDialog('export-settings', '无法保存到相册', '请确认已允许照片权限后重试。', '去设置');
    }
  },

  closeEditor() {
    if (this.data.dirty) {
      this.openDialog('exit', '放弃本次修改？', '离开后，本次未保存的画板调整将不会保留。', '放弃修改');
      return;
    }
    this.disableLeaveAlert();
    wx.navigateBack();
  },

  openDialog(
    dialogType: DialogType,
    dialogTitle: string,
    dialogMessage: string,
    dialogConfirmText: string,
    dialogShowCancel = true,
    dialogCancelText = '继续编辑',
  ) {
    this.setData({
      dialogOpen: true,
      dialogType,
      dialogTitle,
      dialogMessage,
      dialogConfirmText,
      dialogShowCancel,
      dialogCancelText,
    });
  },

  cancelDialog() {
    const type = this.data.dialogType;
    this.setData({ dialogOpen: false, dialogType: '' });
    if (type === 'conflict') void this.loadEditor();
  },

  confirmDialog() {
    const type = this.data.dialogType;
    this.setData({ dialogOpen: false, dialogType: '' });
    if (type === 'clear') {
      this.updateItems([], '');
      track('memory_collage_clear', { itemCount: 0 });
    } else if (type === 'exit') {
      track('memory_collage_exit_abandon', { itemCount: this.data.items.length });
      this.disableLeaveAlert();
      wx.navigateBack();
    } else if (type === 'conflict') {
      void this.persist(true);
    } else if (type === 'export') {
      void this.exportCard();
    } else if (type === 'export-settings') {
      void wx.openSetting({});
    } else if (type === 'load-error') {
      wx.navigateBack();
    }
  },

  updateItems(items: EditorItem[], selectedItemId: string) {
    const normalized = styledItems(
      normalizeMemoryCollageLayers(items),
      this.data.decorativeStickers,
      this.data.editableBounds,
    );
    this.setData({
      items: normalized,
      selectedItemId,
      recordStickers: this.presentRecordStickers(this.data.recordStickers, normalized),
      collageItemCount: normalized.length,
    });
    this.markDirty();
  },

  presentRecordStickers(stickers: MemoryStickerItem[], items: MemoryCollageItem[]): EditorRecordSticker[] {
    const added = new Set(items.flatMap((item) => item.recordId ? [item.recordId] : []));
    return stickers.map((sticker) => ({
      recordId: sticker.recordId,
      moduleId: sticker.moduleId,
      recordDate: sticker.recordDate,
      stickerPath: sticker.stickerPath,
      displayOrder: sticker.displayOrder,
      added: added.has(sticker.recordId),
      dateLabel: shortMemoryRecordDate(sticker.recordDate),
    }));
  },

  nextZIndex(): number {
    return this.data.items.reduce((maximum, item) => Math.max(maximum, item.zIndex), -1) + 1;
  },

  markDirty() {
    if (this.data.dirty) return;
    this.setData({ dirty: true });
    const api = wx as typeof wx & { enableAlertBeforeUnload?: (options: { message: string }) => void };
    api.enableAlertBeforeUnload?.({ message: '当前画板还没有保存，确定离开吗？' });
  },

  disableLeaveAlert() {
    const api = wx as typeof wx & { disableAlertBeforeUnload?: () => void };
    api.disableAlertBeforeUnload?.();
  },

  stopPropagation() {},
});
