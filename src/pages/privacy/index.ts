import { cancelAccountDeletion, getPrivacyView, requestAccountDeletion, type PrivacyView } from '../../services/api';
import { track } from '../../services/tracker';

Page({
  data: { statusBarHeight: 24, loading: true, view: null as PrivacyView | null },
  onLoad() { this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() { void this.load(); },
  async load() { const view = await getPrivacyView(); this.setData({ view, loading: false }); track('privacy_view', { version: view.version }); },
  goBack() { void wx.navigateBack(); },
  requestDeletion() {
    wx.showModal({
      title: '申请删除账号？',
      content: '申请后进入7天冷静期。到期后将清理账号、模块关系、记录和图片；冷静期内可以撤销。',
      confirmText: '继续申请',
      confirmColor: '#F65451',
      success: ({ confirm }) => {
        if (!confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '删除完成后无法恢复。确认提交账号删除申请？',
          confirmText: '提交申请',
          confirmColor: '#F65451',
          success: async ({ confirm: finalConfirm }) => {
            if (!finalConfirm) return;
            await requestAccountDeletion();
            wx.showToast({ title: '删除申请已提交' });
            await this.load();
          },
        });
      },
    });
  },
  cancelDeletion() {
    wx.showModal({ title: '撤销删除申请？', content: '撤销后账号将继续正常保留。', confirmText: '撤销申请', success: async ({ confirm }) => { if (!confirm) return; await cancelAccountDeletion(); await this.load(); wx.showToast({ title: '申请已撤销' }); } });
  },
});
