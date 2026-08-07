import type { MemberManagementView } from '../../services/api';
import { getMemberManagement, removeModuleMember, transferModuleCreator } from '../../services/api';
import { track } from '../../services/tracker';
import { waitForSheetMotion } from '../../utils/sheet-motion';

Page({
  data: {
    statusBarHeight: 24,
    moduleId: '',
    loading: true,
    view: null as MemberManagementView | null,
    actionOpen: false,
    actionClosing: false,
    selectedMemberId: '',
    selectedMemberName: '',
  },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ moduleId: query.moduleId ?? '', statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
  },
  onShow() { void this.load(); },
  async load() {
    try {
      const view = await getMemberManagement(this.data.moduleId);
      this.setData({ view, loading: false, actionOpen: false, actionClosing: false });
      track('member_management_view', { moduleId: this.data.moduleId, memberCount: view.members.length, currentRole: view.currentRole });
    } catch {
      this.setData({ loading: false });
      wx.showToast({ title: '成员信息加载失败', icon: 'none' });
    }
  },
  goBack() { void wx.navigateBack(); },
  openInvite() {
    if (!this.data.view?.inviteAvailable) {
      wx.showToast({ title: '当前成员已满', icon: 'none' });
      return;
    }
    void wx.navigateTo({ url: `/subpackages/invite-share/index?moduleId=${this.data.moduleId}` });
  },
  openRecruitmentPublish() {
    if (this.data.view?.currentRole !== 'creator' || !this.data.view.inviteAvailable) {
      wx.showToast({ title: '当前不能发起公开招募', icon: 'none' });
      return;
    }
    void wx.navigateTo({
      url: `/subpackages/discover-publish/index?mode=recruitment&moduleId=${encodeURIComponent(this.data.moduleId)}`,
    });
  },
  selectMember(event: WechatMiniprogram.TouchEvent) {
    const memberId = event.currentTarget.dataset.id as string;
    const member = this.data.view?.members.find((item) => item.memberInstanceId === memberId);
    if (!member || member.isMine || this.data.view?.currentRole !== 'creator') return;
    this.setData({ actionOpen: true, actionClosing: false, selectedMemberId: memberId, selectedMemberName: member.nickname });
  },
  async dismissActions() {
    if (!this.data.actionOpen || this.data.actionClosing) return;
    this.setData({ actionClosing: true });
    await waitForSheetMotion();
    if (!this.data.actionClosing) return;
    this.setData({ actionOpen: false, actionClosing: false });
  },
  closeActions() { void this.dismissActions(); },
  stopPropagation() {},
  async transferCreator() {
    const memberId = this.data.selectedMemberId;
    const memberName = this.data.selectedMemberName;
    await this.dismissActions();
    wx.showModal({
      title: '确认转让创建者？',
      content: `转让给${memberName}后，你将变为普通成员。`,
      confirmText: '确认转让',
      success: async ({ confirm }) => {
        if (!confirm) return;
        await transferModuleCreator(this.data.moduleId, memberId);
        wx.showToast({ title: '已完成转让' });
        await this.load();
      },
    });
  },
  async removeMember() {
    const memberId = this.data.selectedMemberId;
    const memberName = this.data.selectedMemberName;
    await this.dismissActions();
    wx.showModal({
      title: '确认移出成员？',
      content: `${memberName}将无法继续访问模块，历史记录和回应会匿名保留。`,
      confirmText: '移出',
      confirmColor: '#F65451',
      success: async ({ confirm }) => {
        if (!confirm) return;
        await removeModuleMember(this.data.moduleId, memberId);
        wx.showToast({ title: '成员已移出' });
        await this.load();
      },
    });
  },
});
