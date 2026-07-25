import { getModuleGallery, type GalleryItem, type GalleryView } from '../../services/api';
import { track } from '../../services/tracker';
import { monthLabel, monthOf, nextMonth, previousMonth, shanghaiDate } from '../../utils/date';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { drawStickerWithOutline, fitStickerWithin } from '../../utils/sticker-outline';

const STICKER_PREVIEW_WIDTH = 750;
const STICKER_PREVIEW_HEIGHT = 1000;
const STICKER_PREVIEW_PADDING = 40;

Page({
  data: {
    statusBarHeight: 24,
    moduleId: '',
    month: monthOf(shanghaiDate()),
    monthLabel: monthLabel(monthOf(shanghaiDate())),
    loading: true,
    view: null as GalleryView | null,
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
  },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true });
    try {
      const view = await getModuleGallery(this.data.moduleId, this.data.month);
      this.setData({ view, loading: false, monthLabel: monthLabel(this.data.month), canNext: this.data.month < monthOf(shanghaiDate()) });
    } catch {
      this.setData({ loading: false });
      wx.showToast({ title: '图片合集加载失败', icon: 'none' });
    }
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
    void wx.redirectTo({ url: `/pages/module-detail/index?moduleId=${this.data.moduleId}&date=${selected.recordDate}` });
  },
});
