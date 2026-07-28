import type { CalendarCell, LifeModule, LifeRecord, MediaStatus, ReactionEmoji, User } from '../../types/domain';
import {
  cancelProcessingCheckin,
  currentUserRecord,
  createModuleInvite,
  deleteRecord,
  discardPrewarmedMediaUpload,
  getCalendar,
  getCheckinProcessingStatus,
  getCurrentUser,
  getCurrentMakeupApproval,
  getDateRecords,
  getModuleInbox,
  getModuleInboxCount,
  getModuleMonthSummary,
  getModule,
  refreshModule,
  getReactionOptions,
  getRecordReactions,
  processMedia,
  prewarmMediaUpload,
  refreshMediaStickerSources,
  retryCheckinMatting,
  saveRecord,
  setRecordReaction,
  submitMakeupRecord,
  type ReactionView,
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
import { preloadImageSources } from '../../utils/image-preload';
import { mergeMemberSnapshot } from '../../utils/member-sync';
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
const moduleDetailCache = new Map<string, ModuleDetailCacheEntry>();

const moduleDetailCacheKey = (moduleId: string, month: string) => `${moduleId}:${month}`;

const MEMBER_CALENDAR_MOTION_DURATION = 260;
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
  },

  onLoad(query: Record<string, string | undefined>) {
    if (!query.moduleId) {
      wx.showToast({ title: '模块不存在', icon: 'none' });
      void wx.navigateBack();
      return;
    }
    this.setData({
      moduleId: query.moduleId,
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
    });
    const cached = moduleDetailCache.get(moduleDetailCacheKey(query.moduleId, this.data.month));
    const initialLoad = cached
      ? this.loadAll(false, true, cached)
      : this.loadAll(true, true);
    void initialLoad.then(() => {
      if (query.date && this.data.module) void this.openDateValue(query.date);
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
    invalidateEditorMediaTask();
    if (memberCalendarMotionTimer) clearTimeout(memberCalendarMotionTimer);
    memberCalendarMotionTimer = undefined;
    discardPrewarmedMediaUpload(this.data.moduleId);
    if (mediaProgressTimer) clearInterval(mediaProgressTimer);
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
    await Promise.all([
      preloadImageSources([...plan.animatedStickerSources, ...memberPlan.avatarSources]),
      beforeApply,
    ]);
    if (generation !== calendarSyncGeneration || module.moduleId !== this.data.moduleId) return false;
    moduleDetailCache.set(moduleDetailCacheKey(module.moduleId, this.data.month), {
      module: syncedModule,
      currentUser,
      calendar: normalizedSnapshot,
    });
    if (!plan.changedCellIndexes.length && !memberPlan.changed) return false;
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
    patch.monthRecordCount = monthCells.filter((cell) => cell.records.some((record) => record.userId === currentUser.userId)).length;
    patch.jointCompletedDays = monthCells.filter((cell) => syncedModule.members.length > 0
      && syncedModule.members.every((member) => cell.records.some((record) => record.memberInstanceId === member.memberInstanceId))).length;
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
    void this.changeMonth(previousMonth(this.data.month), 'previous');
  },

  nextMonth() {
    void this.changeMonth(nextMonth(this.data.month), 'next');
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

      const [calendar] = await Promise.all([calendarPromise, exitMotion]);
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
    const records = await getDateRecords(this.data.moduleId, recordDate);
    const pendingMakeup = await getCurrentMakeupApproval(this.data.moduleId, recordDate);
    const reactions = await Promise.all(records.map((record) => getRecordReactions(record.recordId)));
    const module = this.data.module;
    const user = this.data.currentUser;
    if (!module || !user) return;
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
    if (offset === 0) {
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
    void this.dismissDateSheet();
  },

  async onDatePrimaryAction() {
    const record = this.data.dateRecords.find((item) => item.isMine);
    await this.dismissDateSheet();
    this.openEditor(record, this.data.dateAction === 'makeup' ? this.data.selectedDate : this.data.today);
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

  openEditor(record?: LifeRecord, recordDate?: string) {
    const targetDate = recordDate ?? this.data.today;
    const isEdit = Boolean(record);
    const isMakeup = targetDate !== this.data.today;
    invalidateEditorMediaTask();
    clearEditorStickerTimers();
    this.setData({
      editorOpen: true,
      editorClosing: false,
      editorMode: isMakeup ? 'makeup' : (isEdit ? 'edit' : 'create'),
      editorTitle: isMakeup ? '申请补卡' : (isEdit ? '编辑今天' : '记录今天'),
      editorRecordId: record?.recordId ?? '',
      editorDate: targetDate,
      editorOriginalPath: record?.originalPath ?? '',
      editorMediaId: record?.mediaId ?? '',
      editorStickerPath: record?.stickerPath ?? '',
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
    if (this.data.editorMediaStatus !== 'ready') return;
    this.playEditorStickerAnimation();
  },

  async onEditorStickerLoadError(event: WechatMiniprogram.ImageError) {
    if (this.data.editorMediaStatus !== 'ready') return;
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
        this.setData({ saving: false });
        await this.dismissEditor();
        invalidateModuleGallery(this.data.moduleId, editorDate.slice(0, 7));
        const snapshot = await getCalendar(this.data.moduleId, this.data.month);
        await this.applyCalendarSnapshot(snapshot);
        const record = snapshot.find((cell) => cell.date === this.data.today)?.records
          .find((item) => item.userId === this.data.currentUser?.userId);
        if (record && record.recordDate === this.data.today) {
          void queueHomePreviewUpdate({
            type: 'upsert',
            moduleId: record.moduleId,
            recordId: record.recordId,
            memberInstanceId: record.memberInstanceId,
            stickerPath: record.stickerPath,
          });
        }
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
          : (this.data.editorMode === 'edit' ? '今天已更新' : '今天已记录'),
      });
    } catch (error) {
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
      title: '删除今天的记录？',
      content: '贴纸会从首页和日历移除，之后仍可重新记录。',
      confirmText: '删除',
      confirmColor: '#F65451',
      success: async ({ confirm }) => {
        if (!confirm) return;
        await deleteRecord(recordId);
        void queueHomePreviewUpdate({ type: 'remove', moduleId, recordId });
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
