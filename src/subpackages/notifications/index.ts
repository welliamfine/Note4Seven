import type { NotificationView } from '../../services/api';
import { getNotifications, markAllNotificationsRead, markNotificationRead, resolveJoinApplication } from '../../services/api';
import { track } from '../../services/tracker';

type NotificationItem = NotificationView & { isProcessing: boolean };

const NOTIFICATION_SYNC_INTERVAL = 5_000;
let notificationSyncTimer: ReturnType<typeof setInterval> | undefined;
let notificationLoadInFlight = false;

Page({
  data: { statusBarHeight: 24, loading: true, notifications: [] as NotificationItem[], processingIds: [] as string[] },
  onLoad() { this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() {
    this.stopSync();
    void this.load();
    notificationSyncTimer = setInterval(() => void this.load(true), NOTIFICATION_SYNC_INTERVAL);
  },
  onHide() { this.stopSync(); },
  onUnload() { this.stopSync(); },
  stopSync() {
    if (notificationSyncTimer) clearInterval(notificationSyncTimer);
    notificationSyncTimer = undefined;
  },
  async load(background = false) {
    if (notificationLoadInFlight) return;
    notificationLoadInFlight = true;
    try {
      const items = await getNotifications();
      const processingIds = new Set(this.data.processingIds);
      const notifications = items.map((item) => ({
        ...item,
        isProcessing: Boolean(item.application && processingIds.has(item.application.applicationId)),
      }));
      const resolvedUnread = notifications.filter((item) => !item.isRead && item.actionStatus === 'resolved');
      if (resolvedUnread.length) {
        resolvedUnread.forEach((item) => { item.isRead = true; });
        await Promise.all(resolvedUnread.map((item) => markNotificationRead(item.notificationId).catch(() => undefined)));
      }
      this.setData({ notifications, loading: false });
      track('notification_center_view', { itemCount: notifications.length, unreadCount: notifications.filter((item) => !item.isRead).length });
    } catch {
      this.setData({ loading: false });
      if (!background) wx.showToast({ title: '通知加载失败', icon: 'none' });
    } finally {
      notificationLoadInFlight = false;
    }
  },
  goBack() { void wx.navigateBack(); },
  stopPropagation() {},
  async markAll() { await markAllNotificationsRead(); await this.load(); },
  async resolveJoin(event: WechatMiniprogram.TouchEvent) {
    const applicationId = event.currentTarget.dataset.application as string;
    const action = event.currentTarget.dataset.action as 'approve' | 'reject';
    if (!applicationId || this.data.processingIds.includes(applicationId)) return;
    this.setData({
      processingIds: [...this.data.processingIds, applicationId],
      notifications: this.data.notifications.map((item) => ({
        ...item,
        isProcessing: item.application?.applicationId === applicationId ? true : item.isProcessing,
      })),
    });
    try {
      await resolveJoinApplication(applicationId, action);
      wx.showToast({ title: action === 'approve' ? '已同意加入' : '已拒绝申请' });
    } catch (error) {
      const message = error instanceof Error && error.message === 'MODULE_FULL' ? '成员人数已满' : '申请已被处理';
      wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setData({ processingIds: this.data.processingIds.filter((id) => id !== applicationId) });
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
