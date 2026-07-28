import type { GalleryItem, GalleryView } from '../../services/api';
import { loadModuleGalleryCached } from '../../services/gallery-cache';
import { track } from '../../services/tracker';
import { monthLabel, monthOf, nextMonth, previousMonth, shanghaiDate } from '../../utils/date';
import { preloadImageSources } from '../../utils/image-preload';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { drawStickerWithOutline, fitStickerWithin } from '../../utils/sticker-outline';

const STICKER_PREVIEW_WIDTH = 750;
const STICKER_PREVIEW_HEIGHT = 1000;
const STICKER_PREVIEW_PADDING = 40;

interface AnimatedGalleryItem extends GalleryItem {
  popDelay: number;
}

type AnimatedGalleryView = Omit<GalleryView, 'items'> & { items: AnimatedGalleryItem[] };

let galleryTimers: Array<ReturnType<typeof setTimeout>> = [];
let galleryLoadToken = 0;
const galleryCache = new Map<string, GalleryView>();

const galleryCacheKey = (moduleId: string, month: string) => `${moduleId}:${month}`;
const clearGalleryTimers = () => {
  galleryTimers.forEach((timer) => clearTimeout(timer));
  galleryTimers = [];
};

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
    if (this.data.initialShowPending) {
      this.setData({ initialShowPending: false });
      return;
    }
    if (this.data.view) void this.playStickerAnimation(true);
    else void this.load();
  },
  onHide() {
    clearGalleryTimers();
    if (this.data.view) this.setData({ stickerPhase: 'sticker-visible' });
  },
  onUnload() {
    galleryLoadToken += 1;
    clearGalleryTimers();
  },
  async load() {
    const token = ++galleryLoadToken;
    clearGalleryTimers();
    const key = galleryCacheKey(this.data.moduleId, this.data.month);
    const cached = galleryCache.get(key);
    if (!cached) this.setData({ loading: true });
    try {
      const view = cached ?? await loadModuleGalleryCached(this.data.moduleId, this.data.month);
      if (token !== galleryLoadToken) return;
      galleryCache.set(key, view);
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
        canNext: this.data.month < monthOf(shanghaiDate()),
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
  async playStickerAnimation(waitForRoute = false) {
    clearGalleryTimers();
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
  previousMonth() { this.setData({ month: previousMonth(this.data.month), selected: null }, () => void this.load()); },
  nextMonth() {
    const target = nextMonth(this.data.month);
    if (target > monthOf(shanghaiDate())) return;
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
