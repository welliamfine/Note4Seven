import type { GalleryItem, GalleryView } from '../../services/api';
import { invalidateModuleGallery, loadModuleGalleryCached } from '../../services/gallery-cache';
import { track } from '../../services/tracker';
import { monthLabel, monthOf, nextMonth, previousMonth, shanghaiDate } from '../../utils/date';
import { imageSourceIdentity, preloadImageSources } from '../../utils/image-preload';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { RECORD_DATE_MAX, RECORD_DATE_MIN } from '../../utils/record-policy';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { drawStickerWithOutline, fitStickerWithin } from '../../utils/sticker-outline';

const STICKER_PREVIEW_WIDTH = 750;
const STICKER_PREVIEW_HEIGHT = 1000;
const STICKER_PREVIEW_PADDING = 40;
const GALLERY_SYNC_INTERVAL = 5_000;

interface AnimatedGalleryItem extends GalleryItem {
  popDelay: number;
  syncPhase?: string;
}

type AnimatedGalleryView = Omit<GalleryView, 'items'> & { items: AnimatedGalleryItem[] };

let galleryTimers: Array<ReturnType<typeof setTimeout>> = [];
let galleryLoadToken = 0;
let gallerySyncTimer: ReturnType<typeof setInterval> | undefined;
let gallerySyncGeneration = 0;
let gallerySyncInFlight = false;
let galleryPageVisible = false;

const clearGalleryTimers = () => {
  galleryTimers.forEach((timer) => clearTimeout(timer));
  galleryTimers = [];
};

const sameGalleryItem = (left: GalleryItem, right: GalleryItem) => left.recordId === right.recordId
  && left.recordDate === right.recordDate
  && left.memberInstanceId === right.memberInstanceId
  && left.displayName === right.displayName
  && left.avatarText === right.avatarText
  && left.avatarColor === right.avatarColor
  && imageSourceIdentity(left.avatarUrl ?? '') === imageSourceIdentity(right.avatarUrl ?? '')
  && left.isAnonymousExitedMember === right.isAnonymousExitedMember
  && left.remark === right.remark
  && imageSourceIdentity(left.stickerPath) === imageSourceIdentity(right.stickerPath)
  && imageSourceIdentity(left.originalPath) === imageSourceIdentity(right.originalPath);

const sameGalleryView = (left: AnimatedGalleryView, right: GalleryView) => left.moduleId === right.moduleId
  && left.moduleName === right.moduleName
  && left.recordPolicy === right.recordPolicy
  && left.month === right.month
  && left.items.length === right.items.length
  && left.items.every((item, index) => sameGalleryItem(item, right.items[index]));

