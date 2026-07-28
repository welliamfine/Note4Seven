import type { User } from '../../types/domain';
import { track } from '../../services/tracker';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { hasOpenBottomSheet } from '../../utils/tab-bar-visibility';
import {
  getProfileOverview,
  PROFILE_NICKNAME_MAX_LENGTH,
  updateCurrentUserProfile,
} from '../../services/api';

interface InputEvent extends WechatMiniprogram.CustomEvent { detail: { value: string } }
interface ChooseAvatarEvent extends WechatMiniprogram.CustomEvent { detail: { avatarUrl: string } }

Page({
  data: {
    user: null as User | null,
    profileLoading: true,
    profileLoadFailed: false,
    recordedDays: 0,
    moduleCount: 0,
    unreadCount: 0,
    profileEditOpen: false,
    profileEditClosing: false,
    profileDraftNickname: '',
    profileDraftAvatarUrl: '',
    profileSaving: false,
  },
  onShow() {
    this.syncTabBarVisibility();
    void this.loadProfile();
  },
  syncTabBarVisibility() {
    this.getTabBar?.()?.setData({
      selected: 3,
      hidden: hasOpenBottomSheet(this.data.profileEditOpen),
    });
  },
  async loadProfile() {
    this.setData({ profileLoading: true, profileLoadFailed: false });
    try {
      const overview = await getProfileOverview();
      this.setData({
        user: overview.user,
        profileLoading: false,
        recordedDays: overview.recordedDays,
        moduleCount: overview.moduleCount,
        unreadCount: overview.unreadCount,
      });
      this.getTabBar?.()?.setData({ profileHasUnread: overview.unreadCount > 0 });
      track('profile_view', { recordedDays: overview.recordedDays, activeModuleCount: overview.moduleCount });
    } catch {
      this.setData({ user: null, profileLoading: false, profileLoadFailed: true });
    }
  },
  retryProfile() {
    void this.loadProfile();
  },
  syncUnreadNotificationCount(unreadCount: number) {
    if (unreadCount !== this.data.unreadCount) this.setData({ unreadCount });
  },
  openProfileEditor() {
    const user = this.data.user;
    if (!user) return;
    this.setData(
      { profileEditOpen: true, profileEditClosing: false, profileDraftNickname: user.nickname, profileDraftAvatarUrl: user.avatarUrl ?? '' },
      () => this.syncTabBarVisibility(),
    );
  },
  async dismissProfileEditor() {
    if (!this.data.profileEditOpen || this.data.profileEditClosing) return;
    this.setData({ profileEditClosing: true });
    await waitForSheetMotion();
    if (!this.data.profileEditClosing) return;
    this.setData({ profileEditOpen: false, profileEditClosing: false });
    this.syncTabBarVisibility();
  },
  closeProfileEditor() {
    if (this.data.profileSaving) return;
    void this.dismissProfileEditor();
  },
  stopPropagation() {},
  onProfileNicknameInput(event: InputEvent) { this.setData({ profileDraftNickname: event.detail.value }); },
  onChooseAvatar(event: ChooseAvatarEvent) {
    this.setData({ profileDraftAvatarUrl: event.detail.avatarUrl }, () => this.syncTabBarVisibility());
  },
  async saveProfile() {
    if (this.data.profileSaving) return;
    const nickname = this.data.profileDraftNickname.trim();
    if (!nickname || nickname.length > PROFILE_NICKNAME_MAX_LENGTH) {
      wx.showToast({ title: `昵称最多${PROFILE_NICKNAME_MAX_LENGTH}字且不能为空`, icon: 'none' });
      return;
    }
    this.setData({ profileSaving: true });
    try {
      const user = await updateCurrentUserProfile({ nickname, avatarUrl: this.data.profileDraftAvatarUrl });
      this.setData({ user, profileSaving: false });
      await this.dismissProfileEditor();
      wx.showToast({ title: '资料已保存' });
      track('profile_update_success', { hasAvatar: Boolean(user.avatarUrl) });
    } catch {
      this.setData({ profileSaving: false });
      wx.showToast({ title: '资料保存失败，请重试', icon: 'none' });
    }
  },
  openPrivacy() {
    void wx.navigateTo({ url: '/subpackages/privacy/index' });
  },
  openRecycleBin() { void wx.navigateTo({ url: '/subpackages/recycle-bin/index' }); },
  openNotifications() {
    void wx.navigateTo({ url: '/subpackages/notifications/index' });
  },
});
