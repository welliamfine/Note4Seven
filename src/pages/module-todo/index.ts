import type { ModuleInboxView } from '../../services/api';
import { getModuleInbox, markModuleInboxRead, resolveMakeupApproval } from '../../services/api';
import { track } from '../../services/tracker';

Page({
  data: { statusBarHeight: 24, moduleId: '', loading: true, items: [] as ModuleInboxView[], processingId: '' },
  onLoad(query: Record<string, string | undefined>) { this.setData({ moduleId: query.moduleId ?? '', statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() { void this.load(); },
  async load() {
    try { const items = await getModuleInbox(this.data.moduleId); this.setData({ items, loading: false, processingId: '' }); track('module_todo_view', { moduleId: this.data.moduleId, itemCount: items.length }); }
    catch { this.setData({ loading: false }); wx.showToast({ title: '待办加载失败', icon: 'none' }); }
  },
  goBack() { void wx.navigateBack(); },
  async markRead(event: WechatMiniprogram.TouchEvent) { await markModuleInboxRead(event.currentTarget.dataset.id as string); await this.load(); },
  async resolveMakeup(event: WechatMiniprogram.TouchEvent) {
    const approvalId = event.currentTarget.dataset.approval as string;
    const action = event.currentTarget.dataset.action as 'approve' | 'reject';
    if (!approvalId || this.data.processingId) return;
    this.setData({ processingId: approvalId });
    try { await resolveMakeupApproval(approvalId, action); wx.showToast({ title: action === 'approve' ? '补卡已通过' : '补卡已拒绝' }); await this.load(); }
    catch { wx.showToast({ title: '该申请已被处理', icon: 'none' }); await this.load(); }
  },
});
