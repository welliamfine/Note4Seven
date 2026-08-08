import type { HomeModuleView, ModuleTemplate, RecordPolicy, User } from '../../types/domain';
import {
  createModule,
  MODULE_DESCRIPTION_MAX_LENGTH,
  MODULE_NAME_MAX_LENGTH,
  getCurrentUser,
  getCalendar,
  getHomeModules,
  getProfileOverview,
  getTemplates,
  PROFILE_NICKNAME_MAX_LENGTH,
  setModulePinned,
  updateCurrentUserProfile,
  type MemoryCollageItem,
  type MemoryModuleOption,
  type MemoryReportMode,
  type MemoryView,
} from '../../services/api';
import { track } from '../../services/tracker';
import {
  monthLabel,
  monthOf,
  nextMonth,
  nextWeek,
  previousMonth,
  previousWeek,
  shanghaiDate,
  weekRangeLabel,
  weekStartOf,
} from '../../utils/date';
import { createId } from '../../utils/id';
import {
  buildMemoryPresentation,
  type MemoryCalendarCellPresentation,
  type MemoryMetricPresentation,
  type MemoryWeekCellPresentation,
} from '../../utils/memory-presentation';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { memoryCollageBoardBackgroundStyle, memoryCollageItemStyle } from '../../utils/memory-collage';
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
  fetchMemoryView,
  memoryViewImageSources,
  type MemoryViewQuery,
} from '../../utils/memory-view-cache';
import {
  advanceMemoryTextClass,
  changedMemoryTextClass,
  memoryReportMotionState,
  prewarmMemoryReport,
  runMemoryCollageActionTransition,
  runMemoryReportTransition,
  swapMemoryTextClass,
} from '../../utils/memory-report-transition';
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
  moduleId: string;
  recordDate: string;
  path: string;
  popDelay: number;
  positionClass: string;
}

interface FilterModuleOption extends MemoryModuleOption {
  selected: boolean;
}

