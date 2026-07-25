import { getMemoryView, type MemoryModuleOption } from '../../services/api';
import { track } from '../../services/tracker';
import { monthLabel, monthOf, nextMonth, previousMonth, shanghaiDate } from '../../utils/date';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { drawStickerWithOutline } from '../../utils/sticker-outline';
import { hasOpenBottomSheet } from '../../utils/tab-bar-visibility';

interface AnimatedSticker { id: string; path: string; popDelay: number }
let timers: Array<ReturnType<typeof setTimeout>> = [];
let showToken = 0;
const clearTimers = () => { timers.forEach((timer) => clearTimeout(timer)); timers = []; };

Page({
  data: {
    month: monthOf(shanghaiDate()), monthLabel: '', moduleId: '', moduleName: '', modules: [] as MemoryModuleOption[],
    recordedDays: 0, moduleCount: 0, recordCount: 0, jointCompleted: 0, weeklyJointCompleted: 0, streakDays: 0,
    receivedReactions: 0, weeklyReceivedReactions: 0, mostUsedEmoji: '—', stickers: [] as AnimatedSticker[], stickerPhase: 'sticker-hidden',
    stickerFinalDelay: 0, selectionOpen: false, selectionClosing: false, exporting: false,
  },
  onShow() {
    const token = ++showToken;
    this.syncTabBarVisibility();
    clearTimers();
    const selection = wx.getStorageSync('notemylife.memory.selection') as { moduleId?: string; month?: string } | undefined;
    if (selection?.moduleId) {
      this.setData({ moduleId: selection.moduleId, month: selection.month ?? this.data.month });
      wx.removeStorageSync('notemylife.memory.selection');
    }
    void Promise.all([this.load(), waitForAppRouteDone()]).then(() => { if (token === showToken) this.playStickerAnimation(); });
  },
  syncTabBarVisibility() {
    this.getTabBar?.()?.setData({
      selected: 1,
      hidden: hasOpenBottomSheet(this.data.selectionOpen),
    });
  },
  async load(forceChange = false) {
    try {
      const view = await getMemoryView(this.data.moduleId || undefined, this.data.month, forceChange);
      const plan = createStickerDelays(view.items.map((item) => item.recordId));
      this.setData({
        month: view.month, monthLabel: monthLabel(view.month), moduleId: view.moduleId, moduleName: view.moduleName, modules: view.modules,
        recordedDays: view.recordedDays, moduleCount: view.participatedModuleCount, recordCount: view.weeklyRecordCount,
        jointCompleted: view.monthlyJointCompletedDays, weeklyJointCompleted: view.jointCompletedDays, streakDays: view.currentStreakDays,
        receivedReactions: view.monthlyReceivedReactionCount, weeklyReceivedReactions: view.receivedReactionCount, mostUsedEmoji: view.mostUsedEmoji,
        stickers: view.items.map((item) => ({ id: item.recordId, path: item.stickerPath, popDelay: plan.delays.get(item.recordId) ?? 0 })),
        stickerFinalDelay: plan.finalDelay, stickerPhase: 'sticker-hidden',
      });
    } catch { this.setData({ stickers: [], moduleId: '', moduleName: '' }); }
  },
  changeGroup() { clearTimers(); void this.load(true).then(() => this.playStickerAnimation()); track('memory_change_group_click', { moduleId: this.data.moduleId, month: this.data.month }); },
  playStickerAnimation() {
    timers.push(setTimeout(() => this.setData({ stickerPhase: 'sticker-entering' }), STICKER_MOTION.pageSettledDelay));
    timers.push(setTimeout(() => this.setData({ stickerPhase: 'sticker-visible' }), STICKER_MOTION.pageSettledDelay + this.data.stickerFinalDelay + STICKER_MOTION.duration));
  },
  openSelection() {
    this.setData({ selectionOpen: true, selectionClosing: false }, () => this.syncTabBarVisibility());
  },
  async dismissSelection() {
    if (!this.data.selectionOpen || this.data.selectionClosing) return;
    this.setData({ selectionClosing: true });
    await waitForSheetMotion();
    if (!this.data.selectionClosing) return;
    this.setData({ selectionOpen: false, selectionClosing: false });
    this.syncTabBarVisibility();
  },
  closeSelection() { void this.dismissSelection(); },
  stopPropagation() {},
  async selectModule(event: WechatMiniprogram.TouchEvent) {
    this.setData({ moduleId: event.currentTarget.dataset.id as string });
    await this.dismissSelection();
    void this.load().then(() => this.playStickerAnimation());
  },
  previousMonth() { this.setData({ month: previousMonth(this.data.month) }, () => void this.load().then(() => this.playStickerAnimation())); },
  nextMonth() { const target = nextMonth(this.data.month); if (target > monthOf(shanghaiDate())) return; this.setData({ month: target }, () => void this.load().then(() => this.playStickerAnimation())); },
  onHide() { showToken += 1; clearTimers(); },
  onUnload() { showToken += 1; clearTimers(); },
  saveCard() {
    if (this.data.exporting || !this.data.moduleId) return;
    this.setData({ exporting: true }); wx.showLoading({ title: '正在生成卡片' });
    const context = wx.createCanvasContext('memoryExportCanvas', this);
    context.setFillStyle('#f9f8f3'); context.fillRect(0, 0, 750, 1000);
    context.setFillStyle('#c99491'); context.setFontSize(36); context.fillText('RECORD', 64, 100);
    context.setFillStyle('#5f5851'); context.setFontSize(32); context.fillText(this.data.moduleName, 64, 154);
    context.setFillStyle('#9b9188'); context.setFontSize(24); context.fillText(this.data.monthLabel, 64, 194);
    this.data.stickers.forEach((sticker, index) => drawStickerWithOutline(
      context,
      sticker.path,
      54 + (index % 4) * 166,
      250 + Math.floor(index / 4) * 250,
      144,
      196,
    ));
    context.setFillStyle('#766e67'); context.setFontSize(24); context.fillText(`共同完成 ${this.data.jointCompleted} 天  ·  收到回应 ${this.data.receivedReactions} 次`, 64, 815);
    context.setFillStyle('#b9a9a0'); context.setFontSize(20); context.fillText('NoteMyLife · 记录我的一辈子', 64, 920);
    context.draw(false, () => wx.canvasToTempFilePath({ canvasId: 'memoryExportCanvas', width: 750, height: 1000, destWidth: 1500, destHeight: 2000,
      success: ({ tempFilePath }) => wx.saveImageToPhotosAlbum({ filePath: tempFilePath,
        success: () => { wx.hideLoading(); this.setData({ exporting: false }); wx.showToast({ title: '已保存到相册' }); track('memory_export_success', { moduleId: this.data.moduleId, month: this.data.month }); },
        fail: () => { wx.hideLoading(); this.setData({ exporting: false }); wx.showModal({ title: '无法保存到相册', content: '请在系统设置中允许照片权限后重试。', confirmText: '去设置', success: ({ confirm }) => { if (confirm) void wx.openSetting({}); } }); },
      }), fail: () => { wx.hideLoading(); this.setData({ exporting: false }); wx.showToast({ title: '卡片生成失败', icon: 'none' }); } }, this));
  },
});
