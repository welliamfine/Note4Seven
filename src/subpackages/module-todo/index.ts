import type { ModuleInboxView } from '../../services/api';
import { getModuleInbox, markModuleInboxRead, resolveJoinApplication, resolveMakeupApproval } from '../../services/api';
import { track } from '../../services/tracker';

type ModuleTodoItem = ModuleInboxView & { isProcessing: boolean };

const TODO_SYNC_INTERVAL = 5_000;
let todoSyncTimer: ReturnType<typeof setInterval> | undefined;
let todoLoadInFlight = false;

function requiresAction(item: ModuleInboxView): boolean {
  return item.application?.status === 'pending' || item.approval?.status === 'pending';
}

Page({
  data: { statusBarHeight: 24, moduleId: '', loading: true, items: [] as ModuleTodoItem[], processingIds: [] as string[] },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ moduleId: query.moduleId ?? '', statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
  },
  onShow() {
    this.stopSync();
    void this.load();
    todoSyncTimer = setInterval(() => void this.load(true), TODO_SYNC_INTERVAL);
  },
  onHide() { this.stopSync(); },
  onUnload() { this.stopSync(); },
  stopSync() {
    if (todoSyncTimer) clearInterval(todoSyncTimer);
    todoSyncTimer = undefined;
  },
  async load(background = false) {
    if (todoLoadInFlight) return;
    todoLoadInFlight = true;
    try {
      const rawItems = await getModuleInbox(this.data.moduleId);
      const unreadItems = rawItems.filter((item) => item.status === 'unread' && !requiresAction(item));
      const readIds = new Set<string>();
      await Promise.all(unreadItems.map(async (item) => {
        try {
          await markModuleInboxRead(item.itemId, item.notificationId, this.data.moduleId);
          readIds.add(item.itemId);
        } catch {
          // Preserve unread state when the service could not persist it.
        }
      }));
      const processingIds = new Set(this.data.processingIds);
      const items = rawItems.map((item) => ({
        ...item,
        status: readIds.has(item.itemId) ? 'read' as const : item.status,
        isProcessing: processingIds.has(item.approval?.approvalId ?? item.application?.applicationId ?? ''),
      }));
      this.setData({ items, loading: false });
      track('module_todo_view', { moduleId: this.data.moduleId, itemCount: items.length, viewedCount: readIds.size });
    } catch {
      this.setData({ loading: false });
      if (!background) wx.showToast({ title: '待办加载失败', icon: 'none' });
    } finally {
      todoLoadInFlight = false;
    }
  },
  goBack() { void wx.navigateBack(); },
  async markRead(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.items.find((candidate) => candidate.itemId === event.currentTarget.dataset.id);
    if (!item || item.status !== 'unread' || requiresAction(item)) return;
    await markModuleInboxRead(item.itemId, item.notificationId, this.data.moduleId);
    await this.load();
  },
  async resolveMakeup(event: WechatMiniprogram.TouchEvent) {
    const approvalId = event.currentTarget.dataset.approval as string;
    const action = event.currentTarget.dataset.action as 'approve' | 'reject';
    if (!approvalId || this.data.processingIds.includes(approvalId)) return;
    this.setProcessing(approvalId, true);
    try {
      await resolveMakeupApproval(approvalId, action);
      wx.showToast({ title: action === 'approve' ? '补卡已通过' : '补卡已拒绝' });
    } catch {
      wx.showToast({ title: '该申请已被处理', icon: 'none' });
    } finally {
      this.setProcessing(approvalId, false);
      await this.load();
    }
  },
  async resolveJoin(event: WechatMiniprogram.TouchEvent) {
    const applicationId = event.currentTarget.dataset.application as string;
    const action = event.currentTarget.dataset.action as 'approve' | 'reject';
    if (!applicationId || this.data.processingIds.includes(applicationId)) return;
    this.setProcessing(applicationId, true);
    try {
      await resolveJoinApplication(applicationId, action);
      wx.showToast({ title: action === 'approve' ? '已同意加入' : '已拒绝申请' });
    } catch {
      wx.showToast({ title: '该申请已被处理', icon: 'none' });
    } finally {
      this.setProcessing(applicationId, false);
      await this.load();
    }
  },
  setProcessing(targetId: string, processing: boolean) {
    const processingIds = processing
      ? [...this.data.processingIds, targetId]
      : this.data.processingIds.filter((id) => id !== targetId);
    this.setData({
      processingIds,
      items: this.data.items.map((item) => ({
        ...item,
        isProcessing: (item.approval?.approvalId ?? item.application?.applicationId) === targetId ? processing : item.isProcessing,
      })),
    });
  },
});
