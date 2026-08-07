import type { CalendarCell, LifeModule, LifeRecord, MediaStatus, ReactionEmoji, User } from '../../types/domain';
import {
  cancelProcessingCheckin,
  cancelStreakRewardRule,
  currentUserRecord,
  createModuleInvite,
  deleteRecord,
  discardPrewarmedMediaUpload,
  discardMedia,
  getCalendar,
  getCheckinProcessingStatus,
  getCurrentUser,
  getCurrentMakeupApproval,
  getDateRecords,
  getModuleInbox,
  getModuleInboxCount,
  getModuleMonthSummary,
  getPendingStreakRewards,
  getMyStreakRewardRule,
  getModule,
  refreshModule,
  getReactionOptions,
  getRecordReactions,
  processMedia,
  prewarmMediaUpload,
  previewStreakReward,
  refreshModuleMonthSummary,
  refreshMediaStickerSources,
  retryCheckinMatting,
  revealStreakReward,
  saveStreakRewardRule,
  saveRecord,
  setRecordReaction,
  submitMakeupRecord,
  type ReactionView,
  type PendingStreakReward,
  type RevealedStreakReward,
  type StreakRewardRuleView,
} from '../../services/api';
import { track } from '../../services/tracker';
import { invalidateModuleGallery, prefetchModuleGallery } from '../../services/gallery-cache';
import { queueHomePreviewUpdate } from '../../services/home-preview-cache';
import {
  addDays,
  dateLabel,
  differenceInDays,
  monthLabel,
  monthOf,
  nextMonth,
  previousMonth,
  shanghaiDate,
} from '../../utils/date';
import { createId } from '../../utils/id';
import { pollIntervalForElapsed, waitingCopy } from '../../utils/checkin-processing';
import { waitForSheetMotion } from '../../utils/sheet-motion';
import { STICKER_MOTION, waitForAppRouteDone } from '../../utils/sticker-motion';
import { REWARD_MOTION, type RewardMotionPhase } from '../../utils/reward-motion';
import { preloadImageSources } from '../../utils/image-preload';
import { mergeMemberSnapshot } from '../../utils/member-sync';
import {
  isRecordDateInRange,
  RECORD_DATE_MAX,
  RECORD_DATE_MIN,
} from '../../utils/record-policy';
import {
  buildMemberCalendarPages,
  createCalendarStickerPlan,
  mergeCalendarSnapshot,
  prepareCalendarForExit,
  showCalendarStickers,
  type AnimatedCalendarCell,
  type CalendarStickerLocation,
  type MemberCalendarPage,
} from './calendar-controller';

interface RecordView extends LifeRecord {
  ownerName: string;
  ownerAvatarText: string;
  ownerAvatarColor: string;
  ownerAvatarUrl?: string;
  isMine: boolean;
  timeLabel: string;
  reactions: ReactionView[];
}

interface MemberView {
  memberInstanceId: string;
  nickname: string;
  avatarText: string;
  avatarColor: string;
  avatarUrl?: string;
  roleLabel: string;
  isMine: boolean;
  recordedToday: boolean;
}

interface ModuleDetailCacheEntry {
  module: LifeModule;
  currentUser: User;
  calendar: CalendarCell[];
}

interface RewardTargetOption {
  label: string;
  targetType: 'all' | 'member';
  memberInstanceId?: string;
}

interface RewardRuleDisplay {
  rewardRuleId: string;
  targetLabel: string;
  conditionLabel: string;
  prizeTitle: string;
  winProbability: number;
  progressLabel: string;
  status: string;
  statusLabel: string;
}

let mediaProgressTimer: ReturnType<typeof setInterval> | undefined;
let calendarTouchStartX = 0;
let monthTransitionToken = 0;
let calendarMotionTimer: ReturnType<typeof setTimeout> | undefined;
let calendarMotionResolve: (() => void) | undefined;
let stickerTimelineTimer: ReturnType<typeof setTimeout> | undefined;
let stickerTimelineResolve: (() => void) | undefined;
let stickerSequenceStartedAt = 0;
let editorStickerTimers: Array<ReturnType<typeof setTimeout>> = [];
let editorProcessingTimer: ReturnType<typeof setTimeout> | undefined;
let editorMediaTaskToken = 0;
let memberCalendarMotionTimer: ReturnType<typeof setTimeout> | undefined;
let calendarSyncTimer: ReturnType<typeof setInterval> | undefined;
let calendarSyncInFlight = false;
let calendarPageVisible = false;
let calendarSyncGeneration = 0;
let freshCalendarStickerTimers: Array<ReturnType<typeof setTimeout>> = [];
let rewardMotionTimer: ReturnType<typeof setTimeout> | undefined;
const moduleDetailCache = new Map<string, ModuleDetailCacheEntry>();

const moduleDetailCacheKey = (moduleId: string, month: string) => `${moduleId}:${month}`;

const MEMBER_CALENDAR_MOTION_DURATION = 260;

const clearRewardMotionTimer = () => {
  if (rewardMotionTimer) clearTimeout(rewardMotionTimer);
  rewardMotionTimer = undefined;
};

const scheduleRewardMotion = (callback: () => void, delay: number) => {
  clearRewardMotionTimer();
  rewardMotionTimer = setTimeout(() => {
    rewardMotionTimer = undefined;
    callback();
  }, delay);
};
const CALENDAR_SYNC_INTERVAL = 5_000;

const slotsForMembers = (memberCount: number): string[] => {
  if (memberCount === 1) return ['center'];
  if (memberCount === 2) return ['top-center', 'bottom-center'];
  if (memberCount === 3) return ['top-left', 'top-right', 'bottom-center'];
  return ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
};

const clearFreshCalendarStickerTimers = () => {
  freshCalendarStickerTimers.forEach((timer) => clearTimeout(timer));
  freshCalendarStickerTimers = [];
};

const waitForMemberCalendarMotion = (): Promise<void> => new Promise((resolve) => {
  if (memberCalendarMotionTimer) clearTimeout(memberCalendarMotionTimer);
  memberCalendarMotionTimer = setTimeout(() => {
    memberCalendarMotionTimer = undefined;
    resolve();
  }, MEMBER_CALENDAR_MOTION_DURATION);
});

const clearEditorStickerTimers = () => {
  editorStickerTimers.forEach((timer) => clearTimeout(timer));
  editorStickerTimers = [];
};

const clearEditorProcessingTimer = () => {
  if (editorProcessingTimer) clearTimeout(editorProcessingTimer);
  editorProcessingTimer = undefined;
};

const invalidateEditorMediaTask = () => {
  editorMediaTaskToken += 1;
  clearEditorProcessingTimer();
};

const processingStageCopy: Record<string, string> = {
  uploading: '正在上传图片',
  reviewing_and_matting: '正在审核并生成贴纸',
  reviewing: '正在审核图片',
  matting: '正在生成贴纸',
  finalizing: '正在完成贴纸',
};

const finishCalendarMotion = () => {
  if (calendarMotionTimer) clearTimeout(calendarMotionTimer);
  calendarMotionTimer = undefined;
  const resolve = calendarMotionResolve;
  calendarMotionResolve = undefined;
  resolve?.();
};

const waitForCalendarMotion = (fallbackMilliseconds: number): Promise<void> => new Promise((resolve) => {
  finishCalendarMotion();
  calendarMotionResolve = resolve;
  calendarMotionTimer = setTimeout(finishCalendarMotion, fallbackMilliseconds);
});

const cancelStickerTimeline = () => {
  if (stickerTimelineTimer) clearTimeout(stickerTimelineTimer);
  stickerTimelineTimer = undefined;
  const resolve = stickerTimelineResolve;
  stickerTimelineResolve = undefined;
  resolve?.();
};

const waitForStickerTimeline = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  cancelStickerTimeline();
  stickerTimelineResolve = resolve;
  stickerTimelineTimer = setTimeout(() => {
    stickerTimelineTimer = undefined;
    stickerTimelineResolve = undefined;
    resolve();
  }, milliseconds);
});

