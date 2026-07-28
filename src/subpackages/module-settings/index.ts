import type { MemberManagementView } from '../../services/api';
import {
  getMemberManagement,
  getModuleReminder,
  MODULE_DESCRIPTION_MAX_LENGTH,
  MODULE_NAME_MAX_LENGTH,
  updateModuleInfo,
  updateModuleReminder,
  type ReminderView,
} from '../../services/api';
import { track } from '../../services/tracker';
import { removeModuleWithConfirmation } from '../../utils/module-removal';

interface InputEvent extends WechatMiniprogram.CustomEvent { detail: { value: string } }
interface SwitchEvent extends WechatMiniprogram.CustomEvent { detail: { value: boolean } }

Page({
  data: {
    statusBarHeight: 24,
    moduleId: '',
    loading: true,
    view: null as MemberManagementView | null,
    reminder: null as ReminderView | null,
    name: '',
    description: '',
    saving: false,
    reminderEnabled: false,
    inAppEnabled: true,
    reminderTime: '21:00',
    reminderSaving: false,
    removing: false,
  },
  onLoad(query: Record<string, string | undefined>) { this.setData({ moduleId: query.moduleId ?? '', statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 }); },
  onShow() { void this.load(); },
  async load() {
    try {
      const [view, reminder] = await Promise.all([getMemberManagement(this.data.moduleId), getModuleReminder(this.data.moduleId)]);
      this.setData({
        view,
        reminder,
        name: view.module.name,
        description: view.module.description,
        reminderEnabled: reminder.enabled,
        inAppEnabled: reminder.inAppEnabled,
        reminderTime: reminder.reminderTime,
        loading: false,
      });
      track('module_settings_view', { moduleId: this.data.moduleId, role: view.currentRole });
    } catch { this.setData({ loading: false }); wx.showToast({ title: '设置加载失败', icon: 'none' }); }
  },
  goBack() { void wx.navigateBack(); },
  onName(event: InputEvent) { this.setData({ name: event.detail.value }); },
  onDescription(event: InputEvent) { this.setData({ description: event.detail.value }); },
  onReminderEnabled(event: SwitchEvent) { this.setData({ reminderEnabled: event.detail.value }); },
  onInAppEnabled(event: SwitchEvent) { this.setData({ inAppEnabled: event.detail.value }); },
  onReminderTime(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ reminderTime: event.detail.value }); },
  async save() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    const description = this.data.description.trim();
    if (!name || name.length > MODULE_NAME_MAX_LENGTH || description.length > MODULE_DESCRIPTION_MAX_LENGTH) {
      wx.showToast({ title: `标题最多${MODULE_NAME_MAX_LENGTH}字，简介最多${MODULE_DESCRIPTION_MAX_LENGTH}字`, icon: 'none' });
      return;
    }
    this.setData({ name, description });
    this.setData({ saving: true });
    try { await updateModuleInfo(this.data.moduleId, name, description); this.setData({ saving: false }); wx.showToast({ title: '已保存' }); }
    catch { this.setData({ saving: false }); wx.showToast({ title: '请检查名称和说明', icon: 'none' }); }
  },
  openInvite() {
    if (!this.data.view?.inviteAvailable) { wx.showToast({ title: '当前成员已满', icon: 'none' }); return; }
    void wx.navigateTo({ url: `/subpackages/invite-share/index?moduleId=${this.data.moduleId}` });
  },
  async saveReminder() {
    if (this.data.reminderSaving) return;
    this.setData({ reminderSaving: true });
    try {
      const reminder = await updateModuleReminder(this.data.moduleId, {
        enabled: this.data.reminderEnabled,
        inAppEnabled: this.data.inAppEnabled,
        reminderTime: this.data.reminderTime,
        subscriptionStatus: this.data.reminder?.subscriptionStatus ?? 'not_requested',
      });
      this.setData({ reminder, reminderSaving: false });
      wx.showToast({ title: reminder.enabled ? '提醒已保存' : '提醒已关闭' });
    } catch {
      this.setData({ reminderSaving: false });
      wx.showToast({ title: '提醒保存失败', icon: 'none' });
    }
  },
  explainExternalReminder() {
    wx.showModal({
      title: '微信提醒',
      content: '开启提醒并保存时，微信会请求一次订阅消息授权。授权后会在你设置的时间提醒当天尚未记录的模块。',
      showCancel: false,
    });
  },
  async removeCurrentModule() {
    const view = this.data.view;
    if (!view || this.data.removing) return;
    const currentUserId = view.members.find((member) => member.isMine)?.userId ?? '';
    if (!currentUserId) return;
    this.setData({ removing: true });
    try {
      const result = await removeModuleWithConfirmation(view.module, currentUserId);
      this.setData({ removing: false });
      if (result === 'cancelled') return;
      wx.showToast({ title: result === 'deleted' ? '模块已删除' : '模块已移除' });
      void wx.reLaunch({ url: '/pages/home/index' });
    } catch {
      this.setData({ removing: false });
      wx.showToast({ title: '删除操作失败', icon: 'none' });
    }
  },
});
