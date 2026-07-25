import type { HomeModuleView, ModuleTemplate, User } from '../../types/domain';
import {
  createModule,
  MODULE_DESCRIPTION_MAX_LENGTH,
  MODULE_NAME_MAX_LENGTH,
  deleteModuleToRecycle,
  getCurrentUser,
  getHomeModules,
  getMemoryView,
  getProfileOverview,
  getTemplates,
  PROFILE_NICKNAME_MAX_LENGTH,
  removeModuleForCurrentUser,
  setModulePinned,
  updateCurrentUserProfile,
  type MemoryModuleOption,
} from '../../services/api';
import { track } from '../../services/tracker';
import { monthLabel, monthOf, nextMonth, previousMonth, shanghaiDate } from '../../utils/date';
import { createId } from '../../utils/id';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { drawStickerWithOutline } from '../../utils/sticker-outline';
import { hasOpenBottomSheet } from '../../utils/tab-bar-visibility';
import {
  HOME_GROUP_CARD_OPENING_DURATION,
  HOME_GROUP_MOTION,
  HOME_GROUP_OPENING_DURATION,
} from '../../utils/home-group-motion';

interface InputEvent extends WechatMiniprogram.CustomEvent {
  detail: { value: string };
}

interface ChooseAvatarEvent extends WechatMiniprogram.CustomEvent {
  detail: { avatarUrl: string };
}

interface AnimatedSticker {
  id: string;
  path: string;
  popDelay: number;
}

let cardTouchStartX = 0;
let cardTouchStartY = 0;
let cardTouchMoved = false;
let cardGestureInProgress = false;
let homeGapTouchStartX = 0;
let homeGapTouchStartY = 0;
let homeGapGestureArmed = false;
let primaryStickerTimers: Array<ReturnType<typeof setTimeout>> = [];
let homeShowToken = 0;

const clearPrimaryStickerTimers = () => {
  primaryStickerTimers.forEach((timer) => clearTimeout(timer));
  primaryStickerTimers = [];
};

const schedulePrimaryStickerState = (callback: () => void, delay: number) => {
  primaryStickerTimers.push(setTimeout(callback, delay));
};

