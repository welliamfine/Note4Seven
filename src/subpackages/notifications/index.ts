import type { NotificationView } from '../../services/api';
import { getNotifications, markAllNotificationsRead, markNotificationRead, resolveJoinApplication } from '../../services/api';
import { track } from '../../services/tracker';

Page({
  data: { statusBarHeight: 24, loading: true, notifications: [] as NotificationView[], processingId: '' },
  onLoad() { this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() { void this.load(); },
  async load() {
    try {
      const notifications = await getNotifications();
      this.setData({ notifications, loading: false, processingId: '' });
      track('notification_center_view', { itemCount: notifications.length, unreadCount: notifications.filter((item) => !item.isRead).length });
    } catch { this.setData({ loading: false }); wx.showToast({ title: '通知加载失败', icon: 'none' }); }
  },
  goBack() { void wx.navigateBack(); },
  stopPropagation() {},
  async markAll() { await markAllNotificationsRead(); await this.load(); },
  async resolveJoin(event: WechatMiniprogram.TouchEvent) {
    const applicationId = event.currentTarget.dataset.application as string;
    const action = event.currentTarget.dataset.action as 'approve' | 'reject';
    if (!applicationId || this.data.processingId) return;
    this.setData({ processingId: applicationId });
    try {
      await resolveJoinApplication(applicationId, action);
      wx.showToast({ title: action === 'approve' ? '已同意加入' : '已拒绝申请' });
      await this.load();
    } catch (error) {
      const message = error instanceof Error && error.message === 'MODULE_FULL' ? '成员人数已满' : '申请已被处理';
      wx.showToast({ title: message, icon: 'none' });
      await this.load();
    }
  },
  async openNotification(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id as string;
    const moduleId = event.currentTarget.dataset.module as string | undefined;
    await markNotificationRead(id);
    if (!moduleId) { await this.load(); return; }
    void wx.navigateTo({ url: `/subpackages/module-detail/index?moduleId=${moduleId}`, fail: () => wx.showToast({ title: '目标已失效', icon: 'none' }) });
  },
});
