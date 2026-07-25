import type { InvitePreview } from '../../services/api';
import { createModuleInvite } from '../../services/api';
import { track } from '../../services/tracker';

let countdownTimer: ReturnType<typeof setInterval> | undefined;

const INVITE_CARD_WIDTH = 750;
const INVITE_CARD_HEIGHT = 1000;

const compactText = (value: string, maximumLength: number): string => (
  value.length > maximumLength ? `${value.slice(0, maximumLength)}...` : value
);

const drawRoundedRect = (
  context: WechatMiniprogram.CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
};

const drawInviteCard = (
  context: WechatMiniprogram.CanvasContext,
  preview: InvitePreview,
  countdown: string,
) => {
  context.setFillStyle('#f9f8f3');
  context.fillRect(0, 0, INVITE_CARD_WIDTH, INVITE_CARD_HEIGHT);

  drawRoundedRect(context, 50, 46, 650, 908, 46);
  context.setFillStyle('#fffdf9');
  context.fill();

  context.setTextAlign('center');
  context.setFillStyle('#c4a58e');
  context.setFontSize(30);
  context.fillText('NoteMyLife', 375, 116);

  context.setFillStyle('#514b45');
  context.setFontSize(42);
  context.fillText(compactText(preview.module.name, 14), 375, 194);
  context.setFillStyle('#817a72');
  context.setFontSize(24);
  context.fillText(compactText(preview.module.description || '一起认真记录生活里的小事', 24), 375, 242);

  context.setStrokeStyle('rgba(110,98,87,.12)');
  context.setLineWidth(1);
  context.beginPath();
  context.moveTo(112, 286);
  context.lineTo(638, 286);
  context.stroke();

  context.setFillStyle(preview.inviter.avatarColor);
  context.beginPath();
  context.arc(280, 352, 42, 0, Math.PI * 2);
  context.fill();
  context.setFillStyle('#ffffff');
  context.setFontSize(30);
  context.fillText(preview.inviter.avatarText, 280, 363);

  context.setTextAlign('left');
  context.setFillStyle('#514b45');
  context.setFontSize(28);
  context.fillText(compactText(preview.inviter.nickname, 10), 344, 345);
  context.setFillStyle('#8e877f');
  context.setFontSize(21);
  context.fillText('邀请你一起记录', 344, 380);

  context.setTextAlign('center');
  context.setFillStyle('#5f5851');
  context.setFontSize(28);
  context.fillText(`${preview.memberCount}/${preview.memberLimit} 人`, 240, 456);
  context.fillText(countdown, 510, 456);
  context.setFillStyle('#928b83');
  context.setFontSize(20);
  context.fillText('当前成员', 240, 488);
  context.fillText('剩余有效时间', 510, 488);

  drawRoundedRect(context, 265, 542, 220, 220, 24);
  context.setFillStyle('#f5f1ea');
  context.fill();
  context.setStrokeStyle('#655f58');
  context.setLineWidth(10);
  [[290, 567], [414, 567], [290, 691]].forEach(([x, y]) => {
    context.strokeRect(x, y, 46, 46);
  });
  context.setFillStyle('#92857b');
  context.setFontSize(28);
  context.fillText('Note', 375, 674);

  context.setFillStyle('#6d655e');
  context.setFontSize(22);
  context.fillText(`邀请码 ${preview.invite.inviteId.slice(-8).toUpperCase()}`, 375, 816);
  context.setFillStyle('#9a928a');
  context.setFontSize(20);
  context.fillText('通过 NoteMyLife 小程序分享链接加入', 375, 858);
  context.setFillStyle('#b0a79f');
  context.setFontSize(18);
  context.fillText('邀请卡片有效期为 24 小时', 375, 910);
};

const countdownLabel = (expireAt: string): string => {
  const remaining = Math.max(0, Date.parse(expireAt) - Date.now());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

Page({
  data: { statusBarHeight: 24, moduleId: '', loading: true, preview: null as InvitePreview | null, countdown: '24:00:00', expired: false, saving: false },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ moduleId: query.moduleId ?? '', statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.load();
  },
  onUnload() { if (countdownTimer) clearInterval(countdownTimer); },
  async load() {
    try {
      const preview = await createModuleInvite(this.data.moduleId);
      this.setData({ preview, loading: false });
      this.updateCountdown();
      countdownTimer = setInterval(() => this.updateCountdown(), 1000);
      track('invite_share_view', { moduleId: this.data.moduleId, inviteId: preview.invite.inviteId });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error instanceof Error && error.message === 'MODULE_FULL' ? '当前成员已满' : '邀请生成失败', icon: 'none' });
    }
  },
  updateCountdown() {
    const preview = this.data.preview;
    if (!preview) return;
    const expired = Date.parse(preview.invite.expireAt) <= Date.now();
    this.setData({ countdown: countdownLabel(preview.invite.expireAt), expired });
    if (expired && countdownTimer) clearInterval(countdownTimer);
  },
  goBack() { void wx.navigateBack(); },
  shareTap() { track('invite_share_click', { moduleId: this.data.moduleId, inviteId: this.data.preview?.invite.inviteId }); },
  saveInviteCard() {
    const preview = this.data.preview;
    if (!preview || this.data.expired || this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '正在生成卡片' });
    const context = wx.createCanvasContext('inviteExportCanvas', this);
    drawInviteCard(context, preview, this.data.countdown);
    context.draw(false, () => {
      wx.canvasToTempFilePath({
        canvasId: 'inviteExportCanvas',
        width: INVITE_CARD_WIDTH,
        height: INVITE_CARD_HEIGHT,
        destWidth: INVITE_CARD_WIDTH * 2,
        destHeight: INVITE_CARD_HEIGHT * 2,
        fileType: 'png',
        quality: 1,
        success: ({ tempFilePath }) => {
          wx.saveImageToPhotosAlbum({
            filePath: tempFilePath,
            success: () => {
              wx.hideLoading();
              this.setData({ saving: false });
              wx.showToast({ title: '已保存到相册' });
              track('invite_card_save_success', { moduleId: this.data.moduleId, inviteId: preview.invite.inviteId });
            },
            fail: ({ errMsg }) => this.handleCardSaveFailure(errMsg),
          });
        },
        fail: ({ errMsg }) => this.handleCardSaveFailure(errMsg),
      }, this);
    });
  },
  handleCardSaveFailure(errMsg: string) {
    wx.hideLoading();
    this.setData({ saving: false });
    track('invite_card_save_failure', { moduleId: this.data.moduleId, reason: errMsg });
    const permissionDenied = errMsg.includes('auth deny') || errMsg.includes('auth denied') || errMsg.includes('authorize');
    if (!permissionDenied) {
      wx.showToast({ title: '卡片保存失败，请重试', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '无法保存到相册',
      content: '请在设置中允许保存到相册后重试。',
      confirmText: '去设置',
      success: ({ confirm }) => { if (confirm) void wx.openSetting({}); },
    });
  },
  onShareAppMessage() {
    const preview = this.data.preview;
    return {
      title: preview ? `${preview.inviter.nickname}邀请你加入「${preview.module.name}」` : '邀请你一起记录生活',
      path: preview ? `/subpackages/invite-intro/index?inviteId=${preview.invite.inviteId}` : '/pages/home/index',
    };
  },
});
