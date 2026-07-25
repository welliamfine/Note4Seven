import { getRecycleBin, restoreRecycledModule, type RecycleModuleView } from '../../services/api';
import { track } from '../../services/tracker';

Page({
  data: { statusBarHeight: 24, loading: true, items: [] as RecycleModuleView[], restoringId: '' },
  onLoad() { this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() { void this.load(); },
  async load() {
    const items = await getRecycleBin();
    this.setData({ items, loading: false, restoringId: '' });
    track('recycle_bin_view', { itemCount: items.length });
  },
  goBack() { void wx.navigateBack(); },
  restore(event: WechatMiniprogram.TouchEvent) {
    const moduleId = event.currentTarget.dataset.id as string;
    const item = this.data.items.find((candidate) => candidate.moduleId === moduleId);
    if (!item || this.data.restoringId) return;
    wx.showModal({
      title: '恢复这个模块？',
      content: `「${item.name}」会重新出现在所有成员的首页，旧邀请和已取消审批不会恢复。`,
      confirmText: '恢复',
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ restoringId: moduleId });
        try { await restoreRecycledModule(moduleId); wx.showToast({ title: '模块已恢复' }); await this.load(); }
        catch { this.setData({ restoringId: '' }); wx.showToast({ title: '恢复期限已过', icon: 'none' }); }
      },
    });
  },
});