interface SavedCollagePreviewItem extends MemoryCollageItem {
  style: string;
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
let memoryReportTransitionToken = 0;
let homeHasLoadedOnce = false;
let memoryHasLoadedOnce = false;
let memoryEntrySettled = false;
let memoryEntryLoadPromise: Promise<boolean> | undefined;
let homePreviewSyncTimer: ReturnType<typeof setInterval> | undefined;
let homePreviewSyncInFlight = false;
let homePageVisible = false;
let homePreviewSyncGeneration = 0;
let freshHomeStickerTimers: Array<ReturnType<typeof setTimeout>> = [];

const HOME_PREVIEW_SYNC_INTERVAL = 5_000;
const MEMORY_COLLAGE_BACKGROUND = '/assets/ui/memory-collage-board.webp';
const DISCOVER_PAGE_PATH = '/pages/discover/index';

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
const memoryToday = () => shanghaiDate();

const memoryPeriodLabel = (mode: MemoryReportMode, period: string): string => (
  mode === 'month' ? monthLabel(period) : weekRangeLabel(period)
);

const shiftMemoryPeriod = (mode: MemoryReportMode, period: string, direction: -1 | 1): string => {
  if (mode === 'month') return direction < 0 ? previousMonth(period) : nextMonth(period);
  return direction < 0 ? previousWeek(period) : nextWeek(period);
};

const isFutureMemoryPeriod = (mode: MemoryReportMode, period: string): boolean => {
  const current = mode === 'month' ? monthOf(memoryToday()) : weekStartOf(memoryToday());
  return period > current;
};

const memoryCanvasImagePath = (source: string): Promise<string> => new Promise((resolve) => {
  wx.getImageInfo({
    src: source,
    success: ({ path }) => resolve(path),
    fail: () => resolve(source),
  });
});

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
    recordPolicyHelpOpen: false,
    recordPolicyHelpClosing: false,
    createSource: 'floating',
    createName: '',
    createDescription: '',
    selectedTemplateId: '',
    createRecordPolicy: '' as '' | RecordPolicy,
    createSubmitting: false,
    createError: '',
    memoryReportMode: 'month' as MemoryReportMode,
    memoryReportTabMode: 'month' as MemoryReportMode,
    memoryPeriodKey: monthOf(memoryToday()),
    memorySelectedMonth: monthOf(memoryToday()),
    memorySelectedWeek: weekStartOf(memoryToday()),
    memoryPeriodLabel: monthLabel(monthOf(memoryToday())),
    memoryStatusLabel: '进行中',
    memoryScopeLabel: '全部模块',
    memorySelectedModuleId: '',
    memorySelectedModuleName: '',
    memoryModules: [] as MemoryModuleOption[],
    memoryFilterModules: [] as FilterModuleOption[],
    memoryMomentCount: 0,
    memoryRecordedDays: 0,
    memoryReportActionLabel: '查看完整月报',
    memorySummaryTitle: '',
    memoryLatestStickerPath: '',
    memoryHasData: false,
    memoryHasPartnerModules: false,
    memoryMetrics: [] as MemoryMetricPresentation[],
    memoryCalendarCells: [] as MemoryCalendarCellPresentation[],
    memoryWeekCells: [] as MemoryWeekCellPresentation[],
    memoryActivitySummary: '',
    memoryTimeSummary: '',
    memoryStickers: [] as AnimatedSticker[],
    memoryHasSavedCollage: false,
    memoryCollageActionPhase: 'action-visible',
    memorySavedCollageBoardPath: '',
    memoryCollageBoardBackgroundStyle: memoryCollageBoardBackgroundStyle(),
    memorySavedCollageItems: [] as SavedCollagePreviewItem[],
    memoryStickerFinalDelay: 0,
    memorySummaryStickerPhase: 'sticker-hidden',
    memorySummaryMetaMotionClass: 'memory-text-visible',
    memorySummaryPeriodMotionClass: 'memory-text-visible',
    memorySummaryCountMotionClass: 'memory-text-visible',
    memorySummaryActionMotionClass: 'memory-text-visible',
    memoryMetricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
    memoryBoardPhase: 'memory-surface-visible',
    memoryHeatmapPhase: 'memory-surface-visible',
    memoryReportTransitioning: false,
    memoryChangingGroup: false,
    memoryCanGoNext: false,
    memoryLoading: true,
    memoryErrorMessage: '',
    memorySelectionOpen: false,
    memorySelectionClosing: false,
    memoryDraftModuleId: '',
    memoryDraftPeriodKey: monthOf(memoryToday()),
    memoryDraftPeriodLabel: monthLabel(monthOf(memoryToday())),
    memoryDraftCanGoNext: false,
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
    memoryHasLoadedOnce = false;
    memoryEntrySettled = false;
    memoryEntryLoadPromise = undefined;
    this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.loadTemplates();
  },

  onShow() {
    homePageVisible = true;
    const collageSaved = Boolean(wx.getStorageSync?.('notemylife.memory.collage.saved'));
    if (collageSaved) {
      wx.removeStorageSync?.('notemylife.memory.collage.saved');
      memoryHasLoadedOnce = false;
    }
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
      void this.refreshMemoryDataInBackground();
    } else if (this.data.primaryTabIndex === 1) {
      memoryEntrySettled = false;
      this.setData({ memoryStickerPhase: 'sticker-hidden', memorySummaryStickerPhase: 'sticker-hidden' });
      void routeReady.then(() => {
        if (showToken !== homeShowToken || this.data.primaryTabIndex !== 1) return;
        memoryEntrySettled = true;
        this.tryPlayMemoryEntryAnimation();
      });
      void this.ensureMemoryDataLoaded().then((loaded) => {
        if (loaded) this.tryPlayMemoryEntryAnimation();
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
    memoryReportTransitionToken += 1;
    memoryEntrySettled = false;
    memoryEntryLoadPromise = undefined;
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
      memoryReportTransitioning: false,
      memoryReportTabMode: this.data.memoryReportMode,
      memorySummaryMetaMotionClass: 'memory-text-visible',
      memorySummaryPeriodMotionClass: 'memory-text-visible',
      memorySummaryCountMotionClass: 'memory-text-visible',
      memorySummaryActionMotionClass: 'memory-text-visible',
      memoryMetricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
      memorySummaryStickerPhase: 'sticker-visible',
      memoryBoardPhase: 'memory-surface-visible',
      memoryHeatmapPhase: 'memory-surface-visible',
      memoryCollageActionPhase: this.data.memoryHasSavedCollage ? 'action-hidden' : 'action-visible',
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
    memoryReportTransitionToken += 1;
    memoryEntrySettled = false;
    memoryEntryLoadPromise = undefined;
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
    if (index === 2) {
      if (typeof wx.switchTab === 'function') void wx.switchTab({ url: DISCOVER_PAGE_PATH });
      return;
    }
    if (index < 0 || index > 3 || index === this.data.primaryTabIndex) return;
    cardGestureInProgress = false;
    const leavingMemory = this.data.primaryTabIndex === 1 && index !== 1;
    if (leavingMemory) memoryReportTransitionToken += 1;
    if (index === 1) memoryEntrySettled = false;
    this.setData({
      primaryTabIndex: index,
      ...(index === 0 ? { homeStickerPhase: 'sticker-hidden' } : {}),
      ...(index === 1 ? {
        memoryStickerPhase: 'sticker-hidden',
        memorySummaryStickerPhase: 'sticker-hidden',
      } : {}),
      managing: false,
      selectedModuleIds: [],
      pinPopoverModuleId: '',
      cardGestureActive: false,
      ...(leavingMemory ? {
        memoryReportTransitioning: false,
        memoryReportTabMode: this.data.memoryReportMode,
        memorySummaryMetaMotionClass: 'memory-text-visible',
        memorySummaryPeriodMotionClass: 'memory-text-visible',
        memorySummaryCountMotionClass: 'memory-text-visible',
        memorySummaryActionMotionClass: 'memory-text-visible',
        memoryMetricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
        memorySummaryStickerPhase: 'sticker-visible',
        memoryBoardPhase: 'memory-surface-visible',
        memoryHeatmapPhase: 'memory-surface-visible',
        memoryCollageActionPhase: this.data.memoryHasSavedCollage ? 'action-hidden' : 'action-visible',
      } : {}),
    }, () => this.syncTabBarVisibility());
  },

  onPrimarySwiperChange(event: WechatMiniprogram.CustomEvent<{ current: number }>) {
    const index = event.detail.current;
    if (index === 2) {
      if (typeof wx.switchTab === 'function') void wx.switchTab({ url: DISCOVER_PAGE_PATH });
      return;
    }
    const leavingMemory = this.data.primaryTabIndex === 1 && index !== 1;
    if (leavingMemory) memoryReportTransitionToken += 1;
    this.setData({
      primaryTabIndex: index,
      managing: false,
      selectedModuleIds: [],
      pinPopoverModuleId: '',
      cardGestureActive: false,
      ...(leavingMemory ? {
        memoryReportTransitioning: false,
        memoryReportTabMode: this.data.memoryReportMode,
        memorySummaryMetaMotionClass: 'memory-text-visible',
        memorySummaryPeriodMotionClass: 'memory-text-visible',
        memorySummaryCountMotionClass: 'memory-text-visible',
        memorySummaryActionMotionClass: 'memory-text-visible',
        memoryMetricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
        memorySummaryStickerPhase: 'sticker-visible',
        memoryBoardPhase: 'memory-surface-visible',
        memoryHeatmapPhase: 'memory-surface-visible',
        memoryCollageActionPhase: this.data.memoryHasSavedCollage ? 'action-hidden' : 'action-visible',
      } : {}),
    });
    this.syncTabBarVisibility();
    if (index === 1) {
      memoryEntrySettled = false;
      clearPrimaryStickerTimers();
      this.setData({ memoryStickerPhase: 'sticker-hidden', memorySummaryStickerPhase: 'sticker-hidden' });
      void this.ensureMemoryDataLoaded().then((loaded) => {
        if (loaded) this.tryPlayMemoryEntryAnimation();
      });
      track('memory_view', { reportMode: this.data.memoryReportMode });
    } else if (index === 3) {
      this.loadProfileData();
    }
  },

  onPrimarySwiperAnimationFinish(event: WechatMiniprogram.CustomEvent<{ current: number }>) {
    const index = event.detail.current;
    clearPrimaryStickerTimers();
    this.setData({
      ...(index === 0 ? {} : { homeStickerPhase: 'sticker-hidden' }),
      ...(index === 1 ? {} : {
        memoryStickerPhase: 'sticker-hidden',
        memorySummaryStickerPhase: 'sticker-hidden',
      }),
    }, () => {
      if (index === 0) {
        this.playHomeStickerAnimation();
        if (homePageVisible) this.startHomePreviewSync(true);
      } else if (index === 1) {
        memoryEntrySettled = true;
        this.tryPlayMemoryEntryAnimation();
        this.stopHomePreviewSync();
      } else {
        this.stopHomePreviewSync();
      }
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
    this.setData({ memoryStickerPhase: 'sticker-hidden', memorySummaryStickerPhase: 'sticker-hidden' });
    schedulePrimaryStickerState(
      () => this.setData({
        memoryStickerPhase: 'sticker-entering',
        memorySummaryStickerPhase: 'sticker-entering',
      }),
      STICKER_MOTION.pageSettledDelay,
    );
    schedulePrimaryStickerState(
      () => this.setData({
        memoryStickerPhase: 'sticker-visible',
        memorySummaryStickerPhase: 'sticker-visible',
      }),
      STICKER_MOTION.pageSettledDelay + this.data.memoryStickerFinalDelay + STICKER_MOTION.duration,
    );
  },

  tryPlayMemoryEntryAnimation() {
    if (!homePageVisible
      || this.data.primaryTabIndex !== 1
      || !memoryEntrySettled
      || !memoryHasLoadedOnce
      || memoryEntryLoadPromise) return;
    clearPrimaryStickerTimers();
    this.playMemoryStickerAnimation();
  },

  ensureMemoryDataLoaded(): Promise<boolean> {
    if (memoryEntryLoadPromise) return memoryEntryLoadPromise;
    if (memoryHasLoadedOnce) return Promise.resolve(true);
    const promise = this.loadMemoryData(
      false,
      Promise.resolve(),
      false,
      (items) => preloadImageSources(items.map((item) => item.stickerPath)),
    ).finally(() => {
      if (memoryEntryLoadPromise === promise) memoryEntryLoadPromise = undefined;
    });
    memoryEntryLoadPromise = promise;
    return promise;
  },

  refreshMemoryDataInBackground() {
    if (!memoryHasLoadedOnce || memoryEntryLoadPromise) return;
    const promise = this.loadMemoryData(
      false,
      Promise.resolve(),
      false,
      (items) => preloadImageSources(items.map((item) => item.stickerPath)),
      true,
    ).then((loaded) => loaded || memoryHasLoadedOnce).finally(() => {
      if (memoryEntryLoadPromise === promise) memoryEntryLoadPromise = undefined;
    });
    memoryEntryLoadPromise = promise;
  },

  async loadMemoryData(
    forceChange = false,
    beforeApply: Promise<void> = Promise.resolve(),
    preserveOnFailure = false,
    prepareItems?: (items: Array<{ stickerPath: string }>) => Promise<void>,
    background = false,
    viewOverride?: MemoryView,
    transitionApply = false,
  ): Promise<boolean> {
    const loadToken = ++memoryLoadToken;
    if (!preserveOnFailure && !background) this.setData({ memoryLoading: true, memoryErrorMessage: '' });
    try {
      const view = viewOverride ?? await fetchMemoryView({
        moduleId: this.data.memorySelectedModuleId || undefined,
        periodKey: this.data.memoryPeriodKey,
        forceChange,
        reportMode: this.data.memoryReportMode,
        allModules: !this.data.memorySelectedModuleId,
      });
      if (!forceChange && !background && !transitionApply) {
        this.prewarmAlternateMemoryReport(view.reportMode);
      }
      if (!transitionApply) await preloadImageSources(memoryViewImageSources(view));
      await prepareItems?.(view.items);
      await beforeApply;
      if (loadToken !== memoryLoadToken) return false;
      const presentation = buildMemoryPresentation(view, memoryToday());
      const stickerPlan = createStickerDelays(view.items.map((item) => item.recordId));
      const memoryFilterModules = [
        { moduleId: '', name: '全部模块' },
        ...view.modules,
      ].map((module) => ({ ...module, selected: module.moduleId === view.moduleId }));
      await new Promise<void>((resolve) => this.setData({
          memoryReportMode: view.reportMode,
          memoryReportTabMode: view.reportMode,
          memoryPeriodKey: view.periodKey,
          ...(view.reportMode === 'month'
            ? { memorySelectedMonth: view.periodKey }
            : { memorySelectedWeek: view.periodKey }),
          memoryPeriodLabel: presentation.periodLabel,
          memoryStatusLabel: presentation.statusLabel,
          memoryScopeLabel: presentation.scopeLabel,
          memorySelectedModuleId: view.moduleId,
          memorySelectedModuleName: view.moduleName,
          memoryModules: view.modules,
          memoryFilterModules,
          memoryMomentCount: view.momentCount,
          memoryRecordedDays: view.recordedDays,
          memoryReportActionLabel: presentation.reportActionLabel,
          memorySummaryTitle: presentation.summaryTitle,
          memoryLatestStickerPath: presentation.latestStickerPath,
          memoryHasData: presentation.hasData,
          memoryHasPartnerModules: view.hasPartnerModules,
          memoryMetrics: presentation.metrics,
          memoryCalendarCells: presentation.calendarCells,
          memoryWeekCells: presentation.weekCells,
          memoryActivitySummary: presentation.activitySummary,
          memoryTimeSummary: presentation.timeSummary,
          memoryStickers: view.items.map((item, index) => ({
            id: item.recordId,
            moduleId: item.moduleId,
            recordDate: item.recordDate,
            path: item.stickerPath,
            popDelay: stickerPlan.delays.get(item.recordId) ?? 0,
            positionClass: `collage-sticker-${index}`,
          })),
          memoryHasSavedCollage: Boolean(view.collage),
          memoryCollageActionPhase: transitionApply || background
            ? this.data.memoryCollageActionPhase
            : (view.collage ? 'action-hidden' : 'action-visible'),
          memorySavedCollageBoardPath: view.collage?.board?.imagePath ?? '',
          memorySavedCollageItems: (view.collage?.items ?? []).map((item) => ({
            ...item,
            style: memoryCollageItemStyle(item),
          })),
          memoryStickerFinalDelay: stickerPlan.finalDelay,
          memoryStickerPhase: transitionApply
            ? 'sticker-visible'
            : (background ? this.data.memoryStickerPhase : 'sticker-hidden'),
          memorySummaryStickerPhase: transitionApply
            ? 'sticker-hidden'
            : (background ? this.data.memorySummaryStickerPhase : 'sticker-hidden'),
          memorySummaryMetaMotionClass: transitionApply
            ? swapMemoryTextClass(this.data.memorySummaryMetaMotionClass)
            : 'memory-text-visible',
          memorySummaryPeriodMotionClass: transitionApply
            ? swapMemoryTextClass(this.data.memorySummaryPeriodMotionClass)
            : 'memory-text-visible',
          memorySummaryCountMotionClass: transitionApply
            ? swapMemoryTextClass(this.data.memorySummaryCountMotionClass)
            : 'memory-text-visible',
          memorySummaryActionMotionClass: transitionApply
            ? swapMemoryTextClass(this.data.memorySummaryActionMotionClass)
            : 'memory-text-visible',
          memoryMetricValueMotionClasses: transitionApply
            ? this.data.memoryMetricValueMotionClasses.map(swapMemoryTextClass)
            : presentation.metrics.map(() => 'memory-text-visible'),
          memoryBoardPhase: transitionApply
            ? 'memory-surface-hidden'
            : (background ? this.data.memoryBoardPhase : 'memory-surface-visible'),
          memoryHeatmapPhase: transitionApply
            ? 'memory-surface-hidden'
            : (background ? this.data.memoryHeatmapPhase : 'memory-surface-visible'),
          memoryCanGoNext: !view.isCurrentPeriod,
          memoryLoading: false,
          memoryErrorMessage: '',
        }, resolve));
      memoryHasLoadedOnce = true;
      return true;
    } catch {
      await beforeApply;
      if (loadToken !== memoryLoadToken) return false;
      if (background) return false;
      if (preserveOnFailure) {
        this.setData({
          memoryStickerPhase: 'sticker-visible',
          memorySummaryStickerPhase: 'sticker-visible',
          memoryChangingGroup: false,
        });
        wx.showToast({ title: '暂时无法更换，请稍后重试', icon: 'none' });
        return false;
      }
      this.setData({ memoryLoading: false, memoryErrorMessage: '回忆暂时没有加载出来' });
      return false;
    }
  },

  memoryViewQuery(
    reportMode?: MemoryReportMode,
    periodKey?: string,
  ): MemoryViewQuery {
    return {
      moduleId: this.data.memorySelectedModuleId || undefined,
      periodKey: periodKey ?? this.data.memoryPeriodKey,
      reportMode: reportMode ?? this.data.memoryReportMode,
      allModules: !this.data.memorySelectedModuleId,
    };
  },

  prewarmAlternateMemoryReport(sourceMode?: MemoryReportMode) {
    const activeMode = sourceMode ?? this.data.memoryReportMode;
    const reportMode: MemoryReportMode = activeMode === 'month' ? 'week' : 'month';
    const periodKey = reportMode === 'month' ? this.data.memorySelectedMonth : this.data.memorySelectedWeek;
    prewarmMemoryReport(
      this.memoryViewQuery(reportMode, periodKey),
      (view) => preloadImageSources(memoryViewImageSources(view)),
    );
  },

  setMemoryReportMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as MemoryReportMode;
    void this.transitionMemoryReportMode(mode);
  },

  async transitionMemoryReportMode(mode: MemoryReportMode) {
    if (mode === this.data.memoryReportMode || this.data.memoryReportTransitioning) return;
    const token = ++memoryReportTransitionToken;
    const previousMode = this.data.memoryReportMode;
    const periodKey = mode === 'month' ? this.data.memorySelectedMonth : this.data.memorySelectedWeek;
    const query = this.memoryViewQuery(mode, periodKey);
    clearPrimaryStickerTimers();
    await runMemoryReportTransition(query, {
      isActive: () => token === memoryReportTransitionToken,
      preload: (view) => preloadImageSources(memoryViewImageSources(view)),
      prepareView: (view) => runMemoryCollageActionTransition(
        !this.data.memoryHasSavedCollage,
        !view.collage,
        () => token === memoryReportTransitionToken,
        (memoryCollageActionPhase) => this.setData({ memoryCollageActionPhase }),
      ),
      applyView: (view, background, transitionApply) => this.loadMemoryData(
        false,
        Promise.resolve(),
        true,
        undefined,
        background,
        view,
        transitionApply,
      ),
      onStart: (cacheHit) => {
        this.setData({ memoryReportTabMode: mode, memoryReportTransitioning: true });
        track('memory_report_mode_change', { mode, cacheHit });
      },
      onReady: (view) => {
        const presentation = buildMemoryPresentation(view, memoryToday());
        this.setData({
          memoryStickerPhase: 'sticker-visible',
          memorySummaryMetaMotionClass: changedMemoryTextClass(
            presentation.periodLabel !== this.data.memoryPeriodLabel
              || presentation.statusLabel !== this.data.memoryStatusLabel,
          ),
          memorySummaryPeriodMotionClass: changedMemoryTextClass(
            view.reportMode !== this.data.memoryReportMode,
          ),
          memorySummaryCountMotionClass: changedMemoryTextClass(
            view.momentCount !== this.data.memoryMomentCount,
          ),
          memorySummaryActionMotionClass: changedMemoryTextClass(
            presentation.reportActionLabel !== this.data.memoryReportActionLabel,
          ),
          memoryMetricValueMotionClasses: presentation.metrics.map((metric, index) => changedMemoryTextClass(
            metric.value !== this.data.memoryMetrics[index]?.value,
          )),
        });
      },
      onPhase: (phase) => {
        const state = memoryReportMotionState(phase, mode, previousMode);
        this.setData({
          ...(state.tabMode ? { memoryReportTabMode: state.tabMode } : {}),
          ...(state.transitioning === undefined ? {} : { memoryReportTransitioning: state.transitioning }),
          memoryBoardPhase: state.boardPhase,
          memoryHeatmapPhase: state.heatmapPhase,
          memorySummaryStickerPhase: state.summaryStickerPhase,
          memorySummaryMetaMotionClass: advanceMemoryTextClass(this.data.memorySummaryMetaMotionClass, phase),
          memorySummaryPeriodMotionClass: advanceMemoryTextClass(this.data.memorySummaryPeriodMotionClass, phase),
          memorySummaryCountMotionClass: advanceMemoryTextClass(this.data.memorySummaryCountMotionClass, phase),
          memorySummaryActionMotionClass: advanceMemoryTextClass(this.data.memorySummaryActionMotionClass, phase),
          memoryMetricValueMotionClasses: this.data.memoryMetricValueMotionClasses
            .map((item) => advanceMemoryTextClass(item, phase)),
        });
      },
      onError: () => {
        this.setData({
          memoryCollageActionPhase: this.data.memoryHasSavedCollage ? 'action-hidden' : 'action-visible',
        });
        wx.showToast({ title: '回忆暂时没有加载出来', icon: 'none' });
      },
    });
  },

  previousMemoryPeriod() {
    this.navigateMemoryPeriod(-1);
  },

  nextMemoryPeriod() {
    if (!this.data.memoryCanGoNext) return;
    this.navigateMemoryPeriod(1);
  },

  navigateMemoryPeriod(direction: -1 | 1) {
    const target = shiftMemoryPeriod(this.data.memoryReportMode, this.data.memoryPeriodKey, direction);
    if (isFutureMemoryPeriod(this.data.memoryReportMode, target)) return;
    clearPrimaryStickerTimers();
    this.setData({
      memoryPeriodKey: target,
      ...(this.data.memoryReportMode === 'month'
        ? { memorySelectedMonth: target }
        : { memorySelectedWeek: target }),
      memoryStickerPhase: 'sticker-hidden',
      memorySummaryStickerPhase: 'sticker-hidden',
    }, () => {
      track('memory_period_change', {
        mode: this.data.memoryReportMode,
        direction,
        period: target,
      });
      void this.loadMemoryData().then((loaded) => { if (loaded) this.playMemoryStickerAnimation(); });
    });
  },

  async changeMemoryGroup() {
    if (this.data.memoryChangingGroup || !this.data.memoryStickers.length) return;
    const token = ++memoryGroupChangeToken;
    clearPrimaryStickerTimers();
    this.setData({ memoryChangingGroup: true });
    track('memory_change_group_click', {
      moduleId: this.data.memorySelectedModuleId || 'all',
      mode: this.data.memoryReportMode,
      period: this.data.memoryPeriodKey,
    });
    const loaded = await this.loadMemoryData(
      true,
      Promise.resolve(),
      true,
      async (items) => {
        if (token !== memoryGroupChangeToken) return;
        this.setData({ memoryStickerPhase: 'sticker-leaving' });
        await wait(STICKER_MOTION.oldPageFadeDuration);
      },
    );
    if (token !== memoryGroupChangeToken) return;
    if (loaded) {
      this.playMemoryStickerAnimation();
      await wait(STICKER_MOTION.pageSettledDelay + this.data.memoryStickerFinalDelay + STICKER_MOTION.duration);
      if (token !== memoryGroupChangeToken) return;
    }
    this.setData({ memoryChangingGroup: false });
  },

  openMemorySelection() {
    const memoryDraftPeriodKey = this.data.memoryPeriodKey;
    this.setData({
      memorySelectionOpen: true,
      memorySelectionClosing: false,
      memoryDraftModuleId: this.data.memorySelectedModuleId,
      memoryDraftPeriodKey,
      memoryDraftPeriodLabel: memoryPeriodLabel(this.data.memoryReportMode, memoryDraftPeriodKey),
      memoryDraftCanGoNext: !isFutureMemoryPeriod(
        this.data.memoryReportMode,
        shiftMemoryPeriod(this.data.memoryReportMode, memoryDraftPeriodKey, 1),
      ),
      memoryFilterModules: this.data.memoryFilterModules.map((module) => ({
        ...module,
        selected: module.moduleId === this.data.memorySelectedModuleId,
      })),
    }, () => this.syncTabBarVisibility());
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

  previousMemoryDraftPeriod() {
    this.changeMemoryDraftPeriod(-1);
  },

  nextMemoryDraftPeriod() {
    if (!this.data.memoryDraftCanGoNext) return;
    this.changeMemoryDraftPeriod(1);
  },

  changeMemoryDraftPeriod(direction: -1 | 1) {
    const target = shiftMemoryPeriod(this.data.memoryReportMode, this.data.memoryDraftPeriodKey, direction);
    if (isFutureMemoryPeriod(this.data.memoryReportMode, target)) return;
    this.setData({
      memoryDraftPeriodKey: target,
      memoryDraftPeriodLabel: memoryPeriodLabel(this.data.memoryReportMode, target),
      memoryDraftCanGoNext: !isFutureMemoryPeriod(
        this.data.memoryReportMode,
        shiftMemoryPeriod(this.data.memoryReportMode, target, 1),
      ),
    });
  },

  selectMemoryDraftModule(event: WechatMiniprogram.TouchEvent) {
    const memoryDraftModuleId = String(event.currentTarget.dataset.id ?? '');
    this.setData({
      memoryDraftModuleId,
      memoryFilterModules: this.data.memoryFilterModules.map((module) => ({
        ...module,
        selected: module.moduleId === memoryDraftModuleId,
      })),
    });
  },

  async applyMemorySelection() {
    const moduleId = this.data.memoryDraftModuleId;
    const periodKey = this.data.memoryDraftPeriodKey;
    const changed = moduleId !== this.data.memorySelectedModuleId || periodKey !== this.data.memoryPeriodKey;
    await this.dismissMemorySelection();
    if (!changed) return;
    clearPrimaryStickerTimers();
    this.setData({
      memorySelectedModuleId: moduleId,
      memoryPeriodKey: periodKey,
      ...(this.data.memoryReportMode === 'month'
        ? { memorySelectedMonth: periodKey }
        : { memorySelectedWeek: periodKey }),
      memoryStickerPhase: 'sticker-hidden',
      memorySummaryStickerPhase: 'sticker-hidden',
    }, () => {
      track('memory_filter_apply', {
        moduleId: moduleId || 'all',
        mode: this.data.memoryReportMode,
        period: periodKey,
      });
      void this.loadMemoryData().then((loaded) => { if (loaded) this.playMemoryStickerAnimation(); });
    });
  },

  retryMemoryLoad() {
    void this.loadMemoryData().then((loaded) => { if (loaded) this.playMemoryStickerAnimation(); });
  },

  showFullMemoryReport() {
    if (!this.data.memoryHasData) return;
    const metricLines = this.data.memoryMetrics
      .map((metric) => `${metric.label}：${metric.value}${metric.unit}`)
      .join('\n');
    const timeLine = this.data.memoryTimeSummary ? `\n${this.data.memoryTimeSummary}` : '';
    wx.showModal({
      title: `${this.data.memoryPeriodLabel}总结`,
      content: `${this.data.memorySummaryTitle}\n${metricLines}${timeLine}`,
      showCancel: false,
      confirmText: '知道了',
    });
    track('memory_report_summary_open', {
      mode: this.data.memoryReportMode,
      period: this.data.memoryPeriodKey,
    });
  },

  async saveMemoryCard() {
    if (this.data.memoryExporting) return;
    if (!this.data.memoryStickers.length) {
      wx.showToast({ title: '暂无可保存的回忆', icon: 'none' });
      return;
    }
    this.setData({ memoryExporting: true });
    wx.showLoading({ title: '正在生成回忆' });
    try {
      const paths = await Promise.all([
        memoryCanvasImagePath(MEMORY_COLLAGE_BACKGROUND),
        ...this.data.memoryStickers.map((sticker) => memoryCanvasImagePath(sticker.path)),
      ]);
      const context = wx.createCanvasContext('memoryExportCanvas', this);
      context.drawImage(paths[0], 0, 0, 900, 900);
      context.setFillStyle('#5b524b');
      context.setTextAlign('center');
      context.setFontSize(30);
      context.fillText(`${this.data.memoryPeriodLabel} · ${this.data.memoryScopeLabel}`, 450, 286);
      paths.slice(1).forEach((path, index) => {
        const column = index % 4;
        const row = Math.floor(index / 4);
        drawStickerWithOutline(context, path, 130 + column * 165, 338 + row * 178, 116, 138);
      });
      context.setFillStyle('#6c5140');
      context.setFontSize(24);
      context.fillText(
        `${this.data.memoryMomentCount}个瞬间 · ${this.data.memoryRecordedDays}天有记录`,
        450,
        722,
      );
      await new Promise<void>((resolve) => context.draw(false, resolve));
      const tempFilePath = await new Promise<string>((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId: 'memoryExportCanvas',
          width: 900,
          height: 900,
          destWidth: 1800,
          destHeight: 1800,
          success: ({ tempFilePath: path }) => resolve(path),
          fail: reject,
        }, this);
      });
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({
        filePath: tempFilePath,
        success: () => resolve(),
        fail: reject,
      }));
      wx.hideLoading();
      this.setData({ memoryExporting: false });
      wx.showToast({ title: '已保存到相册' });
      track('memory_export_success', {
        moduleId: this.data.memorySelectedModuleId || 'all',
        mode: this.data.memoryReportMode,
        period: this.data.memoryPeriodKey,
      });
    } catch {
      wx.hideLoading();
      this.setData({ memoryExporting: false });
      wx.showModal({
        title: '无法保存到相册',
        content: '请确认已允许照片权限后重试。',
        confirmText: '去设置',
        success: ({ confirm }) => { if (confirm) void wx.openSetting({}); },
      });
    }
  },

  openMemoryCollageEditor() {
    const query = [
      `mode=${this.data.memoryReportMode}`,
      `period=${encodeURIComponent(this.data.memoryPeriodKey)}`,
      ...(this.data.memorySelectedModuleId
        ? [`moduleId=${encodeURIComponent(this.data.memorySelectedModuleId)}`]
        : []),
    ].join('&');
    track('memory_collage_edit_click', {
      moduleId: this.data.memorySelectedModuleId || 'all',
      mode: this.data.memoryReportMode,
      period: this.data.memoryPeriodKey,
    });
    void wx.navigateTo({ url: `/subpackages/memory-collage-editor/index?${query}` });
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
    const pinned = event.currentTarget.dataset.pinned === true || event.currentTarget.dataset.pinned === 'true';
    if (this.data.managing) {
      this.toggleModuleSelection(moduleId);
      return;
    }
    if ((pinned && !this.data.pinnedExpanded) || (!pinned && !this.data.normalExpanded)) {
      if (pinned) this.togglePinnedGroup();
      else this.toggleNormalGroup();
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
      recordPolicyHelpOpen: false,
      recordPolicyHelpClosing: false,
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
    this.setData({
      createOpen: false,
      createClosing: false,
      recordPolicyHelpOpen: false,
      recordPolicyHelpClosing: false,
    });
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

  showRecordPolicyHelp() {
    this.setData({ recordPolicyHelpOpen: true, recordPolicyHelpClosing: false });
  },

  async hideRecordPolicyHelp() {
    if (!this.data.recordPolicyHelpOpen || this.data.recordPolicyHelpClosing) return;
    this.setData({ recordPolicyHelpClosing: true });
    await waitForSheetMotion();
    if (!this.data.recordPolicyHelpClosing) return;
    this.setData({ recordPolicyHelpOpen: false, recordPolicyHelpClosing: false });
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
      this.setData({ createError: '请选择模式' });
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