Page({
  data: {
    statusBarHeight: 24,
    primaryTabIndex: 0,
    homeStickerPhase: 'sticker-hidden',
    memoryStickerPhase: 'sticker-hidden',
    cardGestureActive: false,
    loading: true,
    managing: false,
    currentUserId: '',
    revealedModuleId: '',
    pinnedExpanded: true,
    normalExpanded: true,
    pinnedExpanding: false,
    normalExpanding: false,
    pinnedCollapsing: false,
    normalCollapsing: false,
    homeGroupMotionDuration: HOME_GROUP_MOTION.totalDuration,
    homeGroupOpeningDuration: HOME_GROUP_OPENING_DURATION,
    homeGroupCardOpeningDuration: HOME_GROUP_CARD_OPENING_DURATION,
    homeGroupOpeningStaggerStep: HOME_GROUP_MOTION.openingStaggerStep,
    homeGroupOpeningMaxStaggerSteps: HOME_GROUP_MOTION.openingMaxStaggerSteps,
    pinnedModules: [] as HomeModuleView[],
    normalModules: [] as HomeModuleView[],
    templates: [] as ModuleTemplate[],
    createOpen: false,
    createClosing: false,
    createSource: 'floating',
    createName: '',
    createDescription: '',
    selectedTemplateId: '',
    createSubmitting: false,
    createError: '',
    memoryMonthLabel: '',
    memoryRecordedDays: 0,
    memoryModuleCount: 0,
    memoryRecordCount: 0,
    memoryJointCompleted: 0,
    memoryWeeklyJointCompleted: 0,
    memoryStreakDays: 0,
    memoryReceivedReactions: 0,
    memoryWeeklyReceivedReactions: 0,
    memoryStickers: [] as AnimatedSticker[],
    memoryStickerFinalDelay: 0,
    memorySelectedModuleId: '',
    memorySelectedModuleName: '',
    memoryMonth: monthOf(shanghaiDate()),
    memoryModules: [] as MemoryModuleOption[],
    memoryMostUsedEmoji: '—',
    memorySelectionOpen: false,
    memorySelectionClosing: false,
    memoryExporting: false,
    profileUser: null as User | null,
    profileRecordedDays: 0,
    profileModuleCount: 0,
    profileUnreadCount: 0,
    profileEditOpen: false,
    profileEditClosing: false,
    profileDraftNickname: '',
    profileDraftAvatarUrl: '',
    profileSaving: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.loadTemplates();
  },

  onShow() {
    const showToken = ++homeShowToken;
    const routeReady = waitForAppRouteDone();
    clearPrimaryStickerTimers();
    this.syncTabBarVisibility();
    if (this.data.primaryTabIndex === 0) this.setData({ homeStickerPhase: 'sticker-hidden' });
    if (this.data.primaryTabIndex === 1) this.setData({ memoryStickerPhase: 'sticker-hidden' });
    void Promise.all([this.loadHome(), routeReady]).then(() => {
      if (showToken === homeShowToken && this.data.primaryTabIndex === 0) this.playHomeStickerAnimation();
    });
    this.loadMemoryData();
    if (this.data.primaryTabIndex === 1) {
      void routeReady.then(() => {
        if (showToken === homeShowToken && this.data.primaryTabIndex === 1) this.playMemoryStickerAnimation();
      });
    }
    this.loadProfileData();
  },

  onHide() {
    homeShowToken += 1;
    clearPrimaryStickerTimers();
  },

  onUnload() {
    homeShowToken += 1;
    clearPrimaryStickerTimers();
  },

  syncTabBarVisibility() {
    const hidden = hasOpenBottomSheet(
      this.data.createOpen,
      this.data.memorySelectionOpen,
      this.data.profileEditOpen,
    );
    this.getTabBar?.()?.setData({ selected: this.data.primaryTabIndex, hidden });
  },

  changePrimaryTab(index: number) {
    if (index < 0 || index > 3 || index === this.data.primaryTabIndex) return;
    cardGestureInProgress = false;
    this.setData({
      primaryTabIndex: index,
      ...(index === 0 ? { homeStickerPhase: 'sticker-hidden' } : {}),
      ...(index === 1 ? { memoryStickerPhase: 'sticker-hidden' } : {}),
      revealedModuleId: '',
      managing: false,
      cardGestureActive: false,
    });
  },

  onPrimarySwiperChange(event: WechatMiniprogram.CustomEvent<{ current: number }>) {
    const index = event.detail.current;
    this.setData({
      primaryTabIndex: index,
      revealedModuleId: '',
      managing: false,
      cardGestureActive: false,
    });
    this.syncTabBarVisibility();
    if (index === 1) {
      this.loadMemoryData();
      track('memory_view', { weeklyOverviewReady: true, monthlyCardReady: true });
    } else if (index === 2) {
      track('discover_view', { pageVariant: 'coming_soon' });
    } else if (index === 3) {
      this.loadProfileData();
    }
  },

  onPrimarySwiperAnimationFinish(event: WechatMiniprogram.CustomEvent<{ current: number }>) {
    const index = event.detail.current;
    clearPrimaryStickerTimers();
    this.setData({
      ...(index === 0 ? {} : { homeStickerPhase: 'sticker-hidden' }),
      ...(index === 1 ? {} : { memoryStickerPhase: 'sticker-hidden' }),
    }, () => {
      if (index === 0) this.playHomeStickerAnimation();
      if (index === 1) this.playMemoryStickerAnimation();
    });
  },

  playHomeStickerAnimation() {
    this.setData({ homeStickerPhase: 'sticker-hidden' });
    schedulePrimaryStickerState(
      () => this.setData({ homeStickerPhase: 'sticker-entering' }),
      STICKER_MOTION.pageSettledDelay,
    );
    schedulePrimaryStickerState(
      () => this.setData({ homeStickerPhase: 'sticker-visible' }),
      STICKER_MOTION.pageSettledDelay + STICKER_MOTION.duration,
    );
  },

  playMemoryStickerAnimation() {
    this.setData({ memoryStickerPhase: 'sticker-hidden' });
    schedulePrimaryStickerState(
      () => this.setData({ memoryStickerPhase: 'sticker-entering' }),
      STICKER_MOTION.pageSettledDelay,
    );
    schedulePrimaryStickerState(
      () => this.setData({ memoryStickerPhase: 'sticker-visible' }),
      STICKER_MOTION.pageSettledDelay + this.data.memoryStickerFinalDelay + STICKER_MOTION.duration,
    );
  },

  async loadMemoryData(forceChange = false, animate = forceChange) {
    try {
      const view = await getMemoryView(this.data.memorySelectedModuleId || undefined, this.data.memoryMonth, forceChange);
      const stickerPlan = createStickerDelays(view.items.map((item) => item.recordId));
      this.setData({
        memoryMonthLabel: monthLabel(view.month),
        memoryRecordedDays: view.recordedDays,
        memoryModuleCount: view.participatedModuleCount,
        memoryRecordCount: view.weeklyRecordCount,
        memoryJointCompleted: view.monthlyJointCompletedDays,
        memoryWeeklyJointCompleted: view.jointCompletedDays,
        memoryStreakDays: view.currentStreakDays,
        memoryReceivedReactions: view.monthlyReceivedReactionCount,
        memoryWeeklyReceivedReactions: view.receivedReactionCount,
        memorySelectedModuleId: view.moduleId,
        memorySelectedModuleName: view.moduleName,
        memoryMonth: view.month,
        memoryModules: view.modules,
        memoryMostUsedEmoji: view.mostUsedEmoji,
        memoryStickers: view.items.map((item) => ({
          id: item.recordId,
          path: item.stickerPath,
          popDelay: stickerPlan.delays.get(item.recordId) ?? 0,
        })),
        memoryStickerFinalDelay: stickerPlan.finalDelay,
        memoryStickerPhase: animate ? 'sticker-hidden' : this.data.memoryStickerPhase,
      }, () => { if (animate) this.playMemoryStickerAnimation(); });
    } catch {
      this.setData({ memoryStickers: [], memorySelectedModuleId: '', memorySelectedModuleName: '' });
    }
  },

  changeMemoryGroup() {
    clearPrimaryStickerTimers();
    void this.loadMemoryData(true);
    track('memory_change_group_click', { moduleId: this.data.memorySelectedModuleId, month: this.data.memoryMonth });
  },

  openMemorySelection() {
    this.setData({ memorySelectionOpen: true, memorySelectionClosing: false }, () => this.syncTabBarVisibility());
  },
  async dismissMemorySelection() {
    if (!this.data.memorySelectionOpen || this.data.memorySelectionClosing) return;
    this.setData({ memorySelectionClosing: true });
    await waitForSheetMotion();
    if (!this.data.memorySelectionClosing) return;
    this.setData({ memorySelectionOpen: false, memorySelectionClosing: false });
    this.syncTabBarVisibility();
  },
  closeMemorySelection() { void this.dismissMemorySelection(); },
  async selectMemoryModule(event: WechatMiniprogram.TouchEvent) {
    const moduleId = event.currentTarget.dataset.id as string;
    clearPrimaryStickerTimers();
    this.setData({ memorySelectedModuleId: moduleId, memoryStickerPhase: 'sticker-hidden' });
    await Promise.all([this.dismissMemorySelection(), this.loadMemoryData(false)]);
    this.playMemoryStickerAnimation();
  },
  previousMemoryMonth() {
    clearPrimaryStickerTimers();
    this.setData({ memoryMonth: previousMonth(this.data.memoryMonth), memoryStickerPhase: 'sticker-hidden' }, () => void this.loadMemoryData(false, true));
  },
  nextMemoryMonth() {
    const target = nextMonth(this.data.memoryMonth);
    if (target > monthOf(shanghaiDate())) return;
    clearPrimaryStickerTimers();
    this.setData({ memoryMonth: target, memoryStickerPhase: 'sticker-hidden' }, () => void this.loadMemoryData(false, true));
  },

  saveMemoryCard() {
    if (this.data.memoryExporting || !this.data.memorySelectedModuleId) return;
    this.setData({ memoryExporting: true });
    wx.showLoading({ title: '正在生成卡片' });
    const context = wx.createCanvasContext('memoryExportCanvas', this);
    context.setFillStyle('#f9f8f3');
    context.fillRect(0, 0, 750, 1000);
    context.setFillStyle('#c99491');
    context.setFontSize(36);
    context.fillText('RECORD', 64, 100);
    context.setFillStyle('#5f5851');
    context.setFontSize(32);
    context.fillText(this.data.memorySelectedModuleName, 64, 154);
    context.setFillStyle('#9b9188');
    context.setFontSize(24);
    context.fillText(this.data.memoryMonthLabel, 64, 194);
    this.data.memoryStickers.forEach((sticker, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      drawStickerWithOutline(context, sticker.path, 54 + column * 166, 250 + row * 250, 144, 196);
    });
    context.setFillStyle('#766e67');
    context.setFontSize(24);
    context.fillText(`共同完成 ${this.data.memoryJointCompleted} 天  ·  收到回应 ${this.data.memoryReceivedReactions} 次`, 64, 815);
    context.setFillStyle('#b9a9a0');
    context.setFontSize(20);
    context.fillText('NoteMyLife · 记录我的一辈子', 64, 920);
    context.draw(false, () => {
      wx.canvasToTempFilePath({
        canvasId: 'memoryExportCanvas',
        width: 750,
        height: 1000,
        destWidth: 1500,
        destHeight: 2000,
        success: ({ tempFilePath }) => {
          wx.saveImageToPhotosAlbum({
            filePath: tempFilePath,
            success: () => { wx.hideLoading(); this.setData({ memoryExporting: false }); wx.showToast({ title: '已保存到相册' }); track('memory_export_success', { moduleId: this.data.memorySelectedModuleId, month: this.data.memoryMonth }); },
            fail: () => { wx.hideLoading(); this.setData({ memoryExporting: false }); wx.showModal({ title: '无法保存到相册', content: '请在系统设置中允许照片权限后重试。', confirmText: '去设置', success: ({ confirm }) => { if (confirm) void wx.openSetting({}); } }); },
          });
        },
        fail: () => { wx.hideLoading(); this.setData({ memoryExporting: false }); wx.showToast({ title: '卡片生成失败', icon: 'none' }); },
      }, this);
    });
  },

  async loadProfileData() {
    try {
      const overview = await getProfileOverview();
      this.setData({
        profileUser: overview.user,
        profileRecordedDays: overview.recordedDays,
        profileModuleCount: overview.moduleCount,
        profileUnreadCount: overview.unreadCount,
      });
      track('profile_view', { recordedDays: overview.recordedDays, activeModuleCount: overview.moduleCount });
    } catch {
      wx.showToast({ title: '个人资料加载失败', icon: 'none' });
    }
  },

  openProfileEditor() {
    const user = this.data.profileUser;
    if (!user) return;
    this.setData({
      profileEditOpen: true,
      profileEditClosing: false,
      profileDraftNickname: user.nickname,
      profileDraftAvatarUrl: user.avatarUrl ?? '',
    });
    this.syncTabBarVisibility();
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

  onProfileNicknameInput(event: InputEvent) {
    this.setData({ profileDraftNickname: event.detail.value });
  },

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
      this.setData({ profileUser: user, profileSaving: false });
      await this.loadHome(false);
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

  async loadTemplates() {
    this.setData({ templates: await getTemplates() });
  },

  async loadHome(showLoading = true) {
    if (showLoading) this.setData({ loading: true });
    try {
      const [result, currentUser] = await Promise.all([getHomeModules(), getCurrentUser()]);
      this.setData({
        pinnedModules: result.pinned,
        normalModules: result.normal,
        currentUserId: currentUser.userId,
        loading: false,
      });
      track('home_view', {
        pinnedModuleCount: result.pinned.length,
        normalModuleCount: result.normal.length,
        isEmpty: result.pinned.length + result.normal.length === 0,
      });
    } catch {
      this.setData({ loading: false });
      wx.showToast({ title: '首页加载失败', icon: 'none' });
    }
  },

  toggleManage() {
    const managing = !this.data.managing;
    this.setData({
      managing,
      revealedModuleId: '',
      pinnedExpanded: managing ? true : this.data.pinnedExpanded,
      normalExpanded: managing ? true : this.data.normalExpanded,
      pinnedExpanding: false,
      normalExpanding: false,
      pinnedCollapsing: false,
      normalCollapsing: false,
    });
    track(this.data.managing ? 'home_manage_view' : 'home_manage_close');
  },

  togglePinnedGroup() {
    if (this.data.managing) return;
    if (this.data.pinnedCollapsing || this.data.pinnedExpanding) return;
    if (!this.data.pinnedExpanded) {
      this.setData({ pinnedExpanding: true }, () => {
        setTimeout(
          () => this.setData({ pinnedExpanded: true }),
          HOME_GROUP_MOTION.openingStartDelay,
        );
        setTimeout(
          () => this.setData({ pinnedExpanding: false }),
          HOME_GROUP_MOTION.totalDuration,
        );
      });
      return;
    }
    this.setData({ pinnedCollapsing: true });
    setTimeout(
      () => this.setData({ pinnedExpanded: false, pinnedCollapsing: false }),
      HOME_GROUP_MOTION.totalDuration,
    );
  },

  toggleNormalGroup() {
    if (this.data.managing) return;
    if (this.data.normalCollapsing || this.data.normalExpanding) return;
    if (!this.data.normalExpanded) {
      this.setData({ normalExpanding: true }, () => {
        setTimeout(
          () => this.setData({ normalExpanded: true }),
          HOME_GROUP_MOTION.openingStartDelay,
        );
        setTimeout(
          () => this.setData({ normalExpanding: false }),
          HOME_GROUP_MOTION.totalDuration,
        );
      });
      return;
    }
    this.setData({ normalCollapsing: true });
    setTimeout(
      () => this.setData({ normalExpanded: false, normalCollapsing: false }),
      HOME_GROUP_MOTION.totalDuration,
    );
  },

  openModule(event: WechatMiniprogram.TouchEvent) {
    if (cardTouchMoved || this.data.managing) return;
    if (this.data.revealedModuleId) {
      this.setData({ revealedModuleId: '' });
      return;
    }
    const moduleId = event.currentTarget.dataset.id as string;
    track('home_module_click', { moduleId });
    void wx.navigateTo({ url: `/subpackages/module-detail/index?moduleId=${moduleId}` });
  },

  async togglePin(event: WechatMiniprogram.TouchEvent) {
    const moduleId = event.currentTarget.dataset.id as string;
    const pinned = event.currentTarget.dataset.pinned === true || event.currentTarget.dataset.pinned === 'true';
    await setModulePinned(moduleId, !pinned);
    this.setData({ revealedModuleId: '' });
    await this.loadHome(false);
  },

  onCardTouchStart(event: WechatMiniprogram.TouchEvent) {
    const touch = event.touches[0];
    cardTouchStartX = touch?.clientX ?? 0;
    cardTouchStartY = touch?.clientY ?? 0;
    cardTouchMoved = false;
    cardGestureInProgress = true;
    this.setData({ cardGestureActive: true });
  },

  onCardTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (this.data.managing) {
      cardGestureInProgress = false;
      this.setData({ cardGestureActive: false });
      return;
    }
    const touch = event.changedTouches[0];
    const deltaX = (touch?.clientX ?? cardTouchStartX) - cardTouchStartX;
    const deltaY = (touch?.clientY ?? cardTouchStartY) - cardTouchStartY;
    const isHorizontalSwipe = Math.abs(deltaX) >= 42 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15;
    cardTouchMoved = isHorizontalSwipe;
    if (isHorizontalSwipe) {
      const moduleId = event.currentTarget.dataset.id as string;
      this.setData({ revealedModuleId: deltaX < 0 ? moduleId : '' });
    }
    setTimeout(() => {
      cardTouchMoved = false;
      cardGestureInProgress = false;
      this.setData({ cardGestureActive: false });
    }, 80);
  },

  onCardTouchCancel() {
    cardTouchMoved = false;
    cardGestureInProgress = false;
    this.setData({ cardGestureActive: false });
  },

  onHomeGapTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (cardGestureInProgress) {
      homeGapGestureArmed = false;
      return;
    }
    const touch = event.touches[0];
    homeGapTouchStartX = touch?.clientX ?? 0;
    homeGapTouchStartY = touch?.clientY ?? 0;
    homeGapGestureArmed = true;
  },

  onHomeGapTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (!homeGapGestureArmed || cardGestureInProgress) {
      homeGapGestureArmed = false;
      return;
    }
    const touch = event.changedTouches[0];
    const deltaX = (touch?.clientX ?? homeGapTouchStartX) - homeGapTouchStartX;
    const deltaY = (touch?.clientY ?? homeGapTouchStartY) - homeGapTouchStartY;
    homeGapGestureArmed = false;
    if (deltaX <= -48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) this.changePrimaryTab(1);
  },

  removeModule(event: WechatMiniprogram.TouchEvent) {
    const moduleId = event.currentTarget.dataset.id as string;
    const module = [...this.data.pinnedModules, ...this.data.normalModules].find((item) => item.moduleId === moduleId);
    if (!module) return;
    const currentMember = module.members.find((member) => member.userId === this.data.currentUserId);
    const memberCount = module.members.length;

    if (currentMember?.role === 'creator') {
      wx.showModal({
        title: '输入模块名称确认',
        content: '删除后所有成员立即停止打卡，模块进入7天回收期。',
        editable: true,
        placeholderText: module.name,
        confirmText: '继续',
        confirmColor: '#F65451',
        success: ({ confirm, content }) => {
          if (!confirm) return;
          if ((content ?? '').trim() !== module.name) {
            wx.showToast({ title: '模块名称不一致', icon: 'none' });
            return;
          }
          wx.showModal({
            title: '最后确认删除？',
            content: '7天内可以从“我的-模块回收站”恢复，期满后记录和图片永久删除。',
            confirmText: '移入回收站',
            confirmColor: '#F65451',
            success: async ({ confirm: finalConfirm }) => {
              if (!finalConfirm) return;
              try {
                await deleteModuleToRecycle(moduleId, module.name);
                this.setData({ revealedModuleId: '' });
                await this.loadHome(false);
                wx.showToast({ title: '已移入回收站' });
              } catch {
                wx.showToast({ title: '操作失败，请重试', icon: 'none' });
              }
            },
          });
        },
      });
      return;
    }

    const isLeaving = memberCount > 1;
    wx.showModal({
      title: isLeaving ? '确认退出模块？' : '确认删除模块？',
      content: isLeaving
        ? '退出后模块将从首页移除，你此前留下的历史记录仍会保留。'
        : '模块、日历和其中的全部记录将被永久删除。',
      confirmText: isLeaving ? '退出' : '删除',
      confirmColor: '#F65451',
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          const result = await removeModuleForCurrentUser(moduleId);
          this.setData({ revealedModuleId: '' });
          await this.loadHome(false);
          wx.showToast({ title: result === 'left' ? '已退出模块' : '模块已删除' });
        } catch (error) {
          const needsTransfer = error instanceof Error && error.message === 'MODULE_TRANSFER_REQUIRED';
          wx.showToast({ title: needsTransfer ? '请先转让模块' : '操作失败，请重试', icon: 'none' });
        }
      },
    });
  },

  openCreate(event?: WechatMiniprogram.TouchEvent) {
    const source = (event?.currentTarget.dataset.source as string) || 'floating';
    this.setData({
      createOpen: true,
      createClosing: false,
      createSource: source,
      createName: '',
      createDescription: '',
      selectedTemplateId: '',
      createError: '',
    });
    this.syncTabBarVisibility();
    wx.vibrateShort?.({ type: 'light' });
    track('module_create_sheet_view', { source });
  },

  closeCreate() {
    if (this.data.createClosing) return;
    const hasChanges = Boolean(this.data.createName || this.data.createDescription || this.data.selectedTemplateId);
    if (!hasChanges) {
      void this.dismissCreate();
      return;
    }
    wx.showModal({
      title: '放弃这次创建？',
      content: '已经填写的内容不会保留。',
      confirmText: '放弃',
      confirmColor: '#e65f45',
      success: ({ confirm }) => {
        if (confirm) void this.dismissCreate();
      },
    });
  },

  async dismissCreate() {
    if (!this.data.createOpen || this.data.createClosing) return;
    this.setData({ createClosing: true });
    await waitForSheetMotion();
    if (!this.data.createClosing) return;
    this.setData({ createOpen: false, createClosing: false });
    this.syncTabBarVisibility();
  },

  stopPropagation() {},

  onNameInput(event: InputEvent) {
    this.setData({ createName: event.detail.value, createError: '' });
  },

  onDescriptionInput(event: InputEvent) {
    this.setData({ createDescription: event.detail.value, createError: '' });
  },

  chooseTemplate(event: WechatMiniprogram.TouchEvent) {
    const templateId = event.currentTarget.dataset.id as string;
    const template = this.data.templates.find((item) => item.templateId === templateId);
    if (!template) return;
    this.setData({
      selectedTemplateId: templateId,
      createName: template.name,
      createDescription: template.description,
      createError: '',
    });
    track('module_create_template_click', { templateId });
  },

  async submitCreate() {
    const name = this.data.createName.trim();
    if (!name) {
      this.setData({ createError: '给这段记录起个名字吧' });
      return;
    }
    const description = this.data.createDescription.trim();
    if (name.length > MODULE_NAME_MAX_LENGTH || description.length > MODULE_DESCRIPTION_MAX_LENGTH) {
      this.setData({ createError: `名称最多${MODULE_NAME_MAX_LENGTH}字，简介最多${MODULE_DESCRIPTION_MAX_LENGTH}字` });
      return;
    }
    this.setData({ createSubmitting: true, createError: '' });
    try {
      const module = await createModule({
        name,
        description,
        templateId: this.data.selectedTemplateId || undefined,
        clientRequestId: createId('request'),
      });
      this.setData({ createSubmitting: false });
      await this.dismissCreate();
      await this.loadHome();
      void wx.navigateTo({ url: `/subpackages/module-detail/index?moduleId=${module.moduleId}&new=1` });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const createError = code === 'WECHAT_TOKEN_NOT_READY'
        ? '微信安全服务正在初始化，请稍后重试'
        : '创建没有成功，请再试一次';
      this.setData({ createSubmitting: false, createError });
    }
  },
});