Page({
  data: {
    statusBarHeight: 24,
    moduleId: '',
    month: monthOf(shanghaiDate()),
    monthLabel: monthLabel(monthOf(shanghaiDate())),
    loading: true,
    initialShowPending: true,
    view: null as AnimatedGalleryView | null,
    stickerPhase: 'sticker-hidden',
    stickerFinalDelay: 0,
    selected: null as GalleryItem | null,
    previewClosing: false,
    previewingSticker: false,
    canNext: false,
  },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      moduleId: query.moduleId ?? '',
      month: query.month ?? monthOf(shanghaiDate()),
      monthLabel: monthLabel(query.month ?? monthOf(shanghaiDate())),
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
    });
    void this.load();
  },
  onShow() {
    galleryPageVisible = true;
    if (this.data.initialShowPending) {
      this.setData({ initialShowPending: false });
      this.startGallerySync();
      return;
    }
    this.startGallerySync(true);
    if (this.data.view) void this.playStickerAnimation(true);
    else void this.load();
  },
  onHide() {
    galleryPageVisible = false;
    this.stopGallerySync();
    clearGalleryTimers();
    this.finishSyncedStickerAnimation();
    if (this.data.view) this.setData({ stickerPhase: 'sticker-visible' });
  },
  onUnload() {
    galleryPageVisible = false;
    this.stopGallerySync();
    galleryLoadToken += 1;
    clearGalleryTimers();
  },
  async load() {
    const token = ++galleryLoadToken;
    clearGalleryTimers();
    this.setData({ loading: true });
    try {
      const view = await loadModuleGalleryCached(this.data.moduleId, this.data.month);
      if (token !== galleryLoadToken) return;
      const plan = createStickerDelays(view.items.map((item) => item.recordId));
      const animatedView: AnimatedGalleryView = {
        ...view,
        items: view.items.map((item) => ({
          ...item,
          popDelay: plan.delays.get(item.recordId) ?? 0,
        })),
      };
      this.setData({
        view: animatedView,
        loading: false,
        stickerPhase: 'sticker-hidden',
        stickerFinalDelay: plan.finalDelay,
        monthLabel: monthLabel(this.data.month),
        canNext: this.data.month < (view.recordPolicy === 'relaxed' ? RECORD_DATE_MAX.slice(0, 7) : monthOf(shanghaiDate())),
      });
      await preloadImageSources(view.items.map((item) => item.stickerPath), 2_500);
      if (token !== galleryLoadToken) return;
      await this.playStickerAnimation();
    } catch {
      if (token !== galleryLoadToken) return;
      this.setData({ loading: false });
      wx.showToast({ title: '图片合集加载失败', icon: 'none' });
    }
  },
  startGallerySync(immediate = false) {
    this.stopGallerySync(false);
    gallerySyncTimer = setInterval(() => void this.syncGalleryInBackground(), GALLERY_SYNC_INTERVAL);
    if (immediate) void this.syncGalleryInBackground();
  },
  stopGallerySync(invalidate = true) {
    if (gallerySyncTimer) clearInterval(gallerySyncTimer);
    gallerySyncTimer = undefined;
    if (invalidate) gallerySyncGeneration += 1;
  },
  async syncGalleryInBackground() {
    if (gallerySyncInFlight || !galleryPageVisible || this.data.loading || !this.data.view) return;
    gallerySyncInFlight = true;
    const generation = gallerySyncGeneration;
    const moduleId = this.data.moduleId;
    const month = this.data.month;
    try {
      invalidateModuleGallery(moduleId, month);
      const view = await loadModuleGalleryCached(moduleId, month);
      if (generation !== gallerySyncGeneration
        || !galleryPageVisible
        || moduleId !== this.data.moduleId
        || month !== this.data.month
        || !this.data.view
        || sameGalleryView(this.data.view, view)) return;

      const existingItems = new Map(this.data.view.items.map((item) => [item.recordId, item]));
      const changedStickerIds = new Set(view.items
        .filter((item) => {
          const existing = existingItems.get(item.recordId);
          return !existing || imageSourceIdentity(existing.stickerPath) !== imageSourceIdentity(item.stickerPath);
        })
        .map((item) => item.recordId));
      await preloadImageSources(
        view.items.filter((item) => changedStickerIds.has(item.recordId)).map((item) => item.stickerPath),
        2_500,
      );
      if (generation !== gallerySyncGeneration
        || !galleryPageVisible
        || moduleId !== this.data.moduleId
        || month !== this.data.month) return;

      const plan = createStickerDelays(view.items.map((item) => item.recordId));
      const animatedView: AnimatedGalleryView = {
        ...view,
        items: view.items.map((item) => {
          const existing = existingItems.get(item.recordId);
          if (existing && sameGalleryItem(existing, item)) return existing;
          return {
            ...item,
            popDelay: existing?.popDelay ?? plan.delays.get(item.recordId) ?? 0,
            syncPhase: changedStickerIds.has(item.recordId) ? 'sticker-hidden' : '',
          };
        }),
      };
      const selectedId = this.data.selected?.recordId;
      this.setData({
        view: animatedView,
        selected: selectedId ? animatedView.items.find((item) => item.recordId === selectedId) ?? null : null,
        stickerFinalDelay: plan.finalDelay,
      });
      this.playSyncedStickerAnimation(animatedView.items
        .map((item, index) => (changedStickerIds.has(item.recordId) ? index : -1))
        .filter((index) => index >= 0));
    } catch {
      // Keep the rendered gallery when a background reconciliation fails.
    } finally {
      gallerySyncInFlight = false;
    }
  },
  playSyncedStickerAnimation(indexes: number[]) {
    if (!indexes.length) return;
    galleryTimers.push(setTimeout(() => {
      const patch = indexes.reduce<Record<string, unknown>>((updates, index) => {
        updates[`view.items[${index}].syncPhase`] = 'sticker-entering';
        return updates;
      }, {});
      this.setData(patch);
    }, STICKER_MOTION.pageSettledDelay));
    galleryTimers.push(setTimeout(() => {
      const patch = indexes.reduce<Record<string, unknown>>((updates, index) => {
        updates[`view.items[${index}].syncPhase`] = '';
        return updates;
      }, {});
      this.setData(patch);
    }, STICKER_MOTION.pageSettledDelay + STICKER_MOTION.duration));
  },
  finishSyncedStickerAnimation() {
    if (!this.data.view) return;
    const patch = this.data.view.items.reduce<Record<string, unknown>>((updates, item, index) => {
      if (item.syncPhase) updates[`view.items[${index}].syncPhase`] = '';
      return updates;
    }, {});
    if (Object.keys(patch).length) this.setData(patch);
  },
  async playStickerAnimation(waitForRoute = false) {
    clearGalleryTimers();
    this.finishSyncedStickerAnimation();
    this.setData({ stickerPhase: 'sticker-hidden' });
    if (waitForRoute) await waitForAppRouteDone(180);
    galleryTimers.push(setTimeout(
      () => this.setData({ stickerPhase: 'sticker-entering' }),
      STICKER_MOTION.pageSettledDelay,
    ));
    galleryTimers.push(setTimeout(
      () => this.setData({ stickerPhase: 'sticker-visible' }),
      STICKER_MOTION.pageSettledDelay + this.data.stickerFinalDelay + STICKER_MOTION.duration,
    ));
  },
  goBack() { void wx.navigateBack(); },
  previousMonth() {
    const target = previousMonth(this.data.month);
    if (target < RECORD_DATE_MIN.slice(0, 7)) return;
    this.setData({ month: target, selected: null }, () => void this.load());
  },
  nextMonth() {
    const target = nextMonth(this.data.month);
    const maximumMonth = this.data.view?.recordPolicy === 'relaxed'
      ? RECORD_DATE_MAX.slice(0, 7)
      : monthOf(shanghaiDate());
    if (target > maximumMonth) return;
    this.setData({ month: target, selected: null }, () => void this.load());
  },
  selectItem(event: WechatMiniprogram.TouchEvent) {
    const recordId = event.currentTarget.dataset.id as string;
    const selected = this.data.view?.items.find((item) => item.recordId === recordId) ?? null;
    this.setData({ selected, previewClosing: false });
    if (selected) track('gallery_item_click', { moduleId: this.data.moduleId, recordId, recordDate: selected.recordDate });
  },
  async dismissPreview() {
    if (!this.data.selected || this.data.previewClosing) return;
    this.setData({ previewClosing: true });
    await waitForSheetMotion();
    if (!this.data.previewClosing) return;
    this.setData({ selected: null, previewClosing: false });
  },
  closePreview() { void this.dismissPreview(); },
  stopPropagation() {},
  previewOriginal() {
    const selected = this.data.selected;
    if (!selected || this.data.previewingSticker) return;
    this.setData({ previewingSticker: true });
    wx.showLoading({ title: '正在准备贴纸' });
    wx.getImageInfo({
      src: selected.stickerPath,
      success: ({ width, height, path }) => {
        const context = wx.createCanvasContext('stickerPreviewCanvas', this);
        const rect = fitStickerWithin(
          width,
          height,
          STICKER_PREVIEW_WIDTH,
          STICKER_PREVIEW_HEIGHT,
          STICKER_PREVIEW_PADDING,
        );
        context.clearRect(0, 0, STICKER_PREVIEW_WIDTH, STICKER_PREVIEW_HEIGHT);
        drawStickerWithOutline(context, path, rect.x, rect.y, rect.width, rect.height, 16);
        context.draw(false, () => {
          wx.canvasToTempFilePath({
            canvasId: 'stickerPreviewCanvas',
            width: STICKER_PREVIEW_WIDTH,
            height: STICKER_PREVIEW_HEIGHT,
            destWidth: STICKER_PREVIEW_WIDTH * 2,
            destHeight: STICKER_PREVIEW_HEIGHT * 2,
            fileType: 'png',
            quality: 1,
            success: ({ tempFilePath }) => {
              wx.hideLoading();
              this.setData({ previewingSticker: false });
              wx.previewImage({ current: tempFilePath, urls: [tempFilePath] });
            },
            fail: () => this.handleStickerPreviewFailure(),
          }, this);
        });
      },
      fail: () => this.handleStickerPreviewFailure(),
    });
  },
  handleStickerPreviewFailure() {
    wx.hideLoading();
    this.setData({ previewingSticker: false });
    wx.showToast({ title: '贴纸预览失败，请重试', icon: 'none' });
  },
  async openDate() {
    const selected = this.data.selected;
    if (!selected) return;
    await this.dismissPreview();
    void wx.redirectTo({ url: `/subpackages/module-detail/index?moduleId=${this.data.moduleId}&date=${selected.recordDate}` });
  },
});
