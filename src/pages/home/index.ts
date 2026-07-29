import type { HomeModuleView, ModuleTemplate, RecordPolicy, User } from '../../types/domain';
import {
  createModule,
  MODULE_DESCRIPTION_MAX_LENGTH,
  MODULE_NAME_MAX_LENGTH,
  getCurrentUser,
  getCalendar,
  getHomeModules,
  getMemoryView,
  getProfileOverview,
  getTemplates,
  PROFILE_NICKNAME_MAX_LENGTH,
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
import { confirmDelete, isSharedModuleCreator, removeModuleWithConfirmation } from '../../utils/module-removal';
import {
  HOME_GROUP_CARD_OPENING_DURATION,
  HOME_GROUP_MOTION,
  HOME_GROUP_OPENING_DURATION,
} from '../../utils/home-group-motion';
import { createHomeModuleLayoutPlan, HOME_PIN_MOTION } from '../../utils/home-pin-motion';
import { preloadImageSources } from '../../utils/image-preload';
import { mergeMemberSnapshot } from '../../utils/member-sync';
import {
  applyHomePreviewUpdates,
  consumeHomePreviewUpdates,
  homePreviewsFromRecords,
  mergeHomePreviewSnapshot,
  needsHomePreviewVerification,
  type AnimatedStickerPreview,
  type HomePreviewUpdate,
} from '../../services/home-preview-cache';

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

interface SelectableHomeModuleView extends HomeModuleView {
  todayPreviewItems: AnimatedStickerPreview[];
  selected: boolean;
  pinShiftActive: boolean;
  pinShiftOffsetRpx: number;
  motionPhase: '' | 'leaving' | 'gap' | 'entering';
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
let homeModuleMotionToken = 0;
let memoryGroupChangeToken = 0;
let memoryLoadToken = 0;
let homeHasLoadedOnce = false;
let homePreviewSyncTimer: ReturnType<typeof setInterval> | undefined;
let homePreviewSyncInFlight = false;
let homePageVisible = false;
let homePreviewSyncGeneration = 0;
let freshHomeStickerTimers: Array<ReturnType<typeof setTimeout>> = [];

const HOME_PREVIEW_SYNC_INTERVAL = 5_000;

const clearPrimaryStickerTimers = () => {
  primaryStickerTimers.forEach((timer) => clearTimeout(timer));
  primaryStickerTimers = [];
};

const clearFreshHomeStickerTimers = () => {
  freshHomeStickerTimers.forEach((timer) => clearTimeout(timer));
  freshHomeStickerTimers = [];
};

const schedulePrimaryStickerState = (callback: () => void, delay: number) => {
  primaryStickerTimers.push(setTimeout(callback, delay));
};

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const sortHomeModules = (modules: HomeModuleView[]): HomeModuleView[] => [...modules].sort((left, right) => {
  const leftActivity = left.lastActivityAt ?? left.updatedAt;
  const rightActivity = right.lastActivityAt ?? right.updatedAt;
  return rightActivity.localeCompare(leftActivity) || right.moduleId.localeCompare(left.moduleId);
});

const selectableModules = (
  modules: HomeModuleView[],
  selectedIds: Set<string>,
): SelectableHomeModuleView[] => sortHomeModules(modules).map((module) => ({
  ...module,
  selected: selectedIds.has(module.moduleId),
  pinShiftActive: false,
  pinShiftOffsetRpx: 0,
  motionPhase: '',
}));

const setCardMotionPhase = (
  modules: SelectableHomeModuleView[],
  moduleIds: Set<string>,
  motionPhase: SelectableHomeModuleView['motionPhase'],
): SelectableHomeModuleView[] => modules.map((module) => ({
  ...module,
  motionPhase: moduleIds.has(module.moduleId) ? motionPhase : module.motionPhase,
}));

const clearHomeMotionFields = (modules: SelectableHomeModuleView[]): SelectableHomeModuleView[] => modules.map((module) => ({
  ...module,
  pinShiftActive: false,
  pinShiftOffsetRpx: 0,
  motionPhase: '',
}));

Page({
  data: {
    statusBarHeight: 24,
    primaryTabIndex: 0,
    homeStickerPhase: 'sticker-hidden',
    memoryStickerPhase: 'sticker-hidden',
    cardGestureActive: false,
    loading: true,
    managing: false,
    removingModules: false,
    selectedModuleIds: [] as string[],
    currentUserId: '',
    pinPopoverModuleId: '',
    pinMovingModuleId: '',
    homeMotionActive: false,
    pinLayoutPhase: '',
    pinNormalGroupOffsetRpx: 0,
    pinLeaveDuration: HOME_PIN_MOTION.leaveDuration,
    pinLayoutDuration: HOME_PIN_MOTION.layoutDuration,
    pinEnterDuration: HOME_PIN_MOTION.enterDuration,
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
    pinnedModules: [] as SelectableHomeModuleView[],
    normalModules: [] as SelectableHomeModuleView[],
    templates: [] as ModuleTemplate[],
    createOpen: false,
    createClosing: false,
    createSource: 'floating',
    createName: '',
    createDescription: '',
    selectedTemplateId: '',
    createRecordPolicy: '' as '' | RecordPolicy,
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
    memoryChangingGroup: false,
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
    homeHasLoadedOnce = false;
    this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.loadTemplates();
  },

  onShow() {
    homePageVisible = true;
    const showToken = ++homeShowToken;
    const routeReady = waitForAppRouteDone();
    clearPrimaryStickerTimers();
    this.syncTabBarVisibility();
    if (this.data.primaryTabIndex === 0) {
      this.setData({ homeStickerPhase: 'sticker-hidden' });
      const homeReady = homeHasLoadedOnce ? Promise.resolve(true) : this.loadHome(true);
      const homeContentReady = homeReady.then(async (loaded) => {
        if (loaded) await this.applyPendingHomePreviewUpdates();
      });
      void Promise.all([homeContentReady, routeReady]).then(() => {
        if (showToken !== homeShowToken || this.data.primaryTabIndex !== 0) return;
        this.playHomeStickerAnimation();
        this.startHomePreviewSync(true);
      });
    } else if (this.data.primaryTabIndex === 1) {
      this.setData({ memoryStickerPhase: 'sticker-hidden' });
      void Promise.all([this.loadMemoryData(), routeReady]).then(() => {
        if (showToken === homeShowToken && this.data.primaryTabIndex === 1) this.playMemoryStickerAnimation();
      });
    } else if (this.data.primaryTabIndex === 3) {
      void this.loadProfileData();
    }
  },

  onHide() {
    homePageVisible = false;
    this.stopHomePreviewSync();
    this.finishFreshHomeStickerAnimation();
    homeShowToken += 1;
    homeModuleMotionToken += 1;
    memoryGroupChangeToken += 1;
    memoryLoadToken += 1;
    clearPrimaryStickerTimers();
    const interruptedHomeMotion = this.data.homeMotionActive
      || this.data.removingModules
      || this.data.createSubmitting
      || Boolean(this.data.pinMovingModuleId)
      || Boolean(this.data.pinLayoutPhase)
      || this.data.pinnedModules.some((module) => module.motionPhase || module.pinShiftActive)
      || this.data.normalModules.some((module) => module.motionPhase || module.pinShiftActive);
    if (interruptedHomeMotion) homeHasLoadedOnce = false;
    this.setData({
      pinPopoverModuleId: '',
      pinMovingModuleId: '',
      homeMotionActive: false,
      managing: false,
      removingModules: false,
      selectedModuleIds: [],
      pinLayoutPhase: '',
      pinNormalGroupOffsetRpx: 0,
      ...(interruptedHomeMotion ? {
        pinnedModules: clearHomeMotionFields(this.data.pinnedModules),
        normalModules: clearHomeMotionFields(this.data.normalModules),
      } : {}),
      memoryChangingGroup: false,
    });
  },

  onUnload() {
    homePageVisible = false;
    this.stopHomePreviewSync();
    this.finishFreshHomeStickerAnimation();
    homeShowToken += 1;
    homeModuleMotionToken += 1;
    memoryGroupChangeToken += 1;
    memoryLoadToken += 1;
    clearPrimaryStickerTimers();
  },

  syncTabBarVisibility() {
    const hidden = this.data.managing || hasOpenBottomSheet(
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
      managing: false,
      selectedModuleIds: [],
      pinPopoverModuleId: '',
      cardGestureActive: false,
    }, () => this.syncTabBarVisibility());
  },

  onPrimarySwiperChange(event: WechatMiniprogram.CustomEvent<{ current: number }>) {
    const index = event.detail.current;
    this.setData({
      primaryTabIndex: index,
      managing: false,
      selectedModuleIds: [],
      pinPopoverModuleId: '',
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
      if (index === 0) {
        this.playHomeStickerAnimation();
        if (homePageVisible) this.startHomePreviewSync(true);
      } else {
        this.stopHomePreviewSync();
      }
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

  async loadMemoryData(
    forceChange = false,
    animate = forceChange,
    beforeApply: Promise<void> = Promise.resolve(),
    preserveOnFailure = false,
    prepareItems?: (items: Array<{ stickerPath: string }>) => Promise<void>,
  ): Promise<boolean> {
    const loadToken = ++memoryLoadToken;
    try {
      const view = await getMemoryView(this.data.memorySelectedModuleId || undefined, this.data.memoryMonth, forceChange);
      await prepareItems?.(view.items);
      await beforeApply;
      if (loadToken !== memoryLoadToken) return false;
      const stickerPlan = createStickerDelays(view.items.map((item) => item.recordId));
      await new Promise<void>((resolve) => this.setData({
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
        }, () => {
          if (animate) this.playMemoryStickerAnimation();
          resolve();
        }));
      return true;
    } catch {
      await beforeApply;
      if (loadToken !== memoryLoadToken) return false;
      if (preserveOnFailure) {
        this.setData({ memoryStickerPhase: 'sticker-visible' });
        return false;
      }
      this.setData({ memoryStickers: [], memorySelectedModuleId: '', memorySelectedModuleName: '' });
      return false;
    }
  },

  async changeMemoryGroup() {
    if (this.data.memoryChangingGroup) return;
    const token = ++memoryGroupChangeToken;
    clearPrimaryStickerTimers();
    this.setData({ memoryChangingGroup: true });
    track('memory_change_group_click', { moduleId: this.data.memorySelectedModuleId, month: this.data.memoryMonth });
    const loaded = await this.loadMemoryData(
      true,
      true,
      Promise.resolve(),
      true,
      async (items) => {
        await preloadImageSources(items.map((item) => item.stickerPath));
        if (token !== memoryGroupChangeToken) return;
        if (!this.data.memoryStickers.length) {
          this.setData({ memoryStickerPhase: 'sticker-hidden' });
          return;
        }
        this.setData({ memoryStickerPhase: 'sticker-leaving' });
        await wait(STICKER_MOTION.oldPageFadeDuration);
      },
    );
    if (token !== memoryGroupChangeToken) return;
    if (loaded) {
      await wait(STICKER_MOTION.pageSettledDelay + this.data.memoryStickerFinalDelay + STICKER_MOTION.duration);
      if (token !== memoryGroupChangeToken) return;
    }
    this.setData({ memoryChangingGroup: false });
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
    context.fillText('Note4Seven · 七日记', 64, 920);
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
      this.getTabBar?.()?.setData({ profileHasUnread: overview.unreadCount > 0 });
      track('profile_view', { recordedDays: overview.recordedDays, activeModuleCount: overview.moduleCount });
    } catch {
      wx.showToast({ title: '个人资料加载失败', icon: 'none' });
    }
  },

  syncUnreadNotificationCount(unreadCount: number) {
    if (unreadCount !== this.data.profileUnreadCount) this.setData({ profileUnreadCount: unreadCount });
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

  async loadHome(showLoading = true): Promise<boolean> {
    if (showLoading) this.setData({ loading: true });
    try {
      const [result, currentUser] = await Promise.all([
        getHomeModules({ reconcileNotifications: showLoading }),
        this.data.currentUserId ? Promise.resolve(null) : getCurrentUser(),
      ]);
      const selectedIds = new Set(this.data.managing ? this.data.selectedModuleIds : []);
      const pinnedModules = selectableModules(result.pinned, selectedIds);
      const normalModules = selectableModules(result.normal, selectedIds);
      const modulesChanged = JSON.stringify(this.data.pinnedModules) !== JSON.stringify(pinnedModules)
        || JSON.stringify(this.data.normalModules) !== JSON.stringify(normalModules);
      homeHasLoadedOnce = true;
      this.setData({
        ...(modulesChanged ? { pinnedModules, normalModules } : {}),
        ...(currentUser ? { currentUserId: currentUser.userId } : {}),
        loading: false,
      });
      track('home_view', {
        pinnedModuleCount: result.pinned.length,
        normalModuleCount: result.normal.length,
        isEmpty: result.pinned.length + result.normal.length === 0,
      });
      return true;
    } catch {
      if (showLoading || !homeHasLoadedOnce) {
        this.setData({ loading: false });
        wx.showToast({ title: '首页加载失败', icon: 'none' });
      } else {
        console.warn('[home] background refresh failed; keeping cached modules');
      }
      return false;
    }
  },

  async applyPendingHomePreviewUpdates(): Promise<boolean> {
    const updates = await consumeHomePreviewUpdates();
    if (!updates.length) return false;
    const updatesByModule = updates.reduce<Map<string, HomePreviewUpdate[]>>((grouped, update) => {
      grouped.set(update.moduleId, [...(grouped.get(update.moduleId) ?? []), update]);
      return grouped;
    }, new Map());
    const patch: Record<string, unknown> = {};
    (['pinnedModules', 'normalModules'] as const).forEach((groupName) => {
      this.data[groupName].forEach((module, index) => {
        const moduleUpdates = updatesByModule.get(module.moduleId);
        if (!moduleUpdates) return;
        const previews = applyHomePreviewUpdates(module.todayPreviewItems, moduleUpdates);
        patch[`${groupName}[${index}].todayPreviewItems`] = previews;
      });
    });
    if (!Object.keys(patch).length) return false;
    this.setData(patch);
    return true;
  },

  startHomePreviewSync(immediate = false) {
    this.stopHomePreviewSync(false);
    homePreviewSyncTimer = setInterval(() => void this.syncHomePreviewsInBackground(), HOME_PREVIEW_SYNC_INTERVAL);
    if (immediate) void this.syncHomePreviewsInBackground(true);
  },

  stopHomePreviewSync(invalidate = true) {
    if (homePreviewSyncTimer) clearInterval(homePreviewSyncTimer);
    homePreviewSyncTimer = undefined;
    if (invalidate) homePreviewSyncGeneration += 1;
  },

  finishFreshHomeStickerAnimation() {
    clearFreshHomeStickerTimers();
    const patch: Record<string, unknown> = {};
    (['pinnedModules', 'normalModules'] as const).forEach((groupName) => {
      this.data[groupName].forEach((module, moduleIndex) => {
        module.todayPreviewItems.forEach((preview, previewIndex) => {
          if (preview.motionPhase) {
            patch[`${groupName}[${moduleIndex}].todayPreviewItems[${previewIndex}].motionPhase`] = '';
          }
        });
      });
    });
    if (Object.keys(patch).length) this.setData(patch);
  },

  playFreshHomeStickerAnimation(locations: Array<{ groupName: 'pinnedModules' | 'normalModules'; moduleIndex: number; previewIndex: number }>) {
    if (!locations.length) return;
    freshHomeStickerTimers.push(setTimeout(() => {
      const enteringPatch = locations.reduce<Record<string, unknown>>((patch, location) => {
        patch[`${location.groupName}[${location.moduleIndex}].todayPreviewItems[${location.previewIndex}].motionPhase`] = 'sticker-entering';
        return patch;
      }, {});
      this.setData(enteringPatch);
    }, STICKER_MOTION.pageSettledDelay));
    freshHomeStickerTimers.push(setTimeout(() => {
      const visiblePatch = locations.reduce<Record<string, unknown>>((patch, location) => {
        patch[`${location.groupName}[${location.moduleIndex}].todayPreviewItems[${location.previewIndex}].motionPhase`] = '';
        return patch;
      }, {});
      this.setData(visiblePatch);
      freshHomeStickerTimers = [];
    }, STICKER_MOTION.pageSettledDelay + STICKER_MOTION.duration));
  },

  async syncHomePreviewsInBackground(verifyUnderfilled = false) {
    if (homePreviewSyncInFlight
      || !homePageVisible
      || this.data.primaryTabIndex !== 0
      || this.data.loading
      || this.data.managing
      || this.data.homeMotionActive
      || this.data.createOpen) return;
    homePreviewSyncInFlight = true;
    const generation = homePreviewSyncGeneration;
    try {
      const result = await getHomeModules({ reconcileNotifications: false });
      if (generation !== homePreviewSyncGeneration || !homePageVisible || this.data.primaryTabIndex !== 0) return;
      const incomingByModule = new Map([...result.pinned, ...result.normal].map((module) => [module.moduleId, module]));
      await Promise.all([...this.data.pinnedModules, ...this.data.normalModules].map(async (module) => {
        const incoming = incomingByModule.get(module.moduleId);
        if (!incoming || !needsHomePreviewVerification(
          module.todayPreviewItems,
          incoming.todayPreviewItems,
          incoming.members,
          verifyUnderfilled,
        )) return;
        try {
          const today = shanghaiDate();
          const calendar = await getCalendar(module.moduleId, monthOf(today));
          incoming.todayPreviewItems = homePreviewsFromRecords(
            calendar.find((cell) => cell.date === today)?.records ?? [],
          );
        } catch {
          incoming.todayPreviewItems = module.todayPreviewItems;
        }
      }));
      if (generation !== homePreviewSyncGeneration || !homePageVisible || this.data.primaryTabIndex !== 0) return;
      const plans: Array<{
        groupName: 'pinnedModules' | 'normalModules';
        moduleIndex: number;
        previews: AnimatedStickerPreview[];
        animatedIndexes: number[];
      }> = [];
      const animatedSources: string[] = [];
      const syncPatch: Record<string, unknown> = {};
      (['pinnedModules', 'normalModules'] as const).forEach((groupName) => {
        this.data[groupName].forEach((module, moduleIndex) => {
          const incoming = incomingByModule.get(module.moduleId);
          if (!incoming) return;
          if (incoming.unreadInboxCount !== module.unreadInboxCount) {
            syncPatch[`${groupName}[${moduleIndex}].unreadInboxCount`] = incoming.unreadInboxCount;
          }
          const memberPlan = mergeMemberSnapshot(module.members, incoming.members);
          if (memberPlan.changed) {
            syncPatch[`${groupName}[${moduleIndex}].members`] = memberPlan.members;
            animatedSources.push(...memberPlan.avatarSources);
          }
          const previewPlan = mergeHomePreviewSnapshot(module.todayPreviewItems, incoming.todayPreviewItems);
          if (previewPlan.changed) {
            animatedSources.push(...previewPlan.animatedSources);
            plans.push({
              groupName,
              moduleIndex,
              previews: previewPlan.previews,
              animatedIndexes: previewPlan.animatedIndexes,
            });
          }
        });
      });
      await preloadImageSources(animatedSources);
      if (generation !== homePreviewSyncGeneration || !homePageVisible || this.data.primaryTabIndex !== 0) return;
      if (!plans.length && !Object.keys(syncPatch).length) return;
      this.finishFreshHomeStickerAnimation();
      const patch: Record<string, unknown> = { ...syncPatch };
      const locations: Array<{ groupName: 'pinnedModules' | 'normalModules'; moduleIndex: number; previewIndex: number }> = [];
      plans.forEach((plan) => {
        patch[`${plan.groupName}[${plan.moduleIndex}].todayPreviewItems`] = plan.previews;
        plan.animatedIndexes.forEach((previewIndex) => locations.push({
          groupName: plan.groupName,
          moduleIndex: plan.moduleIndex,
          previewIndex,
        }));
      });
      this.setData(patch, () => this.playFreshHomeStickerAnimation(locations));
    } catch {
      // Keep cached modules visible while the next foreground reconciliation retries.
    } finally {
      homePreviewSyncInFlight = false;
    }
  },

  toggleManage() {
    const managing = !this.data.managing;
    this.setData({
      managing,
      selectedModuleIds: [],
      pinnedModules: this.data.pinnedModules.map((module) => ({ ...module, selected: false })),
      normalModules: this.data.normalModules.map((module) => ({ ...module, selected: false })),
      pinPopoverModuleId: '',
      pinnedExpanded: managing ? true : this.data.pinnedExpanded,
      normalExpanded: managing ? true : this.data.normalExpanded,
      pinnedExpanding: false,
      normalExpanding: false,
      pinnedCollapsing: false,
      normalCollapsing: false,
    }, () => this.syncTabBarVisibility());
    track(managing ? 'home_manage_view' : 'home_manage_close');
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
    if (cardTouchMoved) return;
    const moduleId = event.currentTarget.dataset.id as string;
    if (this.data.managing) {
      this.toggleModuleSelection(moduleId);
      return;
    }
    if (this.data.pinPopoverModuleId) {
      this.setData({ pinPopoverModuleId: '' });
      return;
    }
    track('home_module_click', { moduleId });
    void wx.navigateTo({ url: `/subpackages/module-detail/index?moduleId=${moduleId}` });
  },

  onModuleLongPress(event: WechatMiniprogram.TouchEvent) {
    if (this.data.managing || this.data.homeMotionActive) return;
    const moduleId = event.currentTarget.dataset.id as string;
    const pinned = event.currentTarget.dataset.pinned === true || event.currentTarget.dataset.pinned === 'true';
    cardTouchMoved = true;
    this.setData({
      pinPopoverModuleId: moduleId,
      pinnedExpanded: pinned ? true : this.data.pinnedExpanded,
      normalExpanded: pinned ? this.data.normalExpanded : true,
    });
    wx.vibrateShort?.({ type: 'light' });
  },

  async togglePinFromBubble(event: WechatMiniprogram.TouchEvent) {
    if (this.data.homeMotionActive) return;
    const moduleId = event.currentTarget.dataset.id as string;
    const module = [...this.data.pinnedModules, ...this.data.normalModules]
      .find((item) => item.moduleId === moduleId);
    if (!module) return;
    const targetPinned = !module.pinned;
    const token = ++homeModuleMotionToken;
    const movingIds = new Set([moduleId]);
    this.setData({
      pinPopoverModuleId: '',
      pinMovingModuleId: moduleId,
      homeMotionActive: true,
      pinnedModules: setCardMotionPhase(this.data.pinnedModules, movingIds, 'leaving'),
      normalModules: setCardMotionPhase(this.data.normalModules, movingIds, 'leaving'),
    });
    try {
      let requestFailed = false;
      let requestError: unknown;
      await Promise.all([
        setModulePinned(moduleId, targetPinned).catch((error: unknown) => {
          requestFailed = true;
          requestError = error;
        }),
        wait(HOME_PIN_MOTION.leaveDuration),
      ]);
      if (token !== homeModuleMotionToken) return;
      if (requestFailed) throw requestError;

      const movedModule: HomeModuleView = { ...module, pinned: targetPinned };
      const pinnedModules = this.data.pinnedModules.filter((item) => item.moduleId !== moduleId);
      const normalModules = this.data.normalModules.filter((item) => item.moduleId !== moduleId);
      if (targetPinned) pinnedModules.push(movedModule as SelectableHomeModuleView);
      else normalModules.push(movedModule as SelectableHomeModuleView);

      const nextPinnedModules = selectableModules(pinnedModules, new Set());
      const nextNormalModules = selectableModules(normalModules, new Set());
      if (!(await this.runHomeLayoutTransition(nextPinnedModules, nextNormalModules, moduleId, token))) return;
      this.setData({
        pinMovingModuleId: '',
        homeMotionActive: false,
      });
      track('home_module_pin_change', { moduleId, action: targetPinned ? 'pin' : 'unpin' });
    } catch {
      if (token !== homeModuleMotionToken) return;
      this.setData({
        pinnedModules: setCardMotionPhase(this.data.pinnedModules, movingIds, 'entering'),
        normalModules: setCardMotionPhase(this.data.normalModules, movingIds, 'entering'),
      });
      await wait(HOME_PIN_MOTION.enterDuration);
      if (token !== homeModuleMotionToken) return;
      this.setData({
        pinMovingModuleId: '',
        homeMotionActive: false,
        pinLayoutPhase: '',
        pinNormalGroupOffsetRpx: 0,
        pinnedModules: clearHomeMotionFields(this.data.pinnedModules),
        normalModules: clearHomeMotionFields(this.data.normalModules),
      });
      wx.showToast({ title: '置顶操作失败', icon: 'none' });
    }
  },

  async runHomeLayoutTransition(
    nextPinnedModules: SelectableHomeModuleView[],
    nextNormalModules: SelectableHomeModuleView[],
    enteringModuleId: string,
    token: number,
  ): Promise<boolean> {
    const layoutPlan = createHomeModuleLayoutPlan({
      pinnedBefore: this.data.pinnedModules.map((item) => item.moduleId),
      normalBefore: this.data.normalModules.map((item) => item.moduleId),
      pinnedAfter: nextPinnedModules.map((item) => item.moduleId),
      normalAfter: nextNormalModules.map((item) => item.moduleId),
    });
    const prepareLayout = (items: SelectableHomeModuleView[]): SelectableHomeModuleView[] => items.map((item) => ({
      ...item,
      pinShiftActive: layoutPlan.moduleOffsetsRpx[item.moduleId] !== undefined,
      pinShiftOffsetRpx: layoutPlan.moduleOffsetsRpx[item.moduleId] ?? 0,
      motionPhase: item.moduleId === enteringModuleId ? 'gap' : '',
    }));

    await new Promise<void>((resolve) => this.setData({
      pinnedModules: prepareLayout(nextPinnedModules),
      normalModules: prepareLayout(nextNormalModules),
      pinnedExpanded: true,
      normalExpanded: true,
      pinLayoutPhase: 'positioned',
      pinNormalGroupOffsetRpx: layoutPlan.normalGroupOffsetRpx,
    }, resolve));
    await wait(HOME_PIN_MOTION.layoutFrameDelay);
    if (token !== homeModuleMotionToken) return false;
    this.setData({ pinLayoutPhase: 'shifting' });
    await wait(HOME_PIN_MOTION.layoutDuration);
    if (token !== homeModuleMotionToken) return false;
    this.setData({ pinLayoutPhase: '', pinNormalGroupOffsetRpx: 0 });

    if (enteringModuleId) {
      const enteringIds = new Set([enteringModuleId]);
      this.setData({
        pinnedModules: setCardMotionPhase(this.data.pinnedModules, enteringIds, 'entering'),
        normalModules: setCardMotionPhase(this.data.normalModules, enteringIds, 'entering'),
      });
      await wait(HOME_PIN_MOTION.enterDuration);
      if (token !== homeModuleMotionToken) return false;
    }

    this.setData({
      pinnedModules: clearHomeMotionFields(this.data.pinnedModules),
      normalModules: clearHomeMotionFields(this.data.normalModules),
    });
    return true;
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
    if (this.data.pinPopoverModuleId) this.setData({ pinPopoverModuleId: '' });
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

  toggleModuleSelection(moduleId: string) {
    if (this.data.removingModules) return;
    const selectedIds = new Set(this.data.selectedModuleIds);
    if (selectedIds.has(moduleId)) selectedIds.delete(moduleId);
    else selectedIds.add(moduleId);
    const applySelection = (modules: SelectableHomeModuleView[]) => modules.map((module) => ({
      ...module,
      selected: selectedIds.has(module.moduleId),
    }));
    this.setData({
      selectedModuleIds: [...selectedIds],
      pinnedModules: applySelection(this.data.pinnedModules),
      normalModules: applySelection(this.data.normalModules),
    });
  },

  onModuleSelectionTap(event: WechatMiniprogram.TouchEvent) {
    this.toggleModuleSelection(event.currentTarget.dataset.id as string);
  },

  async removeSelectedModules() {
    if (this.data.removingModules || !this.data.selectedModuleIds.length) return;
    const selectedIds = new Set(this.data.selectedModuleIds);
    const modules = [...this.data.pinnedModules, ...this.data.normalModules]
      .filter((module) => selectedIds.has(module.moduleId));
    if (!modules.length) return;
    const sharedCreatorOnly = modules.length === 1
      && isSharedModuleCreator(modules[0], this.data.currentUserId);
    if (!sharedCreatorOnly && !(await confirmDelete())) return;

    const token = ++homeModuleMotionToken;
    this.setData({ removingModules: true });
    const completedIds: string[] = [];
    let failed = 0;
    for (const module of modules) {
      try {
        const result = await removeModuleWithConfirmation(module, this.data.currentUserId, {
          simpleRemovalConfirmed: !sharedCreatorOnly,
        });
        if (token !== homeModuleMotionToken) {
          homeHasLoadedOnce = false;
          return;
        }
        if (result !== 'cancelled') completedIds.push(module.moduleId);
      } catch {
        failed += 1;
      }
    }
    if (!completedIds.length) {
      this.setData({ removingModules: false });
      if (failed) {
        wx.showToast({ title: `${failed}个模块删除失败`, icon: 'none' });
      }
      return;
    }

    const completedIdSet = new Set(completedIds);
    this.setData({
      homeMotionActive: true,
      pinnedModules: setCardMotionPhase(this.data.pinnedModules, completedIdSet, 'leaving'),
      normalModules: setCardMotionPhase(this.data.normalModules, completedIdSet, 'leaving'),
    });
    await wait(HOME_PIN_MOTION.leaveDuration);
    if (token !== homeModuleMotionToken) return;

    const nextPinnedModules = selectableModules(
      this.data.pinnedModules.filter((module) => !completedIdSet.has(module.moduleId)),
      new Set(),
    );
    const nextNormalModules = selectableModules(
      this.data.normalModules.filter((module) => !completedIdSet.has(module.moduleId)),
      new Set(),
    );
    if (!(await this.runHomeLayoutTransition(nextPinnedModules, nextNormalModules, '', token))) return;
    await new Promise<void>((resolve) => this.setData({
      removingModules: false,
      selectedModuleIds: [],
      managing: false,
      homeMotionActive: false,
    }, () => {
      this.syncTabBarVisibility();
      resolve();
    }));
    if (failed) {
      wx.showToast({ title: `${failed}个模块删除失败`, icon: 'none' });
    } else {
      wx.showToast({ title: completedIds.length > 1 ? `已删除${completedIds.length}个模块` : '模块已删除' });
    }
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
      createRecordPolicy: '',
      createError: '',
      normalExpanded: true,
    });
    this.syncTabBarVisibility();
    wx.vibrateShort?.({ type: 'light' });
    track('module_create_sheet_view', { source });
  },

  closeCreate() {
    if (this.data.createClosing) return;
    const hasChanges = Boolean(this.data.createName || this.data.createDescription
      || this.data.selectedTemplateId || this.data.createRecordPolicy);
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

  chooseRecordPolicy(event: WechatMiniprogram.TouchEvent) {
    const recordPolicy = event.currentTarget.dataset.policy as RecordPolicy;
    if (recordPolicy !== 'strict' && recordPolicy !== 'relaxed') return;
    this.setData({ createRecordPolicy: recordPolicy, createError: '' });
    track('module_create_record_policy_click', { recordPolicy });
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
    if (!this.data.createRecordPolicy) {
      this.setData({ createError: '请选择记录模式' });
      return;
    }
    const token = ++homeModuleMotionToken;
    this.setData({ createSubmitting: true, createError: '' });
    try {
      const module = await createModule({
        name,
        description,
        recordPolicy: this.data.createRecordPolicy,
        templateId: this.data.selectedTemplateId || undefined,
        clientRequestId: createId('request'),
      });
      if (token !== homeModuleMotionToken) {
        homeHasLoadedOnce = false;
        return;
      }
      this.setData({ createSubmitting: false });
      await this.dismissCreate();
      if (token !== homeModuleMotionToken) {
        homeHasLoadedOnce = false;
        return;
      }

      const createdModule: HomeModuleView = {
        ...module,
        pinned: false,
        unreadInboxCount: 0,
        lastActivityAt: module.updatedAt,
        todayPreviewItems: [],
      };
      const nextNormalModules = selectableModules(
        [...this.data.normalModules, createdModule],
        new Set(),
      );
      this.setData({ homeMotionActive: true });
      if (!(await this.runHomeLayoutTransition(
        selectableModules(this.data.pinnedModules, new Set()),
        nextNormalModules,
        module.moduleId,
        token,
      ))) return;
      await new Promise<void>((resolve) => this.setData({ homeMotionActive: false }, resolve));
      void wx.navigateTo({ url: `/subpackages/module-detail/index?moduleId=${module.moduleId}&new=1` });
    } catch (error) {
      if (token !== homeModuleMotionToken) return;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const createError = code === 'WECHAT_TOKEN_NOT_READY'
        ? '微信安全服务正在初始化，请稍后重试'
        : '创建没有成功，请再试一次';
      this.setData({ createSubmitting: false, createError });
    }
  },
});