Page({
  data: {
    statusBarHeight: 24,
    loading: true,
    initialShowPending: true,
    moduleId: '',
    module: null as LifeModule | null,
    currentUser: null as User | null,
    today: shanghaiDate(),
    month: monthOf(shanghaiDate()),
    recordDateMin: RECORD_DATE_MIN,
    recordDateMax: RECORD_DATE_MAX,
    currentMonthLabel: monthLabel(monthOf(shanghaiDate())),
    calendar: [] as AnimatedCalendarCell[],
    memberCalendars: [] as MemberCalendarPage[],
    memberCalendarOpen: false,
    memberCalendarClosing: false,
    memberCalendarIndex: 0,
    memberViews: [] as MemberView[],
    todayRecord: null as LifeRecord | null,
    todayProcessingCheckinId: '',
    monthRecordCount: 0,
    jointCompletedDays: 0,
    receivedReactionCount: 0,
    streakDays: 0,
    galleryCover: '/assets/stickers/group-3.png',
    galleryHasSticker: false,
    galleryStickerDelay: 0,
    galleryExitVisible: true,
    monthTransitioning: false,
    calendarTransitionClass: '',
    monthNumberClass: '',
    statsNumberClass: '',
    monthStickerPhase: 'sticker-visible',
    cellBackgroundPhase: 'cell-fill-visible',
    todoCount: 0,
    todoBadgePhase: 'badge-hidden',
    dateSheetOpen: false,
    dateSheetClosing: false,
    dateSheetCompact: false,
    selectedDate: '',
    selectedDateLabel: '',
    dateRecords: [] as RecordView[],
    dateAction: 'none',
    dateActionText: '',
    dateMessage: '',
    reactionOptions: getReactionOptions(),
    reactionPickerRecordId: '',
    editorOpen: false,
    editorClosing: false,
    editorMode: 'create',
    editorTitle: '记录今天',
    editorRecordId: '',
    editorDate: '',
    editorOriginalPath: '',
    editorMediaId: '',
    editorStickerPath: '',
    editorMediaVariant: 'sticker' as 'sticker' | 'original',
    editorStickerFallbackPath: '',
    editorStickerRefreshAttempts: 0,
    editorStickerPhase: 'sticker-hidden',
    editorRemark: '',
    editorMediaStatus: 'idle' as MediaStatus,
    editorMediaProgress: 0,
    editorMediaDetail: '',
    editorMediaErrorTitle: '贴纸生成失败',
    editorMediaError: '',
    editorMediaRetryable: false,
    editorProcessingCheckinId: '',
    editorSubmitText: '完成打卡',
    editorSourceType: 'gallery' as 'camera' | 'gallery',
    editorDirty: false,
    photoSourceOpen: false,
    photoSourceClosing: false,
    saving: false,
    rewardSettingsOpen: false,
    rewardSettingsClosing: false,
    rewardSettingsMode: 'form' as 'form' | 'list',
    rewardRuleListClosing: false,
    rewardView: null as StreakRewardRuleView | null,
    rewardRules: [] as RewardRuleDisplay[],
    rewardTargetOptions: [] as RewardTargetOption[],
    rewardTargetIndex: 0,
    rewardStreakDays: '7',
    rewardPrizeTitle: '',
    rewardPrizeDescription: '',
    rewardCoverMediaId: '',
    rewardCoverPath: '/subpackages/reward-assets/default-cover.png',
    rewardCoverStatus: 'idle' as 'idle' | 'processing' | 'ready' | 'failed',
    rewardCoverProgress: 0,
    rewardProbability: 80 as 20 | 50 | 80 | 100,
    rewardAgreement: false,
    rewardSaving: false,
    rewardCancellingId: '',
    rewardPreviewingId: '',
    rewardOpen: false,
    rewardOpening: false,
    rewardCardFlipped: false,
    rewardMotion: REWARD_MOTION,
    rewardMotionPhase: 'idle' as RewardMotionPhase,
    pendingReward: null as PendingStreakReward | null,
    pendingRewards: [] as PendingStreakReward[],
    rewardPendingIndex: 0,
    rewardPendingCount: 0,
    rewardBatchResults: [] as RevealedStreakReward[],
    revealedReward: null as RevealedStreakReward | null,
    rewardPreviewResult: null as RevealedStreakReward | null,
    rewardDateRange: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    if (!query.moduleId) {
      wx.showToast({ title: '模块不存在', icon: 'none' });
      void wx.navigateBack();
      return;
    }
    const requestedDate = query.date && isRecordDateInRange(query.date) ? query.date : '';
    const initialMonth = requestedDate ? requestedDate.slice(0, 7) : this.data.month;
    this.setData({
      moduleId: query.moduleId,
      month: initialMonth,
      currentMonthLabel: monthLabel(initialMonth),
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
    });
    const cached = moduleDetailCache.get(moduleDetailCacheKey(query.moduleId, initialMonth));
    const initialLoad = cached
      ? this.loadAll(false, true, cached)
      : this.loadAll(true, true);
    void initialLoad.then(() => {
      if (requestedDate && this.data.module) void this.openDateValue(requestedDate);
      if (!requestedDate) {
        void this.maybeShowStreakReward();
      }
      if (cached && calendarPageVisible) void this.syncCalendarInBackground();
    });
  },

  onShow() {
    calendarPageVisible = true;
    this.startCalendarSync();
    if (this.data.initialShowPending) {
      this.setData({ initialShowPending: false });
      return;
    }
    if (this.data.moduleId && this.data.module && !this.data.loading) {
      this.applyTodoBadge();
      void this.syncCalendarInBackground();
      void this.replayCalendarStickers();
      void this.maybeShowStreakReward();
    }
  },

  onHide() {
    calendarPageVisible = false;
    this.stopCalendarSync();
    this.finishFreshCalendarStickerAnimation();
  },

  onUnload() {
    calendarPageVisible = false;
    this.stopCalendarSync();
    this.finishFreshCalendarStickerAnimation();
    monthTransitionToken += 1;
    finishCalendarMotion();
    cancelStickerTimeline();
    clearEditorStickerTimers();
    clearRewardMotionTimer();
    invalidateEditorMediaTask();
    if (memberCalendarMotionTimer) clearTimeout(memberCalendarMotionTimer);
    memberCalendarMotionTimer = undefined;
    discardPrewarmedMediaUpload(this.data.moduleId);
    if (mediaProgressTimer) clearInterval(mediaProgressTimer);
  },

  async maybeShowStreakReward() {
    if (!this.data.moduleId || this.data.module?.recordPolicy !== 'strict' || this.data.rewardOpen
      || this.data.editorOpen || this.data.dateSheetOpen || this.data.photoSourceOpen || this.data.rewardSettingsOpen) return;
    try {
      const pendingRewards = await getPendingStreakRewards(this.data.moduleId);
      const pendingReward = pendingRewards[0];
      if (!pendingReward || this.data.rewardOpen || this.data.editorOpen || this.data.dateSheetOpen) return;
      this.setData({
        rewardOpen: true,
        rewardOpening: false,
        rewardCardFlipped: false,
        rewardMotionPhase: 'entering',
        pendingReward,
        pendingRewards,
        rewardPendingIndex: 0,
        rewardPendingCount: pendingRewards.length,
        rewardBatchResults: [],
        revealedReward: null,
        rewardPreviewResult: null,
        rewardDateRange: `${pendingReward.windowStart.replace(/-/g, '.')} — ${pendingReward.windowEnd.replace(/-/g, '.')}`,
      }, () => this.startRewardEntryMotion());
      track('streak_reward_prompt_view', { moduleId: this.data.moduleId, targetType: pendingReward.targetType });
    } catch (error) {
      console.error('[streak-reward] pending query failed', error);
    }
  },

  async revealReward() {
    const pendingReward = this.data.pendingReward;
    if (!pendingReward || this.data.rewardOpening || this.data.rewardCardFlipped) return;
    this.setData({ rewardOpening: true });
    try {
      const revealedReward = this.data.rewardPreviewResult
        ?? await revealStreakReward(pendingReward.rewardDrawId);
      if (revealedReward.stickerPath) await preloadImageSources([revealedReward.stickerPath]);
      this.setData({
        revealedReward,
        rewardCardFlipped: true,
        rewardMotionPhase: 'flipping',
      }, () => this.finishRewardRevealMotion());
      wx.vibrateShort?.({ type: 'light' });
      track('streak_reward_revealed', { moduleId: this.data.moduleId, resultType: revealedReward.resultType });
    } catch (error) {
      this.setData({ rewardOpening: false });
      console.error('[streak-reward] reveal failed', error);
      wx.showToast({ title: '暂时无法拆开，请稍后重试', icon: 'none' });
    }
  },

  async revealAllRewards() {
    if (this.data.rewardOpening || this.data.rewardPreviewResult || this.data.pendingRewards.length < 2) return;
    this.setData({ rewardOpening: true });
    try {
      const rewardBatchResults = await Promise.all(
        this.data.pendingRewards.map((reward) => revealStreakReward(reward.rewardDrawId)),
      );
      await preloadImageSources(rewardBatchResults.flatMap((reward) => [reward.stickerPath, reward.coverPath]
        .filter((path): path is string => Boolean(path))));
      this.setData({
        rewardBatchResults,
        rewardMotionPhase: 'flipping',
      }, () => this.finishRewardRevealMotion());
      wx.vibrateShort?.({ type: 'light' });
    } catch (error) {
      this.setData({ rewardOpening: false });
      console.error('[streak-reward] reveal all failed', error);
      wx.showToast({ title: '暂时无法全部拆开', icon: 'none' });
    }
  },

  acceptReward() {
    if (this.data.rewardOpening || this.data.rewardMotionPhase === 'advancing'
      || this.data.rewardMotionPhase === 'collecting' || this.data.rewardMotionPhase === 'closing') return;
    const nextIndex = this.data.rewardPendingIndex + 1;
    if (!this.data.rewardPreviewResult && nextIndex < this.data.pendingRewards.length) {
      const pendingReward = this.data.pendingRewards[nextIndex];
      this.setData({ rewardMotionPhase: 'advancing' });
      scheduleRewardMotion(() => {
        if (!this.data.rewardOpen || this.data.rewardMotionPhase !== 'advancing') return;
        this.setData({
          pendingReward,
          rewardPendingIndex: nextIndex,
          rewardCardFlipped: false,
          rewardMotionPhase: 'entering',
          revealedReward: null,
          rewardDateRange: `${pendingReward.windowStart.replace(/-/g, '.')} — ${pendingReward.windowEnd.replace(/-/g, '.')}`,
        }, () => this.startRewardEntryMotion());
      }, REWARD_MOTION.advanceDuration);
      return;
    }
    this.collectReward();
  },

  closeReward() {
    if (this.data.rewardOpening || this.data.rewardMotionPhase === 'closing'
      || this.data.rewardMotionPhase === 'collecting') return;
    this.setData({ rewardMotionPhase: 'closing' });
    scheduleRewardMotion(() => this.resetRewardDialog(), REWARD_MOTION.closeDuration);
  },

  collectReward() {
    if (this.data.rewardOpening || this.data.rewardMotionPhase === 'closing'
      || this.data.rewardMotionPhase === 'collecting') return;
    this.setData({ rewardMotionPhase: 'collecting' });
    scheduleRewardMotion(() => this.resetRewardDialog(), REWARD_MOTION.collectDuration);
  },

  startRewardEntryMotion() {
    scheduleRewardMotion(() => {
      if (this.data.rewardOpen && this.data.rewardMotionPhase === 'entering') {
        this.setData({ rewardMotionPhase: 'visible' });
      }
    }, REWARD_MOTION.entryDuration);
  },

  finishRewardRevealMotion() {
    scheduleRewardMotion(() => {
      if (this.data.rewardOpen && this.data.rewardMotionPhase === 'flipping') {
        this.setData({ rewardOpening: false, rewardMotionPhase: 'visible' });
      }
    }, REWARD_MOTION.flipDuration);
  },

  resetRewardDialog() {
    clearRewardMotionTimer();
    this.setData({
      rewardOpen: false,
      rewardOpening: false,
      rewardCardFlipped: false,
      rewardMotionPhase: 'idle',
      pendingReward: null,
      pendingRewards: [],
      rewardPendingIndex: 0,
      rewardPendingCount: 0,
      rewardBatchResults: [],
      revealedReward: null,
      rewardPreviewResult: null,
      rewardDateRange: '',
    });
  },

  async loadAll(showLoading = true, animateEntry = false, cached?: ModuleDetailCacheEntry) {
    const routeReady = animateEntry ? waitForAppRouteDone() : Promise.resolve();
    const inboxReady = getModuleInbox(this.data.moduleId).catch(() => undefined);
    if (showLoading) this.setData({ loading: true });
    try {
      const [module, currentUser, calendar] = cached
        ? [cached.module, cached.currentUser, cached.calendar]
        : await Promise.all([
            getModule(this.data.moduleId),
            getCurrentUser(),
            getCalendar(this.data.moduleId, this.data.month),
            refreshModuleMonthSummary(this.data.moduleId, this.data.month),
          ]);
      if (!cached) await inboxReady;
      moduleDetailCache.set(moduleDetailCacheKey(this.data.moduleId, this.data.month), {
        module,
        currentUser,
        calendar,
      });
      const todayCell = calendar.find((cell) => cell.date === this.data.today);
      const todayRecords = todayCell?.records ?? [];
      const todayRecord = todayRecords.find((record) => record.userId === currentUser.userId) ?? null;
      const memberViews = module.members.map<MemberView>((member) => ({
        memberInstanceId: member.memberInstanceId,
        nickname: member.nickname,
        avatarText: member.avatarText,
        avatarColor: member.avatarColor,
        avatarUrl: member.avatarUrl,
        roleLabel: member.role === 'creator' ? '创建者' : '',
        isMine: member.userId === currentUser.userId,
        recordedToday: todayRecords.some((record) => record.memberInstanceId === member.memberInstanceId),
      }));
      const memberCalendars = buildMemberCalendarPages(calendar, module.members, currentUser.userId);
      const previousMemberId = this.data.memberCalendars[this.data.memberCalendarIndex]?.memberInstanceId;
      const preferredMemberId = previousMemberId
        ?? module.members.find((member) => member.userId === currentUser.userId)?.memberInstanceId;
      const preferredMemberIndex = memberCalendars.findIndex((item) => item.memberInstanceId === preferredMemberId);
      const presentation = this.buildMonthPresentation(calendar, module, currentUser, this.data.month);
      if (animateEntry) cancelStickerTimeline();
      const token = animateEntry ? ++monthTransitionToken : monthTransitionToken;
      const stickerPlan = animateEntry ? createCalendarStickerPlan(calendar, presentation.galleryHasSticker) : null;
      await new Promise<void>((resolve) => this.setData({
        module,
        currentUser,
        calendar: stickerPlan?.calendar ?? showCalendarStickers(calendar),
        memberCalendars,
        memberCalendarOpen: this.data.memberCalendarOpen && memberCalendars.length > 1,
        memberCalendarClosing: false,
        memberCalendarIndex: Math.max(0, preferredMemberIndex),
        memberViews,
        todayRecord,
        todayProcessingCheckinId: todayCell?.processingCheckinId ?? '',
        ...presentation,
        galleryStickerDelay: stickerPlan?.galleryDelay ?? 0,
        galleryExitVisible: !animateEntry,
        currentMonthLabel: monthLabel(this.data.month),
        monthTransitioning: animateEntry,
        calendarTransitionClass: '',
        monthNumberClass: '',
        statsNumberClass: '',
        monthStickerPhase: animateEntry ? 'sticker-hidden' : 'sticker-visible',
        cellBackgroundPhase: 'cell-fill-visible',
        todoBadgePhase: presentation.todoCount ? 'badge-visible' : 'badge-hidden',
        loading: false,
      }, resolve));
      if (cached) void inboxReady.then(() => this.applyTodoBadge());
      track('module_detail_view', {
        moduleId: module.moduleId,
        moduleMode: module.mode,
        memberCount: module.members.length,
        currentUserRole: module.members.find((member) => member.userId === currentUser.userId)?.role,
        todayPrimaryAction: todayCell?.processingCheckinId ? 'resume_processing' : todayRecord ? 'edit_today' : 'record_today',
      });
      if (!animateEntry || !stickerPlan) return;

      await routeReady;
      if (token !== monthTransitionToken) return;
      await waitForStickerTimeline(STICKER_MOTION.pageSettledDelay);
      if (token !== monthTransitionToken) return;
      stickerSequenceStartedAt = Date.now();
      this.setData({ monthStickerPhase: 'sticker-entering' });

      await waitForStickerTimeline(stickerPlan.finalDelay + STICKER_MOTION.duration);
      if (token !== monthTransitionToken) return;
      stickerSequenceStartedAt = 0;
      this.setData({
        monthStickerPhase: 'sticker-visible',
        galleryExitVisible: true,
        todoBadgePhase: presentation.todoCount ? 'badge-visible' : 'badge-hidden',
        monthTransitioning: false,
      });
    } catch {
      this.setData({ loading: false, monthTransitioning: false });
      wx.showToast({ title: '模块加载失败', icon: 'none' });
    }
  },

  startCalendarSync() {
    this.stopCalendarSync(false);
    calendarSyncTimer = setInterval(() => void this.syncCalendarInBackground(), CALENDAR_SYNC_INTERVAL);
  },

  stopCalendarSync(invalidate = true) {
    if (calendarSyncTimer) clearInterval(calendarSyncTimer);
    calendarSyncTimer = undefined;
    if (invalidate) calendarSyncGeneration += 1;
  },

  async syncCalendarInBackground() {
    if (calendarSyncInFlight
      || !calendarPageVisible
      || !this.data.module
      || !this.data.currentUser
      || this.data.loading
      || this.data.monthTransitioning
      || this.data.editorOpen
      || this.data.dateSheetOpen
      || this.data.saving) return;
    calendarSyncInFlight = true;
    const generation = calendarSyncGeneration;
    const month = this.data.month;
    const moduleId = this.data.moduleId;
    try {
      const [snapshot, , freshModule] = await Promise.all([
        getCalendar(moduleId, month),
        getModuleInbox(moduleId).catch(() => undefined),
        refreshModule(moduleId),
      ]);
      if (generation !== calendarSyncGeneration
        || !calendarPageVisible
        || month !== this.data.month
        || moduleId !== this.data.moduleId) return;
      this.applyTodoBadge();
      await this.applyCalendarSnapshot(snapshot, Promise.resolve(), generation, freshModule);
    } catch {
      // Background reconciliation keeps the last rendered snapshot on transient failures.
    } finally {
      calendarSyncInFlight = false;
    }
  },

  applyTodoBadge() {
    const todoCount = getModuleInboxCount(this.data.moduleId);
    if (todoCount === this.data.todoCount) return;
    this.setData({
      todoCount,
      todoBadgePhase: todoCount ? 'badge-visible' : 'badge-hidden',
    });
  },

  finishFreshCalendarStickerAnimation() {
    clearFreshCalendarStickerTimers();
    const patch: Record<string, unknown> = {};
    this.data.calendar.forEach((cell, cellIndex) => {
      cell.records.forEach((record, recordIndex) => {
        if (record.motionPhase) patch[`calendar[${cellIndex}].records[${recordIndex}].motionPhase`] = '';
      });
    });
    if (Object.keys(patch).length) this.setData(patch);
  },

  playFreshCalendarStickerAnimation(locations: CalendarStickerLocation[], finalDelay: number) {
    if (!locations.length) return;
    freshCalendarStickerTimers.push(setTimeout(() => {
      const enteringPatch = locations.reduce<Record<string, unknown>>((patch, location) => {
        patch[`calendar[${location.cellIndex}].records[${location.recordIndex}].motionPhase`] = 'sticker-entering';
        return patch;
      }, {});
      this.setData(enteringPatch);
    }, STICKER_MOTION.pageSettledDelay));
    freshCalendarStickerTimers.push(setTimeout(() => {
      const visiblePatch = locations.reduce<Record<string, unknown>>((patch, location) => {
        patch[`calendar[${location.cellIndex}].records[${location.recordIndex}].motionPhase`] = '';
        return patch;
      }, {});
      this.setData(visiblePatch);
      freshCalendarStickerTimers = [];
    }, STICKER_MOTION.pageSettledDelay + finalDelay + STICKER_MOTION.duration));
  },

  async applyCalendarSnapshot(
    snapshot: CalendarCell[],
    beforeApply: Promise<void> = Promise.resolve(),
    generation = calendarSyncGeneration,
    moduleSnapshot?: LifeModule,
  ): Promise<boolean> {
    const module = this.data.module;
    const currentUser = this.data.currentUser;
    if (!module || !currentUser) return false;
    const memberPlan = mergeMemberSnapshot(module.members, moduleSnapshot?.members ?? module.members);
    const syncedModule = memberPlan.changed ? {
      ...module,
      members: memberPlan.members,
      creatorUserId: moduleSnapshot?.creatorUserId ?? module.creatorUserId,
      version: moduleSnapshot?.version ?? module.version,
    } : module;
    const normalizedSnapshot = snapshot.map((cell) => ({
      ...cell,
      records: cell.records.map((record) => ({
        ...record,
        member: syncedModule.members.find((member) => member.memberInstanceId === record.memberInstanceId) ?? record.member,
      })),
    }));
    const plan = mergeCalendarSnapshot(this.data.calendar, normalizedSnapshot);
    const summaryPromise = refreshModuleMonthSummary(module.moduleId, this.data.month);
    await Promise.all([
      preloadImageSources([...plan.animatedStickerSources, ...memberPlan.avatarSources]),
      beforeApply,
      summaryPromise,
    ]);
    if (generation !== calendarSyncGeneration || module.moduleId !== this.data.moduleId) return false;
    moduleDetailCache.set(moduleDetailCacheKey(module.moduleId, this.data.month), {
      module: syncedModule,
      currentUser,
      calendar: normalizedSnapshot,
    });
    const summary = await summaryPromise;
    const summaryChanged = summary.currentUserRecordedDays !== this.data.monthRecordCount
      || summary.jointCompletedDays !== this.data.jointCompletedDays
      || summary.receivedReactionCount !== this.data.receivedReactionCount;
    if (!plan.changedCellIndexes.length && !memberPlan.changed && !summaryChanged) return false;
    this.finishFreshCalendarStickerAnimation();
    const patch: Record<string, unknown> = {};
    plan.changedCellIndexes.forEach((cellIndex) => {
      const cell = plan.calendar[cellIndex];
      patch[`calendar[${cellIndex}].hasRecords`] = cell.hasRecords;
      patch[`calendar[${cellIndex}].hasPendingMakeup`] = Boolean(cell.hasPendingMakeup);
      patch[`calendar[${cellIndex}].processingCheckinId`] = cell.processingCheckinId ?? '';
      patch[`calendar[${cellIndex}].records`] = cell.records;
    });
    const todayCell = plan.calendar.find((cell) => cell.date === this.data.today);
    const todayRecords = todayCell?.records ?? [];
    patch.todayRecord = todayRecords.find((record) => record.userId === currentUser.userId) ?? null;
    patch.todayProcessingCheckinId = todayCell?.processingCheckinId ?? '';
    const memberCalendars = buildMemberCalendarPages(plan.calendar, syncedModule.members, currentUser.userId);
    if (memberPlan.changed) {
      patch['module.members'] = memberPlan.members;
      patch.memberViews = syncedModule.members.map<MemberView>((member) => ({
        memberInstanceId: member.memberInstanceId,
        nickname: member.nickname,
        avatarText: member.avatarText,
        avatarColor: member.avatarColor,
        avatarUrl: member.avatarUrl,
        roleLabel: member.role === 'creator' ? '\u521b\u5efa\u8005' : '',
        isMine: member.userId === currentUser.userId,
        recordedToday: todayRecords.some((record) => record.memberInstanceId === member.memberInstanceId),
      }));
      const selectedMemberId = this.data.memberCalendars[this.data.memberCalendarIndex]?.memberInstanceId;
      const selectedMemberIndex = memberCalendars.findIndex((item) => item.memberInstanceId === selectedMemberId);
      patch.memberCalendars = memberCalendars;
      patch.memberCalendarIndex = Math.max(0, selectedMemberIndex);
      patch.memberCalendarOpen = this.data.memberCalendarOpen && memberCalendars.length > 1;
      patch.memberCalendarClosing = false;
    } else {
      syncedModule.members.forEach((member, memberIndex) => {
        const recordedToday = todayRecords.some((record) => record.memberInstanceId === member.memberInstanceId);
        if (this.data.memberViews[memberIndex]?.recordedToday !== recordedToday) {
          patch[`memberViews[${memberIndex}].recordedToday`] = recordedToday;
        }
      });
      memberCalendars.forEach((memberCalendar, pageIndex) => {
        const currentPage = this.data.memberCalendars[pageIndex];
        memberCalendar.cells.forEach((cell, cellIndex) => {
          const currentCell = currentPage?.cells[cellIndex];
          if (!currentCell
            || currentCell.recordId !== cell.recordId
            || currentCell.stickerPath !== cell.stickerPath
            || currentCell.hasRecord !== cell.hasRecord) {
            patch[`memberCalendars[${pageIndex}].cells[${cellIndex}]`] = cell;
          }
        });
      });
    }
    const monthCells = plan.calendar.filter((cell) => cell.inMonth);
    const monthRecords = monthCells.flatMap((cell) => cell.records);
    patch.monthRecordCount = summary.currentUserRecordedDays;
    patch.jointCompletedDays = summary.jointCompletedDays;
    patch.receivedReactionCount = summary.receivedReactionCount;
    patch.streakDays = this.calculateStreak(plan.calendar, currentUser.userId);
    patch.galleryHasSticker = monthRecords.length > 0;
    patch.galleryCover = monthRecords[monthRecords.length - 1]?.stickerPath ?? '/assets/stickers/group-3.png';
    this.setData(patch, () => this.playFreshCalendarStickerAnimation(
      plan.animatedStickerLocations,
      plan.finalDelay,
    ));
    return true;
  },

  calendarSnapshotWithRecord(record: LifeRecord): CalendarCell[] {
    const module = this.data.module;
    if (!module) return this.data.calendar;
    const memberIndex = Math.max(0, module.members.findIndex((member) => member.memberInstanceId === record.memberInstanceId));
    const member = module.members[memberIndex];
    if (!member) return this.data.calendar;
    const calendarRecord = {
      ...record,
      member,
      slot: slotsForMembers(module.members.length)[memberIndex] ?? 'center',
    };
    return this.data.calendar.map((cell) => {
      if (cell.date !== record.recordDate) return cell;
      const records = [...cell.records.filter((item) => item.memberInstanceId !== record.memberInstanceId), calendarRecord]
        .sort((left, right) => module.members.findIndex((memberItem) => memberItem.memberInstanceId === left.memberInstanceId)
          - module.members.findIndex((memberItem) => memberItem.memberInstanceId === right.memberInstanceId));
      return { ...cell, hasRecords: true, processingCheckinId: undefined, records };
    });
  },

  calendarSnapshotWithoutRecord(recordId: string): CalendarCell[] {
    return this.data.calendar.map((cell) => {
      const records = cell.records.filter((record) => record.recordId !== recordId);
      return records.length === cell.records.length ? cell : { ...cell, hasRecords: records.length > 0, records };
    });
  },

  async replayCalendarStickers() {
    this.finishFreshCalendarStickerAnimation();
    cancelStickerTimeline();
    const token = ++monthTransitionToken;
    const finalDelay = Math.max(
      this.data.galleryHasSticker ? this.data.galleryStickerDelay : 0,
      ...this.data.calendar.flatMap((cell) => cell.records.map((record) => record.popDelay)),
    );
    stickerSequenceStartedAt = 0;
    this.setData({
      monthStickerPhase: 'sticker-hidden',
      galleryExitVisible: false,
      monthTransitioning: true,
      cellBackgroundPhase: 'cell-fill-visible',
      todoBadgePhase: this.data.todoCount ? 'badge-visible' : 'badge-hidden',
    });
    await waitForAppRouteDone(180);
    if (token !== monthTransitionToken) return;
    await waitForStickerTimeline(STICKER_MOTION.pageSettledDelay);
    if (token !== monthTransitionToken) return;
    stickerSequenceStartedAt = Date.now();
    this.setData({ monthStickerPhase: 'sticker-entering' });
    await waitForStickerTimeline(finalDelay + STICKER_MOTION.duration);
    if (token !== monthTransitionToken) return;
    stickerSequenceStartedAt = 0;
    this.setData({
      monthStickerPhase: 'sticker-visible',
      galleryExitVisible: true,
      monthTransitioning: false,
    });
  },

  calculateStreak(calendar: CalendarCell[], userId: string): number {
    let date = this.data.today;
    const todayHasRecord = calendar.find((cell) => cell.date === date)?.records.some((record) => record.userId === userId);
    if (!todayHasRecord) date = addDays(date, -1);
    let count = 0;
    while (count < 42) {
      const recorded = calendar.find((cell) => cell.date === date)?.records.some((record) => record.userId === userId);
      if (!recorded) break;
      count += 1;
      date = addDays(date, -1);
    }
    return count;
  },

  buildMonthPresentation(calendar: CalendarCell[], module: LifeModule, currentUser: User, month: string) {
    const monthCells = calendar.filter((cell) => cell.inMonth);
    const monthRecords = monthCells.flatMap((cell) => cell.records);
    const galleryCover = monthRecords[monthRecords.length - 1]?.stickerPath ?? '/assets/stickers/group-3.png';
    const summary = getModuleMonthSummary(module.moduleId, month);
    return {
      monthRecordCount: summary.currentUserRecordedDays,
      jointCompletedDays: summary.jointCompletedDays,
      receivedReactionCount: summary.receivedReactionCount,
      streakDays: this.calculateStreak(calendar, currentUser.userId),
      galleryCover,
      galleryHasSticker: monthRecords.length > 0,
      todoCount: getModuleInboxCount(module.moduleId),
    };
  },

  shareModuleTap() {
    track('module_invite_share_click', { moduleId: this.data.moduleId, source: 'module_detail' });
  },

  shareCalendarToDiscovery() {
    const query = [
      'postType=calendar',
      `sourceId=${encodeURIComponent(`calendar_${this.data.moduleId}_${this.data.month}`)}`,
      `moduleId=${encodeURIComponent(this.data.moduleId)}`,
      `month=${encodeURIComponent(this.data.month)}`,
    ].join('&');
    track('discovery_share_source_click', { source: 'calendar', moduleId: this.data.moduleId, month: this.data.month });
    void wx.navigateTo({ url: `/subpackages/discover-publish/index?${query}` });
  },

  async shareRecordToDiscovery(event: WechatMiniprogram.TouchEvent) {
    const recordId = String(event.currentTarget.dataset.record ?? '');
    if (!recordId) return;
    await this.dismissDateSheet();
    track('discovery_share_source_click', { source: 'record', recordId });
    void wx.navigateTo({
      url: `/subpackages/discover-publish/index?postType=record&sourceId=${encodeURIComponent(recordId)}`,
    });
  },

  onShareAppMessage() {
    const module = this.data.module;
    const fallback = {
      title: module ? `邀请你一起记录「${module.name}」` : '邀请你一起记录生活',
      path: '/pages/home/index',
    };
    if (!module || module.members.length >= 4) return fallback;

    return {
      ...fallback,
      promise: createModuleInvite(module.moduleId)
        .then((preview) => {
          track('module_invite_share_ready', {
            moduleId: module.moduleId,
            inviteId: preview.invite.inviteId,
            source: 'module_detail',
          });
          return {
            title: `${preview.inviter.nickname}邀请你加入「${preview.module.name}」`,
            path: `/subpackages/invite-intro/index?inviteId=${preview.invite.inviteId}`,
          };
        })
        .catch(() => {
          wx.showToast({ title: '邀请链接生成失败，请重试', icon: 'none' });
          return fallback;
        }),
    };
  },

  goBack() {
    wx.navigateBack();
  },

  previousMonth() {
    const target = previousMonth(this.data.month);
    if (target < RECORD_DATE_MIN.slice(0, 7)) return;
    void this.changeMonth(target, 'previous');
  },

  nextMonth() {
    const target = nextMonth(this.data.month);
    if (target > RECORD_DATE_MAX.slice(0, 7)) return;
    void this.changeMonth(target, 'next');
  },

  onCalendarMonthPick(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const target = event.detail.value.slice(0, 7);
    if (target === this.data.month || target < RECORD_DATE_MIN.slice(0, 7) || target > RECORD_DATE_MAX.slice(0, 7)) return;
    void this.changeMonth(target, target > this.data.month ? 'next' : 'previous');
  },

  async changeMonth(targetMonth: string, direction: 'previous' | 'next') {
    if (
      !this.data.module
      || !this.data.currentUser
      || this.data.calendarTransitionClass
      || this.data.monthStickerPhase === 'sticker-leaving'
    ) return;

    calendarSyncGeneration += 1;
    this.finishFreshCalendarStickerAnimation();
    cancelStickerTimeline();
    const token = ++monthTransitionToken;
    const module = this.data.module;
    const currentUser = this.data.currentUser;
    const targetTodoCount = getModuleInboxCount(module.moduleId);
    const todoChanged = targetTodoCount !== this.data.todoCount;
    const exitClass = direction === 'next' ? 'calendar-exit-left' : 'calendar-exit-right';
    const enterClass = direction === 'next' ? 'calendar-enter-right' : 'calendar-enter-left';
    const numberExitClass = direction === 'next' ? 'number-exit-up' : 'number-exit-down';
    const numberEnterClass = direction === 'next' ? 'number-enter-up' : 'number-enter-down';
    const elapsedStickerTime = stickerSequenceStartedAt ? Date.now() - stickerSequenceStartedAt : Number.POSITIVE_INFINITY;
    const exitingCalendar = prepareCalendarForExit(
      this.data.calendar,
      this.data.monthStickerPhase,
      elapsedStickerTime,
    );
    const galleryExitVisible = this.data.monthStickerPhase === 'sticker-visible'
      || (this.data.monthStickerPhase === 'sticker-entering' && elapsedStickerTime >= this.data.galleryStickerDelay);

    this.setData({
      monthTransitioning: true,
      memberCalendarOpen: false,
      memberCalendarClosing: false,
      calendar: exitingCalendar,
      galleryExitVisible,
      monthStickerPhase: 'sticker-leaving',
      todoBadgePhase: todoChanged && this.data.todoCount ? 'badge-leaving' : this.data.todoBadgePhase,
    });
    const calendarPromise = getCalendar(this.data.moduleId, targetMonth);
    const summaryPromise = refreshModuleMonthSummary(this.data.moduleId, targetMonth);

    try {
      await waitForStickerTimeline(STICKER_MOTION.oldPageFadeDuration);
      if (token !== monthTransitionToken) return;
      const exitMotion = waitForCalendarMotion(280);
      this.setData({
        monthStickerPhase: 'sticker-hidden',
        todoBadgePhase: todoChanged ? 'badge-hidden' : this.data.todoBadgePhase,
        calendarTransitionClass: exitClass,
        monthNumberClass: numberExitClass,
        statsNumberClass: numberExitClass,
      });

      const [calendar] = await Promise.all([calendarPromise, exitMotion, summaryPromise]);
      if (token !== monthTransitionToken) return;
      const presentation = this.buildMonthPresentation(calendar, module, currentUser, targetMonth);
      moduleDetailCache.set(moduleDetailCacheKey(module.moduleId, targetMonth), {
        module,
        currentUser,
        calendar,
      });
      const stickerPlan = createCalendarStickerPlan(calendar, presentation.galleryHasSticker);
      const memberCalendars = buildMemberCalendarPages(calendar, module.members, currentUser.userId);
      const selectedMemberId = this.data.memberCalendars[this.data.memberCalendarIndex]?.memberInstanceId;
      const selectedMemberIndex = memberCalendars.findIndex((item) => item.memberInstanceId === selectedMemberId);
      const enterMotion = waitForCalendarMotion(340);
      this.setData({
        month: targetMonth,
        calendar: stickerPlan.calendar,
        memberCalendars,
        memberCalendarIndex: Math.max(0, selectedMemberIndex),
        currentMonthLabel: monthLabel(targetMonth),
        ...presentation,
        galleryStickerDelay: stickerPlan.galleryDelay,
        galleryExitVisible: false,
        monthStickerPhase: 'sticker-hidden',
        cellBackgroundPhase: 'cell-fill-hidden',
        todoCount: targetTodoCount,
        todoBadgePhase: todoChanged ? 'badge-hidden' : this.data.todoBadgePhase,
        calendarTransitionClass: enterClass,
        monthNumberClass: numberEnterClass,
        statsNumberClass: numberEnterClass,
      });

      await enterMotion;
      if (token !== monthTransitionToken) return;
      this.setData({ calendarTransitionClass: '', monthNumberClass: '', statsNumberClass: '' });

      await waitForStickerTimeline(STICKER_MOTION.pageSettledDelay);
      if (token !== monthTransitionToken) return;
      this.setData({ cellBackgroundPhase: 'cell-fill-entering' });

      await waitForStickerTimeline(STICKER_MOTION.cellRevealDuration);
      if (token !== monthTransitionToken) return;
      stickerSequenceStartedAt = Date.now();
      this.setData({
        cellBackgroundPhase: 'cell-fill-visible',
        monthStickerPhase: 'sticker-entering',
        todoBadgePhase: todoChanged && targetTodoCount ? 'badge-entering' : this.data.todoBadgePhase,
      });

      await waitForStickerTimeline(stickerPlan.finalDelay + STICKER_MOTION.duration);
      if (token !== monthTransitionToken) return;
      stickerSequenceStartedAt = 0;
      this.setData({
        monthStickerPhase: 'sticker-visible',
        galleryExitVisible: true,
        todoBadgePhase: targetTodoCount ? 'badge-visible' : 'badge-hidden',
        monthTransitioning: false,
      });
    } catch {
      if (token !== monthTransitionToken) return;
      finishCalendarMotion();
      cancelStickerTimeline();
      stickerSequenceStartedAt = 0;
      this.setData({
        monthTransitioning: false,
        calendarTransitionClass: '',
        monthNumberClass: '',
        statsNumberClass: '',
        monthStickerPhase: 'sticker-visible',
        cellBackgroundPhase: 'cell-fill-visible',
        todoBadgePhase: this.data.todoCount ? 'badge-visible' : 'badge-hidden',
      });
      wx.showToast({ title: '月份加载失败，请重试', icon: 'none' });
    }
  },

  onCalendarTransitionEnd(event: WechatMiniprogram.BaseEvent) {
    if (event.target.id !== 'month-calendar-grid') return;
    finishCalendarMotion();
  },

  onCalendarTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (this.data.memberCalendarOpen) return;
    calendarTouchStartX = event.touches[0]?.clientX ?? 0;
  },

  onCalendarTouchEnd(event: WechatMiniprogram.TouchEvent) {
    if (this.data.memberCalendarOpen) return;
    const endX = event.changedTouches[0]?.clientX ?? calendarTouchStartX;
    const distance = endX - calendarTouchStartX;
    if (Math.abs(distance) < 52) return;
    if (distance > 0) this.previousMonth();
    else this.nextMonth();
  },

  toggleMemberCalendar() {
    if (this.data.memberCalendarClosing || this.data.monthTransitioning) return;
    if (this.data.memberCalendarOpen) {
      void this.dismissMemberCalendar();
      return;
    }
    if (this.data.memberCalendars.length < 2) return;
    this.setData({ memberCalendarOpen: true, memberCalendarClosing: false });
    track('member_calendar_popover_open', {
      moduleId: this.data.moduleId,
      month: this.data.month,
      memberCount: this.data.memberCalendars.length,
    });
  },

  closeMemberCalendar() {
    void this.dismissMemberCalendar();
  },

  async dismissMemberCalendar() {
    if (!this.data.memberCalendarOpen || this.data.memberCalendarClosing) return;
    this.setData({ memberCalendarClosing: true });
    track('member_calendar_popover_close', {
      moduleId: this.data.moduleId,
      month: this.data.month,
      memberCount: this.data.memberCalendars.length,
    });
    await waitForMemberCalendarMotion();
    if (!this.data.memberCalendarClosing) return;
    this.setData({ memberCalendarOpen: false, memberCalendarClosing: false });
  },

  onMemberCalendarChange(event: WechatMiniprogram.SwiperChange) {
    const index = event.detail.current;
    if (index === this.data.memberCalendarIndex) return;
    this.setData({ memberCalendarIndex: index });
    track('member_calendar_swipe', {
      moduleId: this.data.moduleId,
      month: this.data.month,
      memberInstanceId: this.data.memberCalendars[index]?.memberInstanceId,
    });
  },

  openDate(event: WechatMiniprogram.TouchEvent) {
    const recordDate = event.currentTarget.dataset.date as string;
    void this.openDateValue(recordDate);
  },

  async openDateValue(recordDate: string) {
    if (!isRecordDateInRange(recordDate)) {
      wx.showToast({ title: '日期需在 1900 至 2099 年之间', icon: 'none' });
      return;
    }
    const records = await getDateRecords(this.data.moduleId, recordDate);
    const module = this.data.module;
    const user = this.data.currentUser;
    if (!module || !user) return;
    const pendingMakeup = module.recordPolicy === 'strict'
      ? await getCurrentMakeupApproval(this.data.moduleId, recordDate)
      : undefined;
    const reactions = await Promise.all(records.map((record) => getRecordReactions(record.recordId)));
    const views = records.map<RecordView>((record, index) => {
      const member = module.members.find((item) => item.memberInstanceId === record.memberInstanceId);
      return {
        ...record,
        ownerName: member?.nickname ?? '已退出成员',
        ownerAvatarText: member?.avatarText ?? '旧',
        ownerAvatarColor: member?.avatarColor ?? '#8b8e88',
        ownerAvatarUrl: member?.avatarUrl,
        isMine: record.userId === user.userId,
        timeLabel: record.firstEffectiveAt.slice(11, 16),
        reactions: reactions[index],
      };
    });
    const offset = differenceInDays(recordDate, this.data.today);
    const mine = currentUserRecord(records);
    let dateAction = 'none';
    let dateActionText = '';
    let dateMessage = '';
    if (module.recordPolicy === 'relaxed') {
      dateAction = mine ? 'edit_record' : 'record_date';
      dateActionText = mine ? '编辑记录' : '记录这一天';
      dateMessage = offset > 0 ? '记录会立即显示，并在当天纳入统计' : '保存后直接生效，无需审批';
    } else if (offset === 0) {
      dateAction = mine ? 'edit_today' : 'record_today';
      dateActionText = mine ? '编辑今日' : '记录今日';
    } else if (offset >= -3 && offset < 0 && pendingMakeup) {
      dateMessage = '补卡审批中，结果将在待办中更新';
    } else if (offset >= -3 && offset < 0 && !mine) {
      dateAction = 'makeup';
      dateActionText = '申请补卡';
      dateMessage = module.mode === 'solo' ? '提交后将直接生效' : '提交后由其他成员审批';
    } else if (offset < -3) {
      dateMessage = '已超过补录时间';
    } else if (offset > 0) {
      dateMessage = '这一天还静悄悄的～';
    }
    this.setData({
      dateSheetOpen: true,
      dateSheetClosing: false,
      dateSheetCompact: offset > 0,
      selectedDate: recordDate,
      selectedDateLabel: dateLabel(recordDate),
      dateRecords: views,
      dateAction,
      dateActionText,
      dateMessage,
      reactionPickerRecordId: '',
    });
    track(offset > 0 ? 'future_date_sheet_view' : 'date_detail_sheet_view', {
      moduleId: this.data.moduleId,
      recordDate,
      recordCount: records.length,
      primaryActionType: dateAction,
      sheetVariant: offset > 0 ? 'compact' : 'full',
    });
  },

  async dismissDateSheet() {
    if (!this.data.dateSheetOpen || this.data.dateSheetClosing) return;
    this.setData({ dateSheetClosing: true });
    await waitForSheetMotion();
    if (!this.data.dateSheetClosing) return;
    this.setData({ dateSheetOpen: false, dateSheetClosing: false });
  },

  closeDateSheet() {
    void this.dismissDateSheet().then(() => this.maybeShowStreakReward());
  },

  async onDatePrimaryAction() {
    const record = this.data.dateRecords.find((item) => item.isMine);
    const isMakeup = this.data.dateAction === 'makeup';
    const targetDate = isMakeup || this.data.module?.recordPolicy === 'relaxed'
      ? this.data.selectedDate
      : this.data.today;
    await this.dismissDateSheet();
    this.openEditor(record, targetDate, isMakeup);
  },

  openTodayEditor() {
    if (this.data.todayProcessingCheckinId) {
      this.openProcessingEditor(this.data.todayProcessingCheckinId);
      return;
    }
    this.openEditor(this.data.todayRecord ?? undefined);
  },

  openProcessingEditor(checkinId: string) {
    this.openEditor(undefined, this.data.today);
    discardPrewarmedMediaUpload(this.data.moduleId);
    const token = ++editorMediaTaskToken;
    this.setData({
      editorProcessingCheckinId: checkinId,
      editorRecordId: checkinId,
      editorMediaStatus: 'processing',
      editorMediaDetail: '正在继续生成贴纸',
      editorMediaErrorTitle: '贴纸生成失败',
      editorMediaError: '',
      editorSubmitText: '完成',
    });
    void this.pollProcessingCheckin(checkinId, token);
  },

  openEditor(record?: LifeRecord, recordDate?: string, forceMakeup = false) {
    const targetDate = recordDate ?? this.data.today;
    const isEdit = Boolean(record);
    const isMakeup = forceMakeup;
    const targetLabel = dateLabel(targetDate);
    invalidateEditorMediaTask();
    clearEditorStickerTimers();
    this.setData({
      editorOpen: true,
      editorClosing: false,
      editorMode: isMakeup ? 'makeup' : (isEdit ? 'edit' : 'create'),
      editorTitle: isMakeup ? '申请补卡' : (isEdit ? `编辑 ${targetLabel}` : `记录 ${targetLabel}`),
      editorRecordId: record?.recordId ?? '',
      editorDate: targetDate,
      editorOriginalPath: record?.originalPath ?? '',
      editorMediaId: record?.mediaId ?? '',
      editorStickerPath: record?.generatedStickerPath ?? record?.stickerPath ?? '',
      editorMediaVariant: record?.mediaVariant ?? 'sticker',
      editorStickerFallbackPath: '',
      editorStickerRefreshAttempts: 0,
      editorStickerPhase: record ? 'sticker-hidden' : 'sticker-visible',
      editorRemark: record?.remark ?? '',
      editorMediaStatus: record ? 'ready' : 'idle',
      editorMediaProgress: record ? 100 : 0,
      editorMediaDetail: '',
      editorMediaErrorTitle: '贴纸生成失败',
      editorMediaError: '',
      editorMediaRetryable: false,
      editorProcessingCheckinId: '',
      editorSubmitText: isMakeup ? '提交补卡' : (isEdit ? '保存修改' : '完成打卡'),
      editorSourceType: 'gallery',
      editorDirty: false,
      photoSourceOpen: false,
      photoSourceClosing: false,
      saving: false,
    }, () => {
      if (record) this.playEditorStickerAnimation();
    });
    track('record_editor_view', {
      editorMode: isMakeup ? 'makeup' : (isEdit ? 'edit' : 'create'),
      recordDate: targetDate,
      hasExistingPhoto: Boolean(record),
      hasExistingRemark: Boolean(record?.remark),
      sheetPresentation: 'high_bottom_sheet',
    });
    if (!record) prewarmMediaUpload(this.data.moduleId);
  },

  async dismissEditor() {
    if (!this.data.editorOpen || this.data.editorClosing) return;
    if (this.data.photoSourceOpen) await this.dismissPhotoSource();
    invalidateEditorMediaTask();
    discardPrewarmedMediaUpload(this.data.moduleId);
    clearEditorStickerTimers();
    this.setData({ editorClosing: true });
    await waitForSheetMotion();
    if (!this.data.editorClosing) return;
    this.setData({ editorOpen: false, editorClosing: false });
  },

  closeEditor() {
    if (this.data.saving || this.data.editorClosing) return;
    if (!this.data.editorDirty && this.data.editorMediaStatus !== 'processing') {
      void this.dismissEditor();
      return;
    }
    wx.showModal({
      title: '放弃这次修改？',
      content: '照片和备注不会保存。',
      confirmText: '放弃',
      confirmColor: '#e65f45',
      success: ({ confirm }) => {
        if (confirm) void this.dismissEditor();
      },
    });
  },

  stopPropagation() {},

  openPhotoSource() {
    if (this.data.editorMediaStatus === 'processing') {
      if (this.data.editorProcessingCheckinId) {
        wx.showModal({
          title: '更换这张图片？',
          content: '当前贴纸仍在生成，更换后将停止这次处理。',
          confirmText: '更换图片',
          success: ({ confirm }) => {
            if (confirm) {
              prewarmMediaUpload(this.data.moduleId);
              this.setData({ photoSourceOpen: true, photoSourceClosing: false });
            }
          },
        });
      }
      return;
    }
    prewarmMediaUpload(this.data.moduleId);
    this.setData({ photoSourceOpen: true, photoSourceClosing: false });
    track('photo_source_sheet_view', { entryAction: this.data.editorOriginalPath ? 'replace' : 'add' });
  },

  async dismissPhotoSource() {
    if (!this.data.photoSourceOpen || this.data.photoSourceClosing) return;
    this.setData({ photoSourceClosing: true });
    await waitForSheetMotion();
    if (!this.data.photoSourceClosing) return;
    this.setData({ photoSourceOpen: false, photoSourceClosing: false });
  },

  closePhotoSource() {
    void this.dismissPhotoSource();
  },

  async choosePhoto(event: WechatMiniprogram.TouchEvent) {
    const pickerSourceType = event.currentTarget.dataset.source as 'camera' | 'album';
    const sourceType = pickerSourceType === 'album' ? 'gallery' : 'camera';
    await this.dismissPhotoSource();
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['original'],
      sourceType: [pickerSourceType],
      success: ({ tempFiles }) => {
        const file = tempFiles[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
          wx.showToast({ title: '请选择小于20MB的照片', icon: 'none' });
          return;
        }
        void this.persistAndProcessPhoto(file.tempFilePath, sourceType);
      },
    });
    track('photo_source_select', { sourceType });
  },

  async persistAndProcessPhoto(tempPath: string, sourceType?: 'camera' | 'gallery') {
    const previousCheckinId = this.data.editorProcessingCheckinId;
    invalidateEditorMediaTask();
    const token = editorMediaTaskToken;
    clearEditorStickerTimers();
    this.setData({
      editorOriginalPath: tempPath,
      editorStickerPath: '',
      editorMediaVariant: 'sticker',
      editorStickerFallbackPath: '',
      editorStickerRefreshAttempts: 0,
      editorStickerPhase: 'sticker-hidden',
      editorMediaId: '',
      editorMediaStatus: 'processing',
      editorMediaProgress: 0,
      editorMediaDetail: '正在准备图片',
      editorMediaErrorTitle: '图片处理失败',
      editorMediaError: '',
      editorMediaRetryable: false,
      editorProcessingCheckinId: '',
      editorSourceType: sourceType ?? this.data.editorSourceType,
      editorDirty: true,
    });
    let processingStarted = false;
    try {
      if (previousCheckinId) await cancelProcessingCheckin(previousCheckinId);
      const media = await processMedia(
        tempPath,
        this.data.moduleId,
        (progress) => {
          if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
          this.setData({
            editorMediaProgress: progress,
            editorMediaDetail: progress < 100 ? `正在上传图片 ${progress}%` : '正在生成贴纸',
          });
        },
        () => {
          if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
          processingStarted = true;
          this.setData({ editorMediaProgress: 100, editorMediaDetail: '正在审核并生成贴纸' });
        },
        sourceType ?? this.data.editorSourceType,
      );
      if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
      this.setData({
        editorOriginalPath: media.originalPath,
        editorMediaId: media.mediaId,
        editorStickerPath: media.stickerPath,
        editorStickerFallbackPath: media.stickerFallbackPath ?? '',
        editorStickerRefreshAttempts: 0,
        editorStickerPhase: 'sticker-hidden',
        editorMediaStatus: 'ready',
        editorMediaProgress: 100,
        editorMediaDetail: '',
        editorMediaError: '',
      });
    } catch (error) {
      if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
      console.error('[checkin-media] processing failed', error);
      this.setData({
        editorMediaStatus: 'failed',
        editorMediaDetail: '',
        editorMediaErrorTitle: mediaErrorTitle(error, processingStarted),
        editorMediaError: mediaErrorCopy(error),
        editorMediaRetryable: true,
      });
    }
  },

  playEditorStickerAnimation() {
    clearEditorStickerTimers();
    editorStickerTimers.push(setTimeout(
      () => this.setData({ editorStickerPhase: 'sticker-entering' }),
      STICKER_MOTION.pageSettledDelay,
    ));
    editorStickerTimers.push(setTimeout(
      () => this.setData({ editorStickerPhase: 'sticker-visible' }),
      STICKER_MOTION.pageSettledDelay + STICKER_MOTION.duration,
    ));
  },

  onEditorStickerLoad() {
    if (this.data.editorMediaStatus !== 'ready' || this.data.editorMediaVariant !== 'sticker') return;
    this.playEditorStickerAnimation();
  },

  async onEditorStickerLoadError(event: WechatMiniprogram.ImageError) {
    if (this.data.editorMediaStatus !== 'ready' || this.data.editorMediaVariant !== 'sticker') return;
    console.warn('[checkin-media] sticker image load failed', event.detail);
    const fallbackPath = this.data.editorStickerFallbackPath;
    if (fallbackPath && fallbackPath !== this.data.editorStickerPath) {
      this.setData({
        editorStickerPath: fallbackPath,
        editorStickerFallbackPath: '',
        editorStickerPhase: 'sticker-hidden',
      });
      return;
    }
    if (this.data.editorMediaId && this.data.editorStickerRefreshAttempts < 1) {
      const token = editorMediaTaskToken;
      this.setData({
        editorMediaStatus: 'processing',
        editorMediaDetail: '正在重新加载贴纸',
        editorStickerRefreshAttempts: this.data.editorStickerRefreshAttempts + 1,
      });
      try {
        const sources = await refreshMediaStickerSources(this.data.editorMediaId);
        if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
        this.setData({
          editorStickerPath: sources.stickerPath,
          editorStickerFallbackPath: sources.stickerFallbackPath ?? '',
          editorStickerPhase: 'sticker-hidden',
          editorMediaStatus: 'ready',
          editorMediaDetail: '',
        });
        return;
      } catch (error) {
        console.error('[checkin-media] sticker URL refresh failed', error);
      }
    }
    this.setData({
      editorMediaStatus: 'failed',
      editorMediaErrorTitle: '贴纸加载失败',
      editorMediaError: '贴纸已经生成，但图片加载失败，请检查网络后重试',
      editorMediaRetryable: true,
    });
  },

  toggleEditorMediaVariant() {
    if (this.data.editorMediaStatus !== 'ready') return;
    const nextVariant = this.data.editorMediaVariant === 'sticker' ? 'original' : 'sticker';
    if (nextVariant === 'original' && !this.data.editorOriginalPath) {
      wx.showToast({ title: '原图暂时无法加载', icon: 'none' });
      return;
    }
    this.setData({
      editorMediaVariant: nextVariant,
      editorDirty: true,
      editorStickerPhase: nextVariant === 'sticker' ? 'sticker-hidden' : this.data.editorStickerPhase,
    }, () => {
      if (nextVariant === 'sticker') this.playEditorStickerAnimation();
    });
    track('record_media_variant_toggle', { mediaVariant: nextVariant });
  },

  saveLocalFile(tempPath: string): Promise<string> {
    return new Promise((resolve) => {
      wx.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: ({ savedFilePath }) => resolve(savedFilePath),
        fail: () => resolve(tempPath),
      });
    });
  },

  async retryMedia() {
    if (this.data.editorProcessingCheckinId && this.data.editorMediaRetryable) {
      const token = ++editorMediaTaskToken;
      this.setData({
        editorMediaStatus: 'processing',
        editorMediaDetail: '正在重新生成贴纸',
        editorMediaErrorTitle: '贴纸生成失败',
        editorMediaError: '',
        editorMediaRetryable: false,
      });
      try {
        await retryCheckinMatting(this.data.editorProcessingCheckinId);
        await this.pollProcessingCheckin(this.data.editorProcessingCheckinId, token);
      } catch (error) {
        if (token !== editorMediaTaskToken) return;
        console.error('[checkin-media] retry failed', error);
        this.setData({ editorMediaStatus: 'failed', editorMediaErrorTitle: '贴纸生成失败', editorMediaError: '暂时无法重新生成，请更换图片', editorMediaRetryable: false });
      }
      return;
    }
    if (this.data.editorOriginalPath) await this.persistAndProcessPhoto(this.data.editorOriginalPath);
  },

  async pollProcessingCheckin(checkinId: string, token: number) {
    clearEditorProcessingTimer();
    if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
    try {
      const status = await getCheckinProcessingStatus(checkinId);
      if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
      if (status.displayStatus === 'ready' && status.stickerUrl) {
        this.setData({
          editorMediaId: status.mediaId,
          editorOriginalPath: status.originalUrl ?? this.data.editorOriginalPath,
          editorStickerPath: status.stickerUrl,
          editorStickerFallbackPath: '',
          editorStickerRefreshAttempts: 0,
          editorStickerPhase: 'sticker-hidden',
          editorMediaStatus: 'ready',
          editorMediaProgress: 100,
          editorMediaDetail: '',
          editorMediaError: '',
        });
        return;
      }
      if (status.displayStatus === 'rejected' || status.displayStatus === 'failed') {
        this.setData({
          editorMediaStatus: 'failed',
          editorMediaDetail: '',
          editorMediaErrorTitle: status.displayStatus === 'rejected' ? '图片未通过审核' : '贴纸生成失败',
          editorMediaError: status.message ?? (status.displayStatus === 'rejected' ? '图片未通过审核，请更换图片' : '贴纸生成失败'),
          editorMediaRetryable: status.retryable,
        });
        return;
      }
      this.setData({
        editorMediaStatus: 'processing',
        editorMediaDetail: processingStageCopy[status.stage] ?? waitingCopy(status.elapsedMs),
      });
      editorProcessingTimer = setTimeout(
        () => void this.pollProcessingCheckin(checkinId, token),
        pollIntervalForElapsed(status.elapsedMs),
      );
    } catch (error) {
      if (token !== editorMediaTaskToken || !this.data.editorOpen) return;
      console.error('[checkin-media] status query failed', error);
      this.setData({ editorMediaDetail: '状态查询暂时失败，正在自动重试' });
      editorProcessingTimer = setTimeout(() => void this.pollProcessingCheckin(checkinId, token), 5_000);
    }
  },

  onRemarkInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ editorRemark: event.detail.value, editorDirty: true });
  },

  async submitRecord() {
    if (this.data.editorMediaStatus !== 'ready' || this.data.saving) return;
    const previousRecordId = this.data.editorRecordId || undefined;
    const editorDate = this.data.editorDate;
    this.setData({ saving: true });
    try {
      if (this.data.editorProcessingCheckinId) {
        const savedRecord = await saveRecord({
          moduleId: this.data.moduleId,
          recordId: this.data.editorProcessingCheckinId,
          recordDate: editorDate,
          originalPath: this.data.editorOriginalPath,
          stickerPath: this.data.editorStickerPath,
          remark: this.data.editorRemark,
          clientRequestId: createId('request'),
          mediaId: this.data.editorMediaId,
          mediaVariant: this.data.editorMediaVariant,
        });
        this.setData({ saving: false });
        await this.dismissEditor();
        invalidateModuleGallery(this.data.moduleId, editorDate.slice(0, 7));
        const homePreviewReady = savedRecord.recordDate === this.data.today
          ? queueHomePreviewUpdate({
            type: 'upsert',
            moduleId: savedRecord.moduleId,
            recordId: savedRecord.recordId,
            memberInstanceId: savedRecord.memberInstanceId,
            stickerPath: savedRecord.stickerPath,
          })
          : Promise.resolve();
        await this.applyCalendarSnapshot(this.calendarSnapshotWithRecord(savedRecord), homePreviewReady);
        wx.showToast({ title: '记录已保存' });
        await this.maybeShowStreakReward();
        return;
      }
      const makeupResult = this.data.editorMode === 'makeup'
        ? await submitMakeupRecord({
            moduleId: this.data.moduleId,
            recordDate: this.data.editorDate,
            originalPath: this.data.editorOriginalPath,
            stickerPath: this.data.editorStickerPath,
            remark: this.data.editorRemark,
            clientRequestId: createId('request'),
            mediaId: this.data.editorMediaId,
            mediaVariant: this.data.editorMediaVariant,
          })
        : null;
      const savedRecord = makeupResult ? null : await saveRecord({
          moduleId: this.data.moduleId,
          recordId: previousRecordId,
          recordDate: editorDate,
          originalPath: this.data.editorOriginalPath,
          stickerPath: this.data.editorStickerPath,
          remark: this.data.editorRemark,
          clientRequestId: createId('request'),
          mediaId: this.data.editorMediaId,
          mediaVariant: this.data.editorMediaVariant,
        });
      let homePreviewReady = Promise.resolve();
      if (savedRecord && savedRecord.recordDate === this.data.today) {
        homePreviewReady = queueHomePreviewUpdate({
          type: 'upsert',
          moduleId: savedRecord.moduleId,
          recordId: savedRecord.recordId,
          memberInstanceId: savedRecord.memberInstanceId,
          previousRecordId,
          stickerPath: savedRecord.stickerPath,
        });
      }
      this.setData({ saving: false });
      await this.dismissEditor();
      invalidateModuleGallery(this.data.moduleId, editorDate.slice(0, 7));
      if (savedRecord) {
        await this.applyCalendarSnapshot(this.calendarSnapshotWithRecord(savedRecord), homePreviewReady);
      } else {
        const snapshot = await getCalendar(this.data.moduleId, this.data.month);
        await this.applyCalendarSnapshot(snapshot);
      }
      wx.vibrateShort?.({ type: 'light' });
      wx.showToast({
        title: makeupResult
          ? (makeupResult.approval ? '补卡申请已提交' : '补卡已生效')
          : (this.data.editorMode === 'edit' ? '记录已更新' : '记录已保存'),
      });
      if (savedRecord && !previousRecordId && savedRecord.recordDate === this.data.today) {
        await this.maybeShowStreakReward();
      }
    } catch (error) {
      console.error('[record-save] failed', error);
      if (!previousRecordId && error instanceof Error && error.message === 'RECORD_ALREADY_EXISTS') {
        const recovered = currentUserRecord(await getDateRecords(this.data.moduleId, editorDate).catch(() => []));
        if (recovered) {
          this.setData({ saving: false });
          await this.dismissEditor();
          invalidateModuleGallery(this.data.moduleId, editorDate.slice(0, 7));
          await this.applyCalendarSnapshot(this.calendarSnapshotWithRecord(recovered));
          wx.showToast({ title: '记录已保存' });
          return;
        }
      }
      this.setData({ saving: false });
      wx.showToast({ title: error instanceof Error && error.message === 'RECORD_DATE_LOCKED' ? '日期已跨天，请刷新' : '保存失败，请重试', icon: 'none' });
    }
  },

  toggleReactionPicker(event: WechatMiniprogram.TouchEvent) {
    const recordId = event.currentTarget.dataset.record as string;
    this.setData({ reactionPickerRecordId: this.data.reactionPickerRecordId === recordId ? '' : recordId });
  },

  async chooseReaction(event: WechatMiniprogram.TouchEvent) {
    const recordId = event.currentTarget.dataset.record as string;
    const emojiCode = event.currentTarget.dataset.emoji as ReactionEmoji;
    try {
      await setRecordReaction(recordId, emojiCode);
      const reactions = await getRecordReactions(recordId);
      this.setData({
        dateRecords: this.data.dateRecords.map((record) => record.recordId === recordId ? { ...record, reactions } : record),
        reactionPickerRecordId: '',
      });
      track('record_reaction_change', { recordId, emojiCode });
    } catch {
      wx.showToast({ title: '暂时无法回应', icon: 'none' });
    }
  },

  deleteTodayRecord() {
    if (!this.data.editorRecordId) return;
    const recordId = this.data.editorRecordId;
    const moduleId = this.data.moduleId;
    const editorMonth = this.data.editorDate.slice(0, 7);
    wx.showModal({
      title: '删除这条记录？',
      content: '贴纸会从首页和日历移除，之后仍可重新记录。',
      confirmText: '删除',
      confirmColor: '#F65451',
      success: async ({ confirm }) => {
        if (!confirm) return;
        await deleteRecord(recordId);
        if (this.data.editorDate === this.data.today) {
          void queueHomePreviewUpdate({ type: 'remove', moduleId, recordId });
        }
        await this.dismissEditor();
        invalidateModuleGallery(moduleId, editorMonth);
        await this.applyCalendarSnapshot(this.calendarSnapshotWithoutRecord(recordId));
        wx.showToast({ title: '已删除' });
      },
    });
  },

  openMembers() {
    void wx.navigateTo({ url: `/subpackages/member-management/index?moduleId=${this.data.moduleId}` });
  },

  openSettings() {
    void wx.navigateTo({ url: `/subpackages/module-settings/index?moduleId=${this.data.moduleId}` });
  },

  openTodo() {
    void wx.navigateTo({ url: `/subpackages/module-todo/index?moduleId=${this.data.moduleId}` });
  },

  async openRewardSettings() {
    const module = this.data.module;
    if (!module || module.recordPolicy !== 'strict') return;
    const rewardTargetOptions: RewardTargetOption[] = [
      { label: '全员', targetType: 'all' },
      ...module.members.filter((member) => member.active).map((member) => ({
        label: member.userId === this.data.currentUser?.userId ? '我' : member.nickname,
        targetType: 'member' as const,
        memberInstanceId: member.memberInstanceId,
      })),
    ];
    this.setData({
      rewardSettingsOpen: true,
      rewardSettingsClosing: false,
      rewardSettingsMode: 'form',
      rewardRuleListClosing: false,
      rewardTargetOptions,
      rewardTargetIndex: 0,
      rewardStreakDays: '7',
      rewardPrizeTitle: '',
      rewardPrizeDescription: '',
      rewardCoverMediaId: '',
      rewardCoverPath: '/subpackages/reward-assets/default-cover.png',
      rewardCoverStatus: 'idle',
      rewardCoverProgress: 0,
      rewardProbability: 80,
      rewardAgreement: false,
    });
    try {
      this.applyRewardRuleView(await getMyStreakRewardRule(this.data.moduleId));
    } catch (error) {
      console.error('[streak-reward] rule list failed', error);
      wx.showToast({ title: '彩蛋列表加载失败', icon: 'none' });
    }
    track('streak_reward_settings_view', { moduleId: this.data.moduleId });
  },

  applyRewardRuleView(rewardView: StreakRewardRuleView) {
    const statusLabels: Record<string, string> = {
      active: '等待触发',
      triggered: '已触发',
      cancelled: '已取消',
      expired: '已过期',
    };
    this.setData({
      rewardView,
      rewardRules: rewardView.rules.map(({ rule, progressDays, targetMemberName }) => ({
        rewardRuleId: rule.rewardRuleId,
        targetLabel: rule.targetType === 'all' ? '全员' : (targetMemberName ?? '指定成员'),
        conditionLabel: `连续打卡 ${rule.streakDays} 天`,
        prizeTitle: rule.prizeTitle,
        winProbability: rule.winProbability,
        progressLabel: rule.status === 'active' ? `当前 ${progressDays} / ${rule.streakDays} 天` : '',
        status: rule.status,
        statusLabel: statusLabels[rule.status] ?? rule.status,
      })),
    });
  },

  async dismissRewardSettings() {
    if (!this.data.rewardSettingsOpen || this.data.rewardSettingsClosing) return;
    this.setData({
      rewardSettingsClosing: true,
      rewardRuleListClosing: this.data.rewardSettingsMode === 'list',
    });
    await waitForSheetMotion();
    if (!this.data.rewardSettingsClosing) return;
    const unusedCoverMediaId = this.data.rewardCoverMediaId;
    this.setData({
      rewardSettingsOpen: false,
      rewardSettingsClosing: false,
      rewardSettingsMode: 'form',
      rewardRuleListClosing: false,
      rewardTargetIndex: 0,
      rewardStreakDays: '7',
      rewardPrizeTitle: '',
      rewardPrizeDescription: '',
      rewardCoverMediaId: '',
      rewardCoverPath: '/subpackages/reward-assets/default-cover.png',
      rewardCoverStatus: 'idle',
      rewardCoverProgress: 0,
      rewardProbability: 80,
      rewardAgreement: false,
      rewardSaving: false,
    });
    if (unusedCoverMediaId) void discardMedia(unusedCoverMediaId).catch(() => undefined);
  },

  closeRewardSettings() {
    if (!this.data.rewardSaving && !this.data.rewardCancellingId && !this.data.rewardPreviewingId) {
      void this.dismissRewardSettings().then(() => this.maybeShowStreakReward());
    }
  },

  showRewardRuleList() {
    if (this.data.rewardSettingsClosing || this.data.rewardRuleListClosing || this.data.rewardSettingsMode === 'list') return;
    this.setData({ rewardSettingsMode: 'list', rewardRuleListClosing: false });
  },

  async dismissRewardRuleList() {
    if (this.data.rewardSettingsMode !== 'list' || this.data.rewardRuleListClosing) return;
    this.setData({ rewardRuleListClosing: true });
    await waitForSheetMotion();
    if (!this.data.rewardRuleListClosing || this.data.rewardSettingsClosing) return;
    this.setData({ rewardSettingsMode: 'form', rewardRuleListClosing: false });
  },

  showRewardRuleForm() {
    void this.dismissRewardRuleList();
  },
  onRewardTarget(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ rewardTargetIndex: Number(event.detail.value) || 0 });
  },
  onRewardStreakDays(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ rewardStreakDays: event.detail.value.replace(/\D/g, '').slice(0, 3) });
  },
  onRewardPrizeTitle(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ rewardPrizeTitle: event.detail.value });
  },
  onRewardPrizeDescription(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ rewardPrizeDescription: event.detail.value });
  },
  chooseRewardCover() {
    if (this.data.rewardCoverStatus === 'processing') return;
    const previousCoverMediaId = this.data.rewardCoverMediaId;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: ({ tempFiles }) => {
        const path = tempFiles[0]?.tempFilePath;
        if (!path) return;
        if (previousCoverMediaId) void discardMedia(previousCoverMediaId).catch(() => undefined);
        this.setData({ rewardCoverStatus: 'processing', rewardCoverProgress: 0, rewardCoverPath: path });
        void processMedia(
          path,
          this.data.moduleId,
          (rewardCoverProgress) => this.setData({ rewardCoverProgress }),
          () => this.setData({ rewardCoverProgress: 100 }),
          'gallery',
        ).then((media) => {
          this.setData({
            rewardCoverMediaId: media.mediaId,
            rewardCoverPath: media.stickerPath,
            rewardCoverStatus: 'ready',
            rewardCoverProgress: 100,
          });
        }).catch((error) => {
          console.error('[streak-reward] cover processing failed', error);
          this.setData({
            rewardCoverMediaId: '',
            rewardCoverPath: '/subpackages/reward-assets/default-cover.png',
            rewardCoverStatus: 'failed',
          });
          wx.showToast({ title: mediaErrorCopy(error), icon: 'none' });
        });
      },
    });
  },
  resetRewardCover() {
    if (this.data.rewardCoverStatus === 'processing') return;
    const unusedCoverMediaId = this.data.rewardCoverMediaId;
    this.setData({
      rewardCoverMediaId: '',
      rewardCoverPath: '/subpackages/reward-assets/default-cover.png',
      rewardCoverStatus: 'idle',
      rewardCoverProgress: 0,
    });
    if (unusedCoverMediaId) void discardMedia(unusedCoverMediaId).catch(() => undefined);
  },
  openRewardCollection() {
    void wx.navigateTo({ url: `/subpackages/reward-collection/index?moduleId=${this.data.moduleId}` });
  },
  chooseRewardProbability(event: WechatMiniprogram.TouchEvent) {
    const value = Number(event.currentTarget.dataset.probability);
    if (value === 20 || value === 50 || value === 80 || value === 100) this.setData({ rewardProbability: value });
  },
  onRewardAgreement(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    this.setData({ rewardAgreement: event.detail.value.includes('accepted') });
  },

  async saveRewardRule() {
    if (this.data.rewardSaving) return;
    const target = this.data.rewardTargetOptions[this.data.rewardTargetIndex];
    const streakDays = Number(this.data.rewardStreakDays);
    const prizeTitle = this.data.rewardPrizeTitle.trim();
    const prizeDescription = this.data.rewardPrizeDescription.trim();
    if (!target) {
      wx.showToast({ title: '请选择达成人员', icon: 'none' });
      return;
    }
    if (!Number.isInteger(streakDays) || streakDays < 1 || streakDays > 100) {
      wx.showToast({ title: '连续天数请输入1至100', icon: 'none' });
      return;
    }
    if (!prizeTitle || prizeTitle.length > 20 || prizeDescription.length > 80) {
      wx.showToast({ title: '请填写20字内礼物名和80字内说明', icon: 'none' });
      return;
    }
    if (!this.data.rewardAgreement) {
      wx.showToast({ title: '请先确认线下兑现说明', icon: 'none' });
      return;
    }
    if (this.data.rewardCoverStatus === 'processing') {
      wx.showToast({ title: '请等待奖励封面处理完成', icon: 'none' });
      return;
    }
    this.setData({ rewardSaving: true });
    try {
      const rewardView = await saveStreakRewardRule(this.data.moduleId, {
        targetType: target.targetType,
        targetMemberInstanceId: target.memberInstanceId,
        streakDays,
        prizeTitle,
        prizeDescription,
        coverMediaId: this.data.rewardCoverMediaId || undefined,
        coverPath: this.data.rewardCoverMediaId ? this.data.rewardCoverPath : undefined,
        winProbability: this.data.rewardProbability,
        termsAccepted: true,
      });
      this.applyRewardRuleView(rewardView);
      this.setData({
        rewardSaving: false,
        rewardCoverMediaId: '',
      });
      await this.dismissRewardSettings();
      wx.showToast({ title: '奖励彩蛋已藏好' });
    } catch (error) {
      console.error('[streak-reward] save failed', error);
      this.setData({ rewardSaving: false });
      wx.showToast({ title: '奖励设置保存失败', icon: 'none' });
    }
  },

  async cancelRewardRule(event: WechatMiniprogram.TouchEvent) {
    const rewardRuleId = String(event.currentTarget.dataset.ruleId ?? '');
    if (!rewardRuleId || this.data.rewardCancellingId) return;
    const result = await wx.showModal({
      title: '取消这份彩蛋？',
      content: '取消后不会再触发，已经发出的奖励不受影响。',
      confirmText: '确认取消',
      confirmColor: '#b85f58',
    });
    if (!result.confirm) return;
    this.setData({ rewardCancellingId: rewardRuleId });
    try {
      await cancelStreakRewardRule(this.data.moduleId, rewardRuleId);
      this.applyRewardRuleView(await getMyStreakRewardRule(this.data.moduleId));
      this.setData({ rewardCancellingId: '' });
      wx.showToast({ title: '彩蛋已取消' });
    } catch {
      this.setData({ rewardCancellingId: '' });
      wx.showToast({ title: '取消失败，请稍后重试', icon: 'none' });
    }
  },

  async previewRewardRule(event: WechatMiniprogram.TouchEvent) {
    const rewardRuleId = String(event.currentTarget.dataset.ruleId ?? '');
    if (!rewardRuleId || this.data.rewardPreviewingId) return;
    this.setData({ rewardPreviewingId: rewardRuleId });
    try {
      const preview = await previewStreakReward(this.data.moduleId, rewardRuleId);
      if (preview.revealed.stickerPath) await preloadImageSources([preview.revealed.stickerPath]);
      await this.dismissRewardSettings();
      this.setData({
        rewardPreviewingId: '',
        rewardOpen: true,
        rewardOpening: false,
        rewardCardFlipped: false,
        rewardMotionPhase: 'entering',
        pendingReward: preview.pending,
        pendingRewards: [preview.pending],
        rewardPendingIndex: 0,
        rewardPendingCount: 1,
        rewardBatchResults: [],
        revealedReward: null,
        rewardPreviewResult: preview.revealed,
        rewardDateRange: `${preview.pending.windowStart.replace(/-/g, '.')} — ${preview.pending.windowEnd.replace(/-/g, '.')}`,
      }, () => this.startRewardEntryMotion());
    } catch (error) {
      console.error('[streak-reward] preview failed', error);
      this.setData({ rewardPreviewingId: '' });
      wx.showToast({ title: '奖励预览加载失败', icon: 'none' });
    }
  },

  openGallery() {
    prefetchModuleGallery(this.data.moduleId, this.data.month);
    void wx.navigateTo({ url: `/subpackages/module-gallery/index?moduleId=${this.data.moduleId}&month=${this.data.month}` });
  },

  openMemory() {
    wx.setStorageSync('notemylife.memory.selection', { moduleId: this.data.moduleId, month: this.data.month });
    void wx.switchTab({ url: '/pages/memory/index' });
  },
});

function mediaErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'MEDIA_COMPRESSED_TOO_LARGE') return '图片压缩后仍然过大，请更换图片';
  if (code === 'MEDIA_FORMAT_NOT_SUPPORTED') return '暂不支持这种图片格式';
  if (code === 'CONTENT_REJECTED' || code === 'MEDIA_CONTENT_REJECTED' || code === 'IMAGE_CONTENT_REJECTED') {
    return '图片未通过审核，请更换图片';
  }
  if (code === 'MEDIA_CONTENT_CHECK_FAILED') return '图片安全检查服务暂时不可用，请重试';
  if (code === 'CUTOUT_PROCESS_FAILED' || code === 'MEDIA_PROCESSING_FAILED') return '贴纸生成失败，请重新生成';
  return '图片处理失败，请重试';
}

function mediaErrorTitle(error: unknown, processingStarted: boolean): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'MEDIA_FORMAT_NOT_SUPPORTED') return '图片格式不支持';
  if (code === 'MEDIA_COMPRESSED_TOO_LARGE') return '图片处理失败';
  if (code === 'CONTENT_REJECTED' || code === 'MEDIA_CONTENT_REJECTED' || code === 'IMAGE_CONTENT_REJECTED') {
    return '图片未通过审核';
  }
  if (code === 'MEDIA_CONTENT_CHECK_FAILED') return '图片审核失败';
  return processingStarted ? '贴纸生成失败' : '图片上传失败';
}
