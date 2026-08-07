import {
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
import { preloadImageSources } from '../../utils/image-preload';
import {
  buildMemoryPresentation,
  type MemoryCalendarCellPresentation,
  type MemoryMetricPresentation,
  type MemoryWeekCellPresentation,
} from '../../utils/memory-presentation';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { createStickerDelays, STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { memoryCollageBoardBackgroundStyle, memoryCollageItemStyle } from '../../utils/memory-collage';
import { hasOpenBottomSheet } from '../../utils/tab-bar-visibility';
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

const today = () => shanghaiDate();
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
let timers: Array<ReturnType<typeof setTimeout>> = [];
let showToken = 0;
let groupChangeToken = 0;
let loadToken = 0;
let reportTransitionToken = 0;
let memoryHasLoadedOnce = false;

function clearTimers(): void {
  timers.forEach((timer) => clearTimeout(timer));
  timers = [];
}

function periodLabel(mode: MemoryReportMode, period: string): string {
  return mode === 'month' ? monthLabel(period) : weekRangeLabel(period);
}

function shiftPeriod(mode: MemoryReportMode, period: string, direction: -1 | 1): string {
  if (mode === 'month') return direction < 0 ? previousMonth(period) : nextMonth(period);
  return direction < 0 ? previousWeek(period) : nextWeek(period);
}

function isFuturePeriod(mode: MemoryReportMode, period: string): boolean {
  const current = mode === 'month' ? monthOf(today()) : weekStartOf(today());
  return period > current;
}

Page({
  data: {
    statusBarHeight: 24,
    reportMode: 'month' as MemoryReportMode,
    reportTabMode: 'month' as MemoryReportMode,
    periodKey: monthOf(today()),
    selectedMonth: monthOf(today()),
    selectedWeek: weekStartOf(today()),
    periodLabel: monthLabel(monthOf(today())),
    statusLabel: '进行中',
    scopeLabel: '全部模块',
    moduleId: '',
    moduleName: '',
    modules: [] as MemoryModuleOption[],
    filterModules: [] as FilterModuleOption[],
    momentCount: 0,
    recordedDays: 0,
    reportActionLabel: '查看完整月报',
    summaryTitle: '',
    latestStickerPath: '',
    hasData: false,
    hasPartnerModules: false,
    metrics: [] as MemoryMetricPresentation[],
    calendarCells: [] as MemoryCalendarCellPresentation[],
    weekCells: [] as MemoryWeekCellPresentation[],
    activitySummary: '',
    timeSummary: '',
    stickers: [] as AnimatedSticker[],
    hasSavedCollage: false,
    collageActionPhase: 'action-visible',
    savedCollageBoardPath: '',
    collageBoardBackgroundStyle: memoryCollageBoardBackgroundStyle(),
    savedCollageItems: [] as SavedCollagePreviewItem[],
    stickerPhase: 'sticker-hidden',
    summaryStickerPhase: 'sticker-hidden',
    summaryMetaMotionClass: 'memory-text-visible',
    summaryPeriodMotionClass: 'memory-text-visible',
    summaryCountMotionClass: 'memory-text-visible',
    summaryActionMotionClass: 'memory-text-visible',
    metricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
    memoryBoardPhase: 'memory-surface-visible',
    memoryHeatmapPhase: 'memory-surface-visible',
    reportTransitioning: false,
    stickerFinalDelay: 0,
    changingGroup: false,
    canGoNext: false,
    loading: true,
    errorMessage: '',
    selectionOpen: false,
    selectionClosing: false,
    draftModuleId: '',
    draftPeriodKey: monthOf(today()),
    draftPeriodLabel: monthLabel(monthOf(today())),
    draftCanGoNext: false,
  },

  onLoad() {
    memoryHasLoadedOnce = false;
  },

  onShow() {
    const token = ++showToken;
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
      stickerPhase: 'sticker-hidden',
      summaryStickerPhase: 'sticker-hidden',
      reportTransitioning: false,
      summaryMetaMotionClass: 'memory-text-visible',
      summaryPeriodMotionClass: 'memory-text-visible',
      summaryCountMotionClass: 'memory-text-visible',
      summaryActionMotionClass: 'memory-text-visible',
      metricValueMotionClasses: ['memory-text-visible', 'memory-text-visible', 'memory-text-visible'],
      memoryBoardPhase: 'memory-surface-visible',
      memoryHeatmapPhase: 'memory-surface-visible',
      collageActionPhase: this.data.hasSavedCollage ? 'action-hidden' : 'action-visible',
    });
    this.syncTabBarVisibility();
    clearTimers();
    const selection = wx.getStorageSync('notemylife.memory.selection') as { moduleId?: string; month?: string } | undefined;
    const collageSaved = Boolean(wx.getStorageSync('notemylife.memory.collage.saved'));
    if (collageSaved) wx.removeStorageSync('notemylife.memory.collage.saved');
    let selectionChanged = false;
    if (selection?.moduleId) {
      const month = selection.month ?? monthOf(today());
      selectionChanged = selection.moduleId !== this.data.moduleId
        || month !== this.data.periodKey
        || this.data.reportMode !== 'month';
      this.setData({
        reportMode: 'month',
        periodKey: month,
        selectedMonth: month,
        moduleId: selection.moduleId,
      });
      wx.removeStorageSync('notemylife.memory.selection');
    }
    const memoryReady = memoryHasLoadedOnce && !selectionChanged && !collageSaved
      ? Promise.resolve(true)
      : this.load(
        false,
        Promise.resolve(),
        false,
        (items) => preloadImageSources(items.map((item) => item.stickerPath)),
      );
    void Promise.all([memoryReady, waitForAppRouteDone()]).then(([loaded]) => {
      if (loaded && token === showToken) this.playStickerAnimation();
    });
  },

  syncTabBarVisibility() {
    this.getTabBar?.()?.setData({
      selected: 1,
      hidden: hasOpenBottomSheet(this.data.selectionOpen),
    });
  },

  async load(
    forceChange = false,
    beforeApply: Promise<void> = Promise.resolve(),
    preserveOnFailure = false,
    prepareItems?: (items: Array<{ stickerPath: string }>) => Promise<void>,
    viewOverride?: MemoryView,
    background = false,
    transitionApply = false,
  ): Promise<boolean> {
    const currentLoadToken = ++loadToken;
    if (!preserveOnFailure && !background) this.setData({ loading: true, errorMessage: '' });
    try {
      const view = viewOverride ?? await fetchMemoryView({
        moduleId: this.data.moduleId || undefined,
        periodKey: this.data.periodKey,
        forceChange,
        reportMode: this.data.reportMode,
        allModules: !this.data.moduleId,
      });
      if (!forceChange && !background && !transitionApply) this.prewarmAlternateReport(view.reportMode);
      if (!transitionApply) await preloadImageSources(memoryViewImageSources(view));
      await prepareItems?.(view.items);
      await beforeApply;
      if (currentLoadToken !== loadToken) return false;
      const presentation = buildMemoryPresentation(view, today());
      const plan = createStickerDelays(view.items.map((item) => item.recordId));
      const filterModules = [
        { moduleId: '', name: '全部模块' },
        ...view.modules,
      ].map((module) => ({ ...module, selected: module.moduleId === view.moduleId }));
      await new Promise<void>((resolve) => this.setData({
        reportMode: view.reportMode,
        reportTabMode: view.reportMode,
        periodKey: view.periodKey,
        ...(view.reportMode === 'month' ? { selectedMonth: view.periodKey } : { selectedWeek: view.periodKey }),
        periodLabel: presentation.periodLabel,
        statusLabel: presentation.statusLabel,
        scopeLabel: presentation.scopeLabel,
        moduleId: view.moduleId,
        moduleName: view.moduleName,
        modules: view.modules,
        filterModules,
        momentCount: view.momentCount,
        recordedDays: view.recordedDays,
        reportActionLabel: presentation.reportActionLabel,
        summaryTitle: presentation.summaryTitle,
        latestStickerPath: presentation.latestStickerPath,
        hasData: presentation.hasData,
        hasPartnerModules: view.hasPartnerModules,
        metrics: presentation.metrics,
        calendarCells: presentation.calendarCells,
        weekCells: presentation.weekCells,
        activitySummary: presentation.activitySummary,
        timeSummary: presentation.timeSummary,
        stickers: view.items.map((item, index) => ({
          id: item.recordId,
          moduleId: item.moduleId,
          recordDate: item.recordDate,
          path: item.stickerPath,
          popDelay: plan.delays.get(item.recordId) ?? 0,
          positionClass: `collage-sticker-${index}`,
        })),
        hasSavedCollage: Boolean(view.collage),
        collageActionPhase: transitionApply || background
          ? this.data.collageActionPhase
          : (view.collage ? 'action-hidden' : 'action-visible'),
        savedCollageBoardPath: view.collage?.board?.imagePath ?? '',
        savedCollageItems: (view.collage?.items ?? []).map((item) => ({
          ...item,
          style: memoryCollageItemStyle(item),
        })),
        stickerFinalDelay: plan.finalDelay,
        stickerPhase: transitionApply
          ? 'sticker-visible'
          : (background ? this.data.stickerPhase : 'sticker-hidden'),
        summaryStickerPhase: transitionApply
          ? 'sticker-hidden'
          : (background ? this.data.summaryStickerPhase : 'sticker-hidden'),
        summaryMetaMotionClass: transitionApply
          ? swapMemoryTextClass(this.data.summaryMetaMotionClass)
          : 'memory-text-visible',
        summaryPeriodMotionClass: transitionApply
          ? swapMemoryTextClass(this.data.summaryPeriodMotionClass)
          : 'memory-text-visible',
        summaryCountMotionClass: transitionApply
          ? swapMemoryTextClass(this.data.summaryCountMotionClass)
          : 'memory-text-visible',
        summaryActionMotionClass: transitionApply
          ? swapMemoryTextClass(this.data.summaryActionMotionClass)
          : 'memory-text-visible',
        metricValueMotionClasses: transitionApply
          ? this.data.metricValueMotionClasses.map(swapMemoryTextClass)
          : presentation.metrics.map(() => 'memory-text-visible'),
        memoryBoardPhase: transitionApply
          ? 'memory-surface-hidden'
          : (background ? this.data.memoryBoardPhase : 'memory-surface-visible'),
        memoryHeatmapPhase: transitionApply
          ? 'memory-surface-hidden'
          : (background ? this.data.memoryHeatmapPhase : 'memory-surface-visible'),
        canGoNext: !view.isCurrentPeriod,
        loading: false,
        errorMessage: '',
      }, resolve));
      memoryHasLoadedOnce = true;
      return true;
    } catch {
      await beforeApply;
      if (currentLoadToken !== loadToken) return false;
      if (background) return false;
      if (preserveOnFailure) {
        this.setData({ stickerPhase: 'sticker-visible', summaryStickerPhase: 'sticker-visible', changingGroup: false });
        wx.showToast({ title: '暂时无法更换，请稍后重试', icon: 'none' });
        return false;
      }
      this.setData({ loading: false, errorMessage: '回忆暂时没有加载出来' });
      return false;
    }
  },

  memoryViewQuery(reportMode?: MemoryReportMode, periodKey?: string): MemoryViewQuery {
    return {
      moduleId: this.data.moduleId || undefined,
      periodKey: periodKey ?? this.data.periodKey,
      reportMode: reportMode ?? this.data.reportMode,
      allModules: !this.data.moduleId,
    };
  },

  prewarmAlternateReport(sourceMode?: MemoryReportMode) {
    const activeMode = sourceMode ?? this.data.reportMode;
    const reportMode: MemoryReportMode = activeMode === 'month' ? 'week' : 'month';
    const periodKey = reportMode === 'month' ? this.data.selectedMonth : this.data.selectedWeek;
    prewarmMemoryReport(
      this.memoryViewQuery(reportMode, periodKey),
      (view) => preloadImageSources(memoryViewImageSources(view)),
    );
  },

  setReportMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as MemoryReportMode;
    void this.transitionReportMode(mode);
  },

  async transitionReportMode(mode: MemoryReportMode) {
    if (mode === this.data.reportMode || this.data.reportTransitioning) return;
    const token = ++reportTransitionToken;
    const previousMode = this.data.reportMode;
    const periodKey = mode === 'month' ? this.data.selectedMonth : this.data.selectedWeek;
    const query = this.memoryViewQuery(mode, periodKey);
    clearTimers();
    await runMemoryReportTransition(query, {
      isActive: () => token === reportTransitionToken,
      preload: (view) => preloadImageSources(memoryViewImageSources(view)),
      prepareView: (view) => runMemoryCollageActionTransition(
        !this.data.hasSavedCollage,
        !view.collage,
        () => token === reportTransitionToken,
        (collageActionPhase) => this.setData({ collageActionPhase }),
      ),
      applyView: (view, background, transitionApply) => this.load(
        false,
        Promise.resolve(),
        true,
        undefined,
        view,
        background,
        transitionApply,
      ),
      onStart: (cacheHit) => {
        this.setData({ reportTabMode: mode, reportTransitioning: true });
        track('memory_report_mode_change', { mode, cacheHit });
      },
      onReady: (view) => {
        const presentation = buildMemoryPresentation(view, today());
        this.setData({
          stickerPhase: 'sticker-visible',
          summaryMetaMotionClass: changedMemoryTextClass(
            presentation.periodLabel !== this.data.periodLabel
              || presentation.statusLabel !== this.data.statusLabel,
          ),
          summaryPeriodMotionClass: changedMemoryTextClass(
            view.reportMode !== this.data.reportMode,
          ),
          summaryCountMotionClass: changedMemoryTextClass(
            view.momentCount !== this.data.momentCount,
          ),
          summaryActionMotionClass: changedMemoryTextClass(
            presentation.reportActionLabel !== this.data.reportActionLabel,
          ),
          metricValueMotionClasses: presentation.metrics.map((metric, index) => changedMemoryTextClass(
            metric.value !== this.data.metrics[index]?.value,
          )),
        });
      },
      onPhase: (phase) => {
        const state = memoryReportMotionState(phase, mode, previousMode);
        this.setData({
          ...(state.tabMode ? { reportTabMode: state.tabMode } : {}),
          ...(state.transitioning === undefined ? {} : { reportTransitioning: state.transitioning }),
          memoryBoardPhase: state.boardPhase,
          memoryHeatmapPhase: state.heatmapPhase,
          summaryStickerPhase: state.summaryStickerPhase,
          summaryMetaMotionClass: advanceMemoryTextClass(this.data.summaryMetaMotionClass, phase),
          summaryPeriodMotionClass: advanceMemoryTextClass(this.data.summaryPeriodMotionClass, phase),
          summaryCountMotionClass: advanceMemoryTextClass(this.data.summaryCountMotionClass, phase),
          summaryActionMotionClass: advanceMemoryTextClass(this.data.summaryActionMotionClass, phase),
          metricValueMotionClasses: this.data.metricValueMotionClasses
            .map((item) => advanceMemoryTextClass(item, phase)),
        });
      },
      onError: () => {
        this.setData({ collageActionPhase: this.data.hasSavedCollage ? 'action-hidden' : 'action-visible' });
        wx.showToast({ title: '回忆暂时没有加载出来', icon: 'none' });
      },
    });
  },

  previousPeriod() {
    this.navigatePeriod(-1);
  },

  nextPeriod() {
    if (!this.data.canGoNext) return;
    this.navigatePeriod(1);
  },

  navigatePeriod(direction: -1 | 1) {
    const target = shiftPeriod(this.data.reportMode, this.data.periodKey, direction);
    if (isFuturePeriod(this.data.reportMode, target)) return;
    clearTimers();
    this.setData({
      periodKey: target,
      ...(this.data.reportMode === 'month' ? { selectedMonth: target } : { selectedWeek: target }),
      stickerPhase: 'sticker-hidden',
      summaryStickerPhase: 'sticker-hidden',
    }, () => {
      track('memory_period_change', { mode: this.data.reportMode, direction, period: target });
      void this.load().then((loaded) => { if (loaded) this.playStickerAnimation(); });
    });
  },

  async changeGroup() {
    if (this.data.changingGroup || !this.data.stickers.length) return;
    const token = ++groupChangeToken;
    clearTimers();
    this.setData({ changingGroup: true });
    track('memory_change_group_click', {
      moduleId: this.data.moduleId || 'all',
      mode: this.data.reportMode,
      period: this.data.periodKey,
    });
    const loaded = await this.load(
      true,
      Promise.resolve(),
      true,
      async (items) => {
        if (token !== groupChangeToken) return;
        this.setData({ stickerPhase: 'sticker-leaving' });
        await wait(STICKER_MOTION.oldPageFadeDuration);
      },
    );
    if (token !== groupChangeToken) return;
    if (loaded) {
      this.playStickerAnimation();
      await wait(STICKER_MOTION.pageSettledDelay + this.data.stickerFinalDelay + STICKER_MOTION.duration);
      if (token !== groupChangeToken) return;
    }
    this.setData({ changingGroup: false });
  },

  playStickerAnimation() {
    timers.push(setTimeout(() => this.setData({
      stickerPhase: 'sticker-entering',
      summaryStickerPhase: 'sticker-entering',
    }), STICKER_MOTION.pageSettledDelay));
    timers.push(setTimeout(() => this.setData({
      stickerPhase: 'sticker-visible',
      summaryStickerPhase: 'sticker-visible',
    }),
      STICKER_MOTION.pageSettledDelay + this.data.stickerFinalDelay + STICKER_MOTION.duration));
  },

  openSelection() {
    const draftPeriodKey = this.data.periodKey;
    this.setData({
      selectionOpen: true,
      selectionClosing: false,
      draftModuleId: this.data.moduleId,
      draftPeriodKey,
      draftPeriodLabel: periodLabel(this.data.reportMode, draftPeriodKey),
      draftCanGoNext: !isFuturePeriod(this.data.reportMode, shiftPeriod(this.data.reportMode, draftPeriodKey, 1)),
      filterModules: this.data.filterModules.map((module) => ({
        ...module,
        selected: module.moduleId === this.data.moduleId,
      })),
    }, () => this.syncTabBarVisibility());
  },

  previousDraftPeriod() {
    this.changeDraftPeriod(-1);
  },

  nextDraftPeriod() {
    if (!this.data.draftCanGoNext) return;
    this.changeDraftPeriod(1);
  },

  changeDraftPeriod(direction: -1 | 1) {
    const target = shiftPeriod(this.data.reportMode, this.data.draftPeriodKey, direction);
    if (isFuturePeriod(this.data.reportMode, target)) return;
    this.setData({
      draftPeriodKey: target,
      draftPeriodLabel: periodLabel(this.data.reportMode, target),
      draftCanGoNext: !isFuturePeriod(this.data.reportMode, shiftPeriod(this.data.reportMode, target, 1)),
    });
  },

  selectDraftModule(event: WechatMiniprogram.TouchEvent) {
    const draftModuleId = String(event.currentTarget.dataset.id ?? '');
    this.setData({
      draftModuleId,
      filterModules: this.data.filterModules.map((module) => ({
        ...module,
        selected: module.moduleId === draftModuleId,
      })),
    });
  },

  async applySelection() {
    const moduleId = this.data.draftModuleId;
    const periodKey = this.data.draftPeriodKey;
    const changed = moduleId !== this.data.moduleId || periodKey !== this.data.periodKey;
    await this.dismissSelection();
    if (!changed) return;
    clearTimers();
    this.setData({
      moduleId,
      periodKey,
      ...(this.data.reportMode === 'month' ? { selectedMonth: periodKey } : { selectedWeek: periodKey }),
      stickerPhase: 'sticker-hidden',
      summaryStickerPhase: 'sticker-hidden',
    }, () => {
      track('memory_filter_apply', { moduleId: moduleId || 'all', mode: this.data.reportMode, period: periodKey });
      void this.load().then((loaded) => { if (loaded) this.playStickerAnimation(); });
    });
  },

  async dismissSelection() {
    if (!this.data.selectionOpen || this.data.selectionClosing) return;
    this.setData({ selectionClosing: true });
    await waitForSheetMotion();
    if (!this.data.selectionClosing) return;
    this.setData({ selectionOpen: false, selectionClosing: false });
    this.syncTabBarVisibility();
  },

  closeSelection() {
    void this.dismissSelection();
  },

  stopPropagation() {},

  retryLoad() {
    void this.load().then((loaded) => { if (loaded) this.playStickerAnimation(); });
  },

  showFullReport() {
    if (!this.data.hasData) return;
    const metricLines = this.data.metrics.map((metric) => `${metric.label}：${metric.value}${metric.unit}`).join('\n');
    const timeLine = this.data.timeSummary ? `\n${this.data.timeSummary}` : '';
    wx.showModal({
      title: `${this.data.periodLabel}总结`,
      content: `${this.data.summaryTitle}\n${metricLines}${timeLine}`,
      showCancel: false,
      confirmText: '知道了',
    });
    track('memory_report_summary_open', { mode: this.data.reportMode, period: this.data.periodKey });
  },

  openCollageEditor() {
    const query = [
      `mode=${this.data.reportMode}`,
      `period=${encodeURIComponent(this.data.periodKey)}`,
      ...(this.data.moduleId ? [`moduleId=${encodeURIComponent(this.data.moduleId)}`] : []),
    ].join('&');
    track('memory_collage_edit_click', {
      moduleId: this.data.moduleId || 'all',
      mode: this.data.reportMode,
      period: this.data.periodKey,
    });
    void wx.navigateTo({ url: `/subpackages/memory-collage-editor/index?${query}` });
  },

  onHide() {
    showToken += 1;
    groupChangeToken += 1;
    loadToken += 1;
    reportTransitionToken += 1;
    clearTimers();
    this.setData({
      changingGroup: false,
      reportTransitioning: false,
      reportTabMode: this.data.reportMode,
      summaryMetaMotionClass: 'memory-text-visible',
      summaryPeriodMotionClass: 'memory-text-visible',
      summaryCountMotionClass: 'memory-text-visible',
      summaryActionMotionClass: 'memory-text-visible',
      metricValueMotionClasses: this.data.metrics.map(() => 'memory-text-visible'),
      summaryStickerPhase: 'sticker-visible',
      memoryBoardPhase: 'memory-surface-visible',
      memoryHeatmapPhase: 'memory-surface-visible',
      collageActionPhase: this.data.hasSavedCollage ? 'action-hidden' : 'action-visible',
    });
  },

  onUnload() {
    showToken += 1;
    groupChangeToken += 1;
    loadToken += 1;
    reportTransitionToken += 1;
    clearTimers();
  },
});
