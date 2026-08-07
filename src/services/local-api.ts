import type {
  AppDatabase,
  AppNotification,
  CalendarCell,
  CalendarRecordView,
  CheckinProcessingStatus,
  CheckinUploadInput,
  CheckinUploadResult,
  DailyModuleSnapshot,
  HomeModuleView,
  InviteToken,
  JoinApplication,
  LifeModule,
  LifeRecord,
  MakeupApproval,
  MediaResult,
  MediaStickerSources,
  ModuleInboxItem,
  ModuleMember,
  ModuleTemplate,
  MonthlyMemoryCard,
  Reaction,
  ReactionEmoji,
  PreparedMediaFile,
  ReminderSubscription,
  ReminderSubscriptionStatus,
  StreakRewardDraw,
  StreakRewardRule,
  StreakRewardTargetType,
  User,
} from '../types/domain';
import { addDays, buildMonthGrid, differenceInDays, shanghaiDate, shanghaiNowIso } from '../utils/date';
import { createId } from '../utils/id';
import { canCreateNormalRecord, canMutateRecord, canSubmitMakeup } from '../utils/record-policy';
import { readDatabase, STICKER_PATHS, updateDatabase } from './database';
import { setTrackingConsent, track } from './tracker';

const delay = (milliseconds = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isFormalRecord = (record: LifeRecord): boolean => record.status === 'active' || record.status === 'locked';
const localCheckinStatuses = new Map<string, CheckinProcessingStatus>();

export const MODULE_NAME_MAX_LENGTH = 10;
export const MODULE_DESCRIPTION_MAX_LENGTH = 200;

function activeMembers(module: LifeModule): ModuleMember[] {
  return module.members.filter((item) => item.active).sort((left, right) => left.joinSequence - right.joinSequence);
}

function notifyRemainingMembersOfDeparture(
  database: AppDatabase,
  module: LifeModule,
  departedMember: ModuleMember,
  now: string,
): void {
  const content = `「${departedMember.nickname}」已退出「${module.name}」`;
  activeMembers(module).forEach((member) => {
    database.moduleInboxItems.push({
      itemId: createId('inbox'),
      moduleId: module.moduleId,
      recipientUserId: member.userId,
      type: 'member_change',
      title: '成员退出',
      content,
      targetType: 'member',
      targetId: departedMember.memberInstanceId,
      status: 'unread',
      createdAt: now,
      updatedAt: now,
      expireAt: shanghaiNowIso(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    });
    database.notifications.push({
      notificationId: createId('notification'),
      userId: member.userId,
      type: 'member_change',
      title: '成员退出',
      content,
      moduleId: module.moduleId,
      targetType: 'member',
      targetId: departedMember.memberInstanceId,
      actionType: 'none',
      actionStatus: 'none',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function deleteTodayRecordsForMember(database: AppDatabase, moduleId: string, memberInstanceId: string): void {
  const today = shanghaiDate();
  const recordIds = new Set(database.records
    .filter((record) => record.moduleId === moduleId
      && record.memberInstanceId === memberInstanceId
      && record.recordDate === today)
    .map((record) => record.recordId));
  if (!recordIds.size) return;
  database.records = database.records.filter((record) => !recordIds.has(record.recordId));
  database.reactions = database.reactions.filter((reaction) => !recordIds.has(reaction.recordId));
  recordIds.forEach((recordId) => localCheckinStatuses.delete(recordId));
}

function purgeExitedMemberTodayRecords(database: AppDatabase): void {
  database.modules.forEach((module) => {
    const activeMemberIds = new Set(activeMembers(module).map((member) => member.memberInstanceId));
    module.members
      .filter((member) => !activeMemberIds.has(member.memberInstanceId))
      .forEach((member) => deleteTodayRecordsForMember(database, module.moduleId, member.memberInstanceId));
  });
}

function slotsFor(memberCount: number): string[] {
  if (memberCount === 1) return ['center'];
  if (memberCount === 2) return ['top-center', 'bottom-center'];
  if (memberCount === 3) return ['top-left', 'top-right', 'bottom-center'];
  return ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
}

export async function getCurrentUser(): Promise<User> {
  await delay(60);
  return readDatabase().currentUser;
}

export interface ProfileOverview {
  user: User;
  recordedDays: number;
  moduleCount: number;
  unreadCount: number;
}

export async function getProfileOverview(): Promise<ProfileOverview> {
  const database = readDatabase();
  const recordedDays = new Set(database.records
    .filter((record) => record.userId === database.currentUser.userId
      && record.recordDate <= shanghaiDate() && isFormalRecord(record))
    .map((record) => record.recordDate)).size;
  const moduleCount = database.modules.filter((module) => module.status === 'active'
    && module.members.some((member) => member.userId === database.currentUser.userId && member.active)).length;
  return { user: database.currentUser, recordedDays, moduleCount, unreadCount: getUnreadNotificationCount() };
}

export const PROFILE_NICKNAME_MAX_LENGTH = 20;

export interface UpdateCurrentUserProfileInput {
  nickname: string;
  avatarUrl?: string;
}

export async function updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<User> {
  await delay(100);
  return updateDatabase((database) => {
    const nickname = input.nickname.trim();
    if (!nickname || nickname.length > PROFILE_NICKNAME_MAX_LENGTH) throw new Error('PROFILE_INPUT_INVALID');
    const currentUser = database.currentUser;
    const nextUser: User = {
      ...currentUser,
      nickname,
      avatarUrl: input.avatarUrl?.trim() || currentUser.avatarUrl,
    };
    database.currentUser = nextUser;
    database.modules.forEach((module) => {
      module.members = module.members.map((member) => (
        member.userId === nextUser.userId ? { ...member, ...nextUser } : member
      ));
    });
    return { ...nextUser };
  });
}

export async function getTemplates(): Promise<ModuleTemplate[]> {
  await delay(80);
  return readDatabase().templates;
}

export async function getHomeModules(
  _options: { reconcileNotifications?: boolean } = {},
): Promise<{ pinned: HomeModuleView[]; normal: HomeModuleView[] }> {
  await delay();
  const database = updateDatabase((current) => {
    purgeExpiredModules(current);
    purgeExitedMemberTodayRecords(current);
    return current;
  });
  const today = shanghaiDate();
  const participating = database.modules.filter((module) => module.status === 'active' &&
    module.members.some((member) => member.userId === database.currentUser.userId && member.active),
  );

  const views = participating.map<HomeModuleView>((module) => {
    const activeMemberIds = new Set(activeMembers(module).map((member) => member.memberInstanceId));
    const preference = database.preferences.find(
      (item) => item.moduleId === module.moduleId && item.userId === database.currentUser.userId,
    );
    const todayRecords = database.records
      .filter((record) => record.moduleId === module.moduleId
        && activeMemberIds.has(record.memberInstanceId)
        && record.recordDate === today
        && isFormalRecord(record))
      .sort((left, right) => left.firstEffectiveAt.localeCompare(right.firstEffectiveAt))
      .slice(-4);
    return {
      ...module,
      members: activeMembers(module),
      pinned: Boolean(preference?.pinned),
      unreadInboxCount: database.moduleInboxItems.filter((item) => item.moduleId === module.moduleId
        && item.recipientUserId === database.currentUser.userId
        && item.status === 'unread').length,
      todayPreviewItems: todayRecords.map((record, index) => ({
        recordId: record.recordId,
        memberInstanceId: record.memberInstanceId,
        stickerPath: record.stickerPath,
        displayOrder: index,
      })),
    };
  });

  return {
    pinned: views.filter((item) => item.pinned),
    normal: views.filter((item) => !item.pinned),
  };
}

export async function setModulePinned(moduleId: string, pinned: boolean): Promise<void> {
  await delay(80);
  updateDatabase((database) => {
    const preference = database.preferences.find(
      (item) => item.moduleId === moduleId && item.userId === database.currentUser.userId,
    );
    if (preference) preference.pinned = pinned;
    else database.preferences.push({ moduleId, userId: database.currentUser.userId, pinned });
  });
  track('home_module_pin_change', { moduleId, action: pinned ? 'pin' : 'unpin', result: 'success' });
}

export async function removeModuleForCurrentUser(moduleId: string): Promise<'deleted' | 'left'> {
  await delay(160);
  const result = updateDatabase<'deleted' | 'left'>((database) => {
    const moduleIndex = database.modules.findIndex((item) => item.moduleId === moduleId);
    if (moduleIndex < 0) throw new Error('MODULE_NOT_FOUND');
    const module = database.modules[moduleIndex];
    const members = activeMembers(module);
    const currentMember = members.find((item) => item.userId === database.currentUser.userId);
    if (!currentMember) throw new Error('MODULE_ACCESS_DENIED');

    if (members.length === 1) {
      purgeModuleData(database, moduleId);
      return 'deleted';
    }

    if (currentMember.role === 'creator') throw new Error('MODULE_TRANSFER_REQUIRED');
    const now = shanghaiNowIso();
    currentMember.active = false;
    currentMember.leftAt = now;
    currentMember.leaveReason = 'self_exit';
    database.streakRewardRules
      .filter((rule) => rule.moduleId === moduleId && rule.status === 'active'
        && (rule.sponsorMemberInstanceId === currentMember.memberInstanceId
          || rule.targetMemberInstanceId === currentMember.memberInstanceId))
      .forEach((rule) => {
        rule.status = 'cancelled';
        rule.cancelledAt = now;
        rule.updatedAt = now;
      });
    database.makeupApprovals
      .filter((approval) => approval.applicantMemberInstanceId === currentMember.memberInstanceId && approval.status === 'pending')
      .forEach((approval) => {
        approval.status = 'cancelled';
        approval.updatedAt = now;
        const record = database.records.find((item) => item.recordId === approval.recordId);
        if (record?.status === 'pending') {
          record.status = 'cancelled';
          record.updatedAt = now;
        }
        database.moduleInboxItems
          .filter((item) => item.targetId === approval.approvalId && item.status !== 'resolved')
          .forEach((item) => {
            item.status = 'resolved';
            item.updatedAt = now;
          });
      });
    deleteTodayRecordsForMember(database, moduleId, currentMember.memberInstanceId);
    database.reactions
      .filter((reaction) => reaction.reactorMemberInstanceId === currentMember.memberInstanceId)
      .forEach((reaction) => {
        reaction.reactorNameSnapshot = '已退出成员';
        reaction.reactorAvatarTextSnapshot = '退';
        reaction.reactorAvatarColorSnapshot = '#d7d2ca';
        reaction.updatedAt = now;
      });
    database.preferences = database.preferences.filter(
      (preference) => !(preference.moduleId === moduleId && preference.userId === database.currentUser.userId),
    );
    module.updatedAt = now;
    notifyRemainingMembersOfDeparture(database, module, currentMember, now);
    addAudit(database, 'self_exit_module', moduleId, currentMember.memberInstanceId);
    return 'left';
  });
  track('home_module_remove', { moduleId, action: result, result: 'success' });
  return result;
}

export interface CreateModuleInput {
  name: string;
  description: string;
  recordPolicy: 'strict' | 'relaxed';
  templateId?: string;
  clientRequestId: string;
}

export async function createModule(input: CreateModuleInput): Promise<LifeModule> {
  await delay(220);
  return updateDatabase((database) => {
    const trimmedName = input.name.trim();
    const trimmedDescription = input.description.trim();
    if (!trimmedName || trimmedName.length > MODULE_NAME_MAX_LENGTH || trimmedDescription.length > MODULE_DESCRIPTION_MAX_LENGTH) {
      throw new Error('MODULE_INPUT_INVALID');
    }
    if (!['strict', 'relaxed'].includes(input.recordPolicy)) throw new Error('MODULE_INPUT_INVALID');
    const previousId = database.idempotency[input.clientRequestId];
    if (previousId) {
      const previous = database.modules.find((module) => module.moduleId === previousId);
      if (previous) return previous;
    }

    const moduleId = createId('module');
    const now = shanghaiNowIso();
    const creator: ModuleMember = {
      ...database.currentUser,
      memberInstanceId: createId('member'),
      role: 'creator',
      joinSequence: 1,
      joinedAt: now,
      active: true,
    };
    const module: LifeModule = {
      moduleId,
      name: trimmedName,
      description: trimmedDescription,
      mode: 'solo',
      recordPolicy: input.recordPolicy,
      status: 'active',
      creatorUserId: database.currentUser.userId,
      createdAt: now,
      updatedAt: now,
      members: [creator],
    };
    database.modules.unshift(module);
    database.preferences.push({ moduleId, userId: database.currentUser.userId, pinned: false });
    database.idempotency[input.clientRequestId] = moduleId;
    track('module_create_success', { moduleId, hasTemplate: Boolean(input.templateId), isFirstModule: false });
    return module;
  });
}

export async function getModule(moduleId: string): Promise<LifeModule> {
  await delay();
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  if (module.status !== 'active') throw new Error('MODULE_PENDING_DELETE');
  if (!module.members.some((member) => member.userId === database.currentUser.userId && member.active)) {
    throw new Error('MODULE_ACCESS_DENIED');
  }
  return { ...module, members: activeMembers(module) };
}

export async function refreshModule(moduleId: string): Promise<LifeModule> {
  return getModule(moduleId);
}

export async function getCalendar(moduleId: string, month: string): Promise<CalendarCell[]> {
  await delay(140);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  const members = activeMembers(module);
  const activeMemberIds = new Set(members.map((member) => member.memberInstanceId));
  const currentMember = members.find((member) => member.userId === database.currentUser.userId);
  const slots = slotsFor(members.length);
  const today = shanghaiDate();
  return buildMonthGrid(month).map((cell) => {
    const records = database.records
      .filter((record) => record.moduleId === moduleId
        && record.recordDate === cell.date
        && isFormalRecord(record)
        && (cell.date !== today || activeMemberIds.has(record.memberInstanceId)))
      .map<CalendarRecordView>((record) => {
        const targetMember = members.find((item) => item.memberInstanceId === record.memberInstanceId) ?? members[0];
        const memberIndex = Math.max(0, members.findIndex((item) => item.memberInstanceId === record.memberInstanceId));
        return { ...record, member: targetMember, slot: slots[memberIndex] ?? 'center' };
      });
    return {
      ...cell,
      isToday: cell.date === today,
      isFuture: differenceInDays(cell.date, today) > 0,
      hasRecords: records.length > 0,
      hasPendingMakeup: Boolean(currentMember && database.makeupApprovals.some(
        (approval) => approval.moduleId === moduleId
          && approval.applicantMemberInstanceId === currentMember.memberInstanceId
          && approval.targetDate === cell.date
          && approval.status === 'pending',
      )),
      records,
    };
  });
}

export async function getDateRecords(moduleId: string, recordDate: string): Promise<LifeRecord[]> {
  await delay(80);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  const activeMemberIds = new Set(activeMembers(module).map((member) => member.memberInstanceId));
  return database.records
    .filter((record) => record.moduleId === moduleId
      && record.recordDate === recordDate
      && isFormalRecord(record)
      && (recordDate !== shanghaiDate() || activeMemberIds.has(record.memberInstanceId)))
    .sort((left, right) => left.firstEffectiveAt.localeCompare(right.firstEffectiveAt));
}

export async function getCurrentMakeupApproval(moduleId: string, recordDate: string): Promise<MakeupApproval | undefined> {
  await delay(40);
  return updateDatabase((database) => {
    expireBetaState(database);
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) return undefined;
    const member = module.members.find((item) => item.userId === database.currentUser.userId && item.active);
    if (!member) return undefined;
    return database.makeupApprovals.find((approval) =>
      approval.moduleId === moduleId
      && approval.applicantMemberInstanceId === member.memberInstanceId
      && approval.targetDate === recordDate
      && approval.status === 'pending');
  });
}

export async function processMedia(
  originalPath: string,
  _moduleId?: string,
  onUploadProgress?: (progress: number) => void,
  onProcessing?: () => void,
  _sourceType: 'camera' | 'gallery' = 'gallery',
): Promise<MediaResult> {
  onUploadProgress?.(35);
  await delay(350);
  onUploadProgress?.(100);
  onProcessing?.();
  await delay(800);
  const index = Math.abs([...originalPath].reduce((total, value) => total + value.charCodeAt(0), 0)) % STICKER_PATHS.length;
  const result = {
    mediaId: createId('media'),
    originalPath,
    stickerPath: STICKER_PATHS[index],
  };
  track('record_media_ready', { mediaId: result.mediaId, totalDurationMs: 1150 });
  return result;
}

export async function refreshMediaStickerSources(_mediaId: string): Promise<MediaStickerSources> {
  return { stickerPath: STICKER_PATHS[0] };
}

export function prewarmMediaUpload(_moduleId: string): void {}

export function discardPrewarmedMediaUpload(_moduleId: string): void {}

export async function discardMedia(_mediaId: string): Promise<void> {}

export async function prepareMediaFile(filePath: string, _purpose: 'record_photo' | 'avatar'): Promise<PreparedMediaFile> {
  const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => {
    wx.getImageInfo({ src: filePath, success: resolve, fail: reject });
  });
  const fileSize = await new Promise<number>((resolve, reject) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success: ({ stats }) => resolve(Array.isArray(stats) ? 0 : stats.size),
      fail: reject,
    });
  });
  return {
    filePath,
    mimeType: info.type === 'png' ? 'image/png' : 'image/jpeg',
    fileSize,
    width: info.width,
    height: info.height,
  };
}

export async function initializeAndUploadCheckin(
  input: CheckinUploadInput,
  onProgress?: (progress: number) => void,
  onInitialized?: (result: CheckinUploadResult) => void,
): Promise<CheckinUploadResult> {
  onProgress?.(20);
  const media = await processMedia(input.filePath, input.moduleId);
  onProgress?.(100);
  const record = await saveRecord({
    moduleId: input.moduleId,
    recordDate: input.recordDate,
    originalPath: '',
    stickerPath: media.stickerPath,
    remark: input.remark,
    clientRequestId: input.clientRequestId,
    mediaId: media.mediaId,
  });
  onInitialized?.({ checkinId: record.recordId, mediaId: media.mediaId });
  localCheckinStatuses.set(record.recordId, {
    checkinId: record.recordId,
    mediaId: media.mediaId,
    displayStatus: 'ready',
    stage: 'completed',
    canLeave: true,
    elapsedMs: 0,
    stickerUrl: media.stickerPath,
    retryable: false,
  });
  return { checkinId: record.recordId, mediaId: media.mediaId };
}

export async function getCheckinProcessingStatus(checkinId: string): Promise<CheckinProcessingStatus> {
  await delay(80);
  const status = localCheckinStatuses.get(checkinId);
  if (!status) throw new Error('RECORD_NOT_FOUND');
  return status;
}

export async function retryCheckinMatting(_checkinId: string): Promise<void> {
  await delay(80);
}

export async function cancelProcessingCheckin(checkinId: string): Promise<void> {
  localCheckinStatuses.delete(checkinId);
}

export interface SaveRecordInput {
  moduleId: string;
  recordId?: string;
  recordDate: string;
  originalPath: string;
  stickerPath: string;
  remark: string;
  clientRequestId: string;
  mediaId?: string;
  mediaVariant?: 'sticker' | 'original';
}

export async function saveRecord(input: SaveRecordInput): Promise<LifeRecord> {
  await delay(240);
  return updateDatabase((database) => {
    const previousId = database.idempotency[input.clientRequestId];
    if (previousId) {
      const previous = database.records.find((record) => record.recordId === previousId);
      if (previous) return previous;
    }
    const module = database.modules.find((item) => item.moduleId === input.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    if (!canCreateNormalRecord(module.recordPolicy, input.recordDate)) throw new Error('RECORD_DATE_LOCKED');
    if (module.status !== 'active') throw new Error('MODULE_PENDING_DELETE');
    const currentMember = module.members.find(
      (item) => item.userId === database.currentUser.userId && item.active,
    );
    if (!currentMember) throw new Error('MODULE_ACCESS_DENIED');

    const now = shanghaiNowIso();
    const existing = input.recordId
      ? database.records.find((record) => record.recordId === input.recordId)
      : database.records.find(
          (record) =>
            record.moduleId === input.moduleId &&
            record.memberInstanceId === currentMember.memberInstanceId &&
            record.recordDate === input.recordDate,
        );
    if (existing) {
      if (existing.userId !== database.currentUser.userId) throw new Error('RECORD_ACCESS_DENIED');
      if (existing.moduleId !== input.moduleId || existing.recordDate !== input.recordDate
        || existing.status !== 'active' || !canMutateRecord(module.recordPolicy, existing.recordDate)) {
        throw new Error('RECORD_ACCESS_DENIED');
      }
      existing.originalPath = input.originalPath;
      existing.generatedStickerPath = input.stickerPath;
      existing.mediaVariant = input.mediaVariant ?? 'sticker';
      existing.stickerPath = existing.mediaVariant === 'original' ? input.originalPath : input.stickerPath;
      existing.remark = input.remark.trim();
      existing.updatedAt = now;
      database.idempotency[input.clientRequestId] = existing.recordId;
      invalidateLocalMemoryCard(database, input.moduleId, input.recordDate.slice(0, 7));
      track('record_edit_success', { recordId: existing.recordId, firstEffectiveAtPreserved: true });
      return existing;
    }

    const record: LifeRecord = {
      recordId: createId('record'),
      moduleId: input.moduleId,
      memberInstanceId: currentMember.memberInstanceId,
      userId: database.currentUser.userId,
      recordDate: input.recordDate,
      originalPath: input.originalPath,
      stickerPath: input.mediaVariant === 'original' ? input.originalPath : input.stickerPath,
      generatedStickerPath: input.stickerPath,
      mediaVariant: input.mediaVariant ?? 'sticker',
      remark: input.remark.trim(),
      source: 'normal',
      status: 'active',
      firstEffectiveAt: now,
      updatedAt: now,
    };
    database.records.push(record);
    database.idempotency[input.clientRequestId] = record.recordId;
    refreshLocalRecordProjections(database, module, input.recordDate);
    evaluateLocalStreakRewards(database, module, record);
    track('record_submit_success', { recordId: record.recordId, editorMode: 'create', recordSource: 'normal' });
    return record;
  });
}

export async function deleteRecord(recordId: string): Promise<void> {
  await delay(160);
  updateDatabase((database) => {
    const index = database.records.findIndex((record) => record.recordId === recordId);
    if (index < 0) return;
    const record = database.records[index];
    const module = database.modules.find((item) => item.moduleId === record.moduleId);
    if (!module || record.userId !== database.currentUser.userId) throw new Error('RECORD_ACCESS_DENIED');
    if (record.status !== 'active' || !canMutateRecord(module.recordPolicy, record.recordDate)) {
      throw new Error('RECORD_DELETE_FORBIDDEN');
    }
    database.records.splice(index, 1);
    refreshLocalRecordProjections(database, module, record.recordDate);
  });
  track('record_delete_success', { recordId });
}

export function currentUserRecord(records: LifeRecord[]): LifeRecord | undefined {
  const userId = readDatabase().currentUser.userId;
  return records.find((record) => record.userId === userId);
}

const MEMBER_LIMIT = 4;

function findActiveMember(database: AppDatabase, module: LifeModule, userId = database.currentUser.userId): ModuleMember {
  if (module.status !== 'active') throw new Error('MODULE_PENDING_DELETE');
  const member = module.members.find((item) => item.userId === userId && item.active);
  if (!member) throw new Error('MODULE_ACCESS_DENIED');
  return member;
}

function purgeModuleData(database: AppDatabase, moduleId: string): void {
  database.modules = database.modules.filter((module) => module.moduleId !== moduleId);
  database.preferences = database.preferences.filter((item) => item.moduleId !== moduleId);
  database.records = database.records.filter((item) => item.moduleId !== moduleId);
  database.reactions = database.reactions.filter((item) => item.moduleId !== moduleId);
  database.makeupApprovals = database.makeupApprovals.filter((item) => item.moduleId !== moduleId);
  database.inviteTokens = database.inviteTokens.filter((item) => item.moduleId !== moduleId);
  database.joinApplications = database.joinApplications.filter((item) => item.moduleId !== moduleId);
  database.notifications = database.notifications.filter((item) => item.moduleId !== moduleId);
  database.moduleInboxItems = database.moduleInboxItems.filter((item) => item.moduleId !== moduleId);
  database.reminders = database.reminders.filter((item) => item.moduleId !== moduleId);
  database.dailySnapshots = database.dailySnapshots.filter((item) => item.moduleId !== moduleId);
  database.monthlyMemoryCards = database.monthlyMemoryCards.filter((item) => item.moduleId !== moduleId);
  database.streakRewardRules = database.streakRewardRules.filter((item) => item.moduleId !== moduleId);
  database.streakRewardEvents = database.streakRewardEvents.filter((item) => item.moduleId !== moduleId);
  database.streakRewardDraws = database.streakRewardDraws.filter((item) => item.moduleId !== moduleId);
}

function purgeExpiredModules(database: AppDatabase): void {
  const now = Date.now();
  database.modules
    .filter((module) => module.status === 'pending_delete' && module.recycleExpireAt && Date.parse(module.recycleExpireAt) <= now)
    .map((module) => module.moduleId)
    .forEach((moduleId) => {
      addAudit(database, 'module_permanently_deleted', moduleId);
      purgeModuleData(database, moduleId);
    });
}

function addAudit(database: AppDatabase, action: string, moduleId?: string, targetId?: string): void {
  database.auditLog.push({
    auditId: createId('audit'),
    moduleId,
    actorUserId: database.currentUser.userId,
    action,
    targetId,
    createdAt: shanghaiNowIso(),
  });
}

function expireBetaState(database: AppDatabase): void {
  const now = Date.now();
  database.inviteTokens.forEach((invite) => {
    if (invite.status === 'active' && Date.parse(invite.expireAt) <= now) invite.status = 'expired';
  });
  database.joinApplications.forEach((application) => {
    if (application.status === 'pending' && Date.parse(application.expireAt) <= now) application.status = 'expired';
  });
  database.makeupApprovals.forEach((approval) => {
    if (approval.status !== 'pending' || Date.parse(approval.expireAt) > now) return;
    approval.status = 'expired';
    const record = database.records.find((item) => item.recordId === approval.recordId);
    if (record?.status === 'pending') record.status = 'expired';
    database.moduleInboxItems
      .filter((item) => item.targetId === approval.approvalId && item.status !== 'resolved')
      .forEach((item) => { item.status = 'expired'; });
  });
  database.notifications.forEach((notification) => {
    if (notification.targetType !== 'join_application' || notification.actionStatus !== 'actionable') return;
    const application = database.joinApplications.find((item) => item.applicationId === notification.targetId);
    if (!application || application.status !== 'pending') notification.actionStatus = 'expired';
  });
  database.moduleInboxItems
    .filter((item) => item.targetType === 'join_application' && item.status !== 'resolved')
    .forEach((item) => {
      const application = database.joinApplications.find((candidate) => candidate.applicationId === item.targetId);
      if (!application || application.status === 'expired' || application.status === 'cancelled') item.status = 'expired';
    });
}

export interface MemberManagementView {
  module: LifeModule;
  members: Array<ModuleMember & { isMine: boolean; recordedToday: boolean; joinedDate: string }>;
  currentRole: 'creator' | 'member';
  inviteAvailable: boolean;
  memberLimit: number;
}

export async function getMemberManagement(moduleId: string): Promise<MemberManagementView> {
  await delay(90);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  const currentMember = findActiveMember(database, module);
  const today = shanghaiDate();
  const members = activeMembers(module).map((member) => ({
    ...member,
    isMine: member.userId === database.currentUser.userId,
    joinedDate: member.joinedAt.slice(0, 10),
    recordedToday: database.records.some(
      (record) => record.memberInstanceId === member.memberInstanceId && record.recordDate === today && isFormalRecord(record),
    ),
  }));
  return {
    module: { ...module, members },
    members,
    currentRole: currentMember.role,
    inviteAvailable: members.length < MEMBER_LIMIT,
    memberLimit: MEMBER_LIMIT,
  };
}

export async function transferModuleCreator(moduleId: string, targetMemberInstanceId: string): Promise<void> {
  await delay(150);
  updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (currentMember.role !== 'creator') throw new Error('CREATOR_REQUIRED');
    const target = module.members.find((item) => item.memberInstanceId === targetMemberInstanceId && item.active);
    if (!target || target.role === 'creator') throw new Error('MEMBER_NOT_FOUND');
    currentMember.role = 'member';
    target.role = 'creator';
    module.creatorUserId = target.userId;
    module.updatedAt = shanghaiNowIso();
    addAudit(database, 'transfer_creator', moduleId, targetMemberInstanceId);
    const now = shanghaiNowIso();
    activeMembers(module).forEach((member) => database.notifications.push({
      notificationId: createId('notification'),
      userId: member.userId,
      type: 'creator_transferred',
      title: '创建者已转让',
      content: `「${module.name}」的新创建者是${target.nickname}`,
      moduleId,
      targetType: 'module',
      targetId: moduleId,
      actionType: 'none',
      actionStatus: 'none',
      isRead: member.userId === database.currentUser.userId,
      createdAt: now,
      updatedAt: now,
    }));
  });
  track('member_transfer_success', { moduleId, targetMemberInstanceId });
}

export async function removeModuleMember(moduleId: string, targetMemberInstanceId: string): Promise<void> {
  await delay(150);
  updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (currentMember.role !== 'creator') throw new Error('CREATOR_REQUIRED');
    const target = module.members.find((item) => item.memberInstanceId === targetMemberInstanceId && item.active);
    if (!target || target.role === 'creator') throw new Error('MEMBER_NOT_FOUND');
    const now = shanghaiNowIso();
    target.active = false;
    target.leftAt = now;
    target.leaveReason = 'removed';
    database.streakRewardRules
      .filter((rule) => rule.moduleId === moduleId && rule.status === 'active'
        && (rule.sponsorMemberInstanceId === target.memberInstanceId
          || rule.targetMemberInstanceId === target.memberInstanceId))
      .forEach((rule) => {
        rule.status = 'cancelled';
        rule.cancelledAt = now;
        rule.updatedAt = now;
      });
    database.makeupApprovals
      .filter((approval) => approval.applicantMemberInstanceId === target.memberInstanceId && approval.status === 'pending')
      .forEach((approval) => {
        approval.status = 'cancelled';
        approval.updatedAt = now;
        const record = database.records.find((item) => item.recordId === approval.recordId);
        if (record) {
          record.status = 'cancelled';
          record.updatedAt = now;
        }
        database.moduleInboxItems
          .filter((item) => item.targetId === approval.approvalId && item.status !== 'resolved')
          .forEach((item) => {
            item.status = 'resolved';
            item.updatedAt = now;
          });
      });
    deleteTodayRecordsForMember(database, moduleId, target.memberInstanceId);
    database.reactions
      .filter((reaction) => reaction.reactorMemberInstanceId === target.memberInstanceId)
      .forEach((reaction) => {
        reaction.reactorNameSnapshot = '已退出成员';
        reaction.reactorAvatarTextSnapshot = '退';
        reaction.reactorAvatarColorSnapshot = '#d7d2ca';
      });
    database.preferences = database.preferences.filter(
      (preference) => !(preference.moduleId === moduleId && preference.userId === target.userId),
    );
    notifyRemainingMembersOfDeparture(database, module, target, now);
    database.notifications.push({
      notificationId: createId('notification'),
      userId: target.userId,
      type: 'member_removed',
      title: '你已被移出模块',
      content: `你已无法继续访问「${module.name}」，历史日期记录将匿名保留`,
      moduleId,
      targetType: 'module',
      targetId: moduleId,
      actionType: 'none',
      actionStatus: 'none',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
    module.updatedAt = now;
    addAudit(database, 'remove_member', moduleId, targetMemberInstanceId);
  });
  track('member_remove_success', { moduleId, targetMemberInstanceId });
}

export interface InvitePreview {
  invite: InviteToken;
  module: Pick<LifeModule, 'moduleId' | 'name' | 'description'>;
  inviter: User;
  memberCount: number;
  memberLimit: number;
  valid: boolean;
  codeUrl?: string;
}

export async function createModuleInvite(moduleId: string): Promise<InvitePreview> {
  await delay(120);
  return updateDatabase((database) => {
    expireBetaState(database);
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (activeMembers(module).length >= MEMBER_LIMIT) throw new Error('MODULE_FULL');
    const now = shanghaiNowIso();
    const invite: InviteToken = {
      inviteId: createId('invite'),
      moduleId,
      createdByUserId: database.currentUser.userId,
      createdByMemberInstanceId: currentMember.memberInstanceId,
      token: createId('token'),
      status: 'active',
      expireAt: shanghaiNowIso(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      createdAt: now,
      updatedAt: now,
    };
    database.inviteTokens.push(invite);
    addAudit(database, 'create_invite', moduleId, invite.inviteId);
    return {
      invite,
      module: { moduleId, name: module.name, description: module.description },
      inviter: { ...database.currentUser },
      memberCount: activeMembers(module).length,
      memberLimit: MEMBER_LIMIT,
      valid: true,
    };
  });
}

export async function getInvitePreview(inviteId: string): Promise<InvitePreview> {
  await delay(80);
  return updateDatabase((database) => {
    expireBetaState(database);
    const invite = database.inviteTokens.find((item) => item.inviteId === inviteId);
    if (!invite) throw new Error('INVITE_NOT_FOUND');
    const module = database.modules.find((item) => item.moduleId === invite.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const inviterMember = module.members.find((item) => item.memberInstanceId === invite.createdByMemberInstanceId);
    const memberCount = activeMembers(module).length;
    return {
      invite: { ...invite },
      module: { moduleId: module.moduleId, name: module.name, description: module.description },
      inviter: inviterMember ? {
        userId: inviterMember.userId,
        nickname: inviterMember.nickname,
        avatarText: inviterMember.avatarText,
        avatarColor: inviterMember.avatarColor,
        avatarUrl: inviterMember.avatarUrl,
      } : database.currentUser,
      memberCount,
      memberLimit: MEMBER_LIMIT,
      valid: invite.status === 'active' && memberCount < MEMBER_LIMIT,
    };
  });
}

export async function submitJoinApplication(inviteId: string): Promise<JoinApplication | 'already_member'> {
  await delay(150);
  return updateDatabase((database) => {
    expireBetaState(database);
    const invite = database.inviteTokens.find((item) => item.inviteId === inviteId);
    if (!invite || invite.status !== 'active') throw new Error('INVITE_INVALID');
    const module = database.modules.find((item) => item.moduleId === invite.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    if (activeMembers(module).some((member) => member.userId === database.currentUser.userId)) return 'already_member';
    if (activeMembers(module).length >= MEMBER_LIMIT) throw new Error('MODULE_FULL');
    const existing = database.joinApplications.find(
      (item) => item.moduleId === module.moduleId && item.applicantUserId === database.currentUser.userId && item.status === 'pending',
    );
    if (existing) return existing;
    const rejected = database.joinApplications
      .filter((item) => item.moduleId === module.moduleId && item.applicantUserId === database.currentUser.userId && item.status === 'rejected')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (rejected?.reapplyAllowedAt && Date.parse(rejected.reapplyAllowedAt) > Date.now()) throw new Error('JOIN_COOLDOWN');
    const now = shanghaiNowIso();
    const application: JoinApplication = {
      applicationId: createId('application'),
      moduleId: module.moduleId,
      applicantUserId: database.currentUser.userId,
      inviteId,
      status: 'pending',
      applicantNameSnapshot: database.currentUser.nickname,
      applicantAvatarTextSnapshot: database.currentUser.avatarText,
      applicantAvatarColorSnapshot: database.currentUser.avatarColor,
      expireAt: shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
      createdAt: now,
      updatedAt: now,
    };
    database.joinApplications.push(application);
    database.notifications.push({
      notificationId: createId('notification'),
      userId: module.creatorUserId,
      type: 'join_application',
      title: '新的加入申请',
      content: `${database.currentUser.nickname}申请加入「${module.name}」`,
      moduleId: module.moduleId,
      targetType: 'join_application',
      targetId: application.applicationId,
      actionType: 'approve_join',
      actionStatus: 'actionable',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
    database.moduleInboxItems.push({
      itemId: createId('inbox'),
      moduleId: module.moduleId,
      recipientUserId: module.creatorUserId,
      type: 'join_application',
      title: '新的加入申请',
      content: `${database.currentUser.nickname}申请加入「${module.name}」`,
      targetType: 'join_application',
      targetId: application.applicationId,
      status: 'unread',
      createdAt: now,
      updatedAt: now,
      expireAt: application.expireAt,
    });
    return application;
  });
}

export interface NotificationView extends AppNotification {
  moduleName: string;
  application?: JoinApplication;
  approval?: MakeupApproval;
}

export async function getNotifications(): Promise<NotificationView[]> {
  await delay(90);
  runInAppReminderScan();
  return updateDatabase((database) => {
    expireBetaState(database);
    return database.notifications
      .filter((item) => item.userId === database.currentUser.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((notification) => ({
        ...notification,
        moduleName: database.modules.find((module) => module.moduleId === notification.moduleId)?.name ?? '已失效模块',
        application: notification.targetType === 'join_application'
          ? database.joinApplications.find((item) => item.applicationId === notification.targetId)
          : undefined,
        approval: notification.targetType === 'makeup_approval'
          ? database.makeupApprovals.find((item) => item.approvalId === notification.targetId)
          : undefined,
      }));
  });
}

export function getUnreadNotificationCount(): number {
  return readDatabase().notifications.filter((item) => item.userId === readDatabase().currentUser.userId && !item.isRead).length;
}

function moduleInboxItemRequiresAction(database: AppDatabase, item: ModuleInboxItem): boolean {
  if (item.targetType === 'join_application') {
    return database.joinApplications.some((application) => application.applicationId === item.targetId && application.status === 'pending');
  }
  if (item.targetType === 'makeup_approval') {
    return database.makeupApprovals.some((approval) => approval.approvalId === item.targetId && approval.status === 'pending');
  }
  return false;
}

function notificationRequiresAction(database: AppDatabase, notification: AppNotification): boolean {
  if (notification.actionStatus !== 'actionable') return false;
  if (notification.targetType === 'join_application') {
    return database.joinApplications.some((application) => application.applicationId === notification.targetId && application.status === 'pending');
  }
  if (notification.targetType === 'makeup_approval') {
    return database.makeupApprovals.some((approval) => approval.approvalId === notification.targetId && approval.status === 'pending');
  }
  return false;
}

function hasSynchronizedNotification(item: ModuleInboxItem): boolean {
  return item.targetType === 'join_application' || item.type === 'member_change' || item.type === 'makeup_result';
}

export async function refreshUnreadNotificationCount(): Promise<number> {
  await delay(30);
  return getUnreadNotificationCount();
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await delay(50);
  updateDatabase((database) => {
    const notification = database.notifications.find(
      (item) => item.notificationId === notificationId && item.userId === database.currentUser.userId,
    );
    if (notification) {
      if (notificationRequiresAction(database, notification)) return;
      notification.isRead = true;
      notification.updatedAt = shanghaiNowIso();
      if (notification.targetId
        && (notification.targetType === 'join_application' || notification.type === 'member_change' || notification.type === 'makeup_result')) {
        database.moduleInboxItems
          .filter((item) => item.recipientUserId === database.currentUser.userId
            && item.targetType === notification.targetType && item.targetId === notification.targetId && item.status === 'unread'
            && !moduleInboxItemRequiresAction(database, item))
          .forEach((item) => { item.status = 'read'; item.updatedAt = notification.updatedAt; });
      }
    }
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await delay(60);
  updateDatabase((database) => {
    const targets = database.notifications
      .filter((item) => item.userId === database.currentUser.userId && item.targetId
        && (item.targetType === 'join_application' || item.type === 'member_change' || item.type === 'makeup_result'));
    database.notifications.filter((item) => item.userId === database.currentUser.userId && !notificationRequiresAction(database, item)).forEach((item) => {
      item.isRead = true;
      item.updatedAt = shanghaiNowIso();
    });
    database.moduleInboxItems
      .filter((item) => item.recipientUserId === database.currentUser.userId
        && targets.some((notification) => notification.targetType === item.targetType && notification.targetId === item.targetId)
        && item.status === 'unread' && !moduleInboxItemRequiresAction(database, item))
      .forEach((item) => { item.status = 'read'; item.updatedAt = shanghaiNowIso(); });
  });
}

export async function resolveJoinApplication(applicationId: string, action: 'approve' | 'reject'): Promise<JoinApplication> {
  await delay(180);
  return updateDatabase((database) => {
    expireBetaState(database);
    const application = database.joinApplications.find((item) => item.applicationId === applicationId);
    if (!application) throw new Error('JOIN_APPLICATION_NOT_FOUND');
    if (application.status !== 'pending') throw new Error('JOIN_APPLICATION_ALREADY_RESOLVED');
    const module = database.modules.find((item) => item.moduleId === application.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (currentMember.role !== 'creator') throw new Error('CREATOR_REQUIRED');
    const now = shanghaiNowIso();
    let joinedMember: ModuleMember | undefined;
    if (action === 'approve') {
      if (activeMembers(module).length >= MEMBER_LIMIT) throw new Error('MODULE_FULL');
      if (activeMembers(module).some((member) => member.userId === application.applicantUserId)) {
        application.status = 'cancelled';
        application.resolutionReason = 'already_member';
      } else {
        const joinSequence = Math.max(0, ...module.members.map((member) => member.joinSequence)) + 1;
        const member: ModuleMember = {
          userId: application.applicantUserId,
          nickname: application.applicantNameSnapshot,
          avatarText: application.applicantAvatarTextSnapshot,
          avatarColor: application.applicantAvatarColorSnapshot,
          memberInstanceId: createId('member'),
          role: 'member',
          joinSequence,
          joinedAt: now,
          active: true,
        };
        module.members.push(member);
        joinedMember = member;
        module.mode = 'group';
        application.status = 'approved';
        application.resultMemberInstanceId = member.memberInstanceId;
      }
    } else {
      application.status = 'rejected';
      application.reapplyAllowedAt = shanghaiNowIso(new Date(Date.now() + 24 * 60 * 60 * 1000));
    }
    application.resolvedAt = now;
    application.resolvedByUserId = database.currentUser.userId;
    application.updatedAt = now;
    database.notifications
      .filter((notification) => notification.targetType === 'join_application' && notification.targetId === applicationId)
      .forEach((notification) => {
        notification.type = 'join_result';
        notification.title = action === 'approve' ? '成员已加入' : '加入申请未通过';
        notification.content = action === 'approve'
          ? `「${application.applicantNameSnapshot}」已加入「${module.name}」`
          : `「${application.applicantNameSnapshot}」的加入申请已被拒绝`;
        notification.actionType = 'none';
        notification.actionStatus = 'none';
        notification.isRead = notification.userId === database.currentUser.userId;
        notification.updatedAt = now;
      });
    database.moduleInboxItems
      .filter((item) => item.targetType === 'join_application' && item.targetId === applicationId)
      .forEach((item) => {
        item.title = action === 'approve' ? '成员已加入' : '加入申请未通过';
        item.content = action === 'approve'
          ? `「${application.applicantNameSnapshot}」已加入「${module.name}」`
          : `「${application.applicantNameSnapshot}」的加入申请已被拒绝`;
        item.status = item.recipientUserId === database.currentUser.userId ? 'read' : 'unread';
        item.updatedAt = now;
        item.expireAt = shanghaiNowIso(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      });
    if (joinedMember) {
      const content = `「${joinedMember.nickname}」已加入「${module.name}」`;
      activeMembers(module)
        .filter((member) => member.userId !== database.currentUser.userId)
        .forEach((member) => {
          database.moduleInboxItems.push({
            itemId: createId('inbox'),
            moduleId: module.moduleId,
            recipientUserId: member.userId,
            type: 'member_change',
            title: '成员已加入',
            content,
            targetType: 'member',
            targetId: joinedMember!.memberInstanceId,
            status: 'unread',
            createdAt: now,
            updatedAt: now,
            expireAt: shanghaiNowIso(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
          });
          database.notifications.push({
            notificationId: createId('notification'),
            userId: member.userId,
            type: 'member_change',
            title: '成员已加入',
            content,
            moduleId: module.moduleId,
            targetType: 'member',
            targetId: joinedMember!.memberInstanceId,
            actionType: 'none',
            actionStatus: 'none',
            isRead: false,
            createdAt: now,
            updatedAt: now,
          });
        });
    }
    database.notifications.push({
      notificationId: createId('notification'),
      userId: application.applicantUserId,
      type: 'join_result',
      title: action === 'approve' ? '加入申请已通过' : '加入申请未通过',
      content: action === 'approve' ? `你已加入「${module.name}」` : `「${module.name}」的创建者拒绝了申请`,
      moduleId: module.moduleId,
      targetType: 'module',
      targetId: module.moduleId,
      actionType: 'none',
      actionStatus: 'none',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
    addAudit(database, `join_${action}`, module.moduleId, applicationId);
    return { ...application };
  });
}

export interface ReactionView extends Reaction {
  isMine: boolean;
  emoji: string;
}

const REACTION_EMOJIS: Record<ReactionEmoji, string> = {
  heart: '❤️',
  like: '👍',
  laugh: '😂',
  yummy: '😋',
  hug: '🫂',
  cheer: '💪',
};

export function getReactionOptions(): Array<{ code: ReactionEmoji; emoji: string; label: string }> {
  return [
    { code: 'heart', emoji: '❤️', label: '喜欢' },
    { code: 'like', emoji: '👍', label: '收到' },
    { code: 'laugh', emoji: '😂', label: '好笑' },
    { code: 'yummy', emoji: '😋', label: '不错' },
    { code: 'hug', emoji: '🫂', label: '抱抱' },
    { code: 'cheer', emoji: '💪', label: '加油' },
  ];
}

export async function getRecordReactions(recordId: string): Promise<ReactionView[]> {
  await delay(40);
  const database = readDatabase();
  const record = database.records.find((item) => item.recordId === recordId && isFormalRecord(item));
  if (!record) throw new Error('RECORD_NOT_FOUND');
  const module = database.modules.find((item) => item.moduleId === record.moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  return database.reactions
    .filter((reaction) => reaction.recordId === recordId && reaction.status === 'active')
    .map((reaction) => ({
      ...reaction,
      isMine: reaction.reactorUserId === database.currentUser.userId,
      emoji: REACTION_EMOJIS[reaction.emojiCode],
    }));
}

export async function setRecordReaction(recordId: string, emojiCode: ReactionEmoji): Promise<'set' | 'cancelled'> {
  await delay(80);
  return updateDatabase((database) => {
    const record = database.records.find((item) => item.recordId === recordId && isFormalRecord(item));
    if (!record) throw new Error('RECORD_NOT_FOUND');
    const module = database.modules.find((item) => item.moduleId === record.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (record.memberInstanceId === currentMember.memberInstanceId) throw new Error('REACTION_SELF_FORBIDDEN');
    const now = shanghaiNowIso();
    const existing = database.reactions.find(
      (reaction) => reaction.recordId === recordId && reaction.reactorMemberInstanceId === currentMember.memberInstanceId,
    );
    if (existing?.status === 'active' && existing.emojiCode === emojiCode) {
      existing.status = 'cancelled';
      existing.updatedAt = now;
      return 'cancelled';
    }
    if (existing) {
      existing.emojiCode = emojiCode;
      existing.status = 'active';
      existing.updatedAt = now;
    } else {
      database.reactions.push({
        reactionId: createId('reaction'),
        moduleId: record.moduleId,
        recordId,
        reactorUserId: database.currentUser.userId,
        reactorMemberInstanceId: currentMember.memberInstanceId,
        emojiCode,
        status: 'active',
        reactorNameSnapshot: currentMember.nickname,
        reactorAvatarTextSnapshot: currentMember.avatarText,
        reactorAvatarColorSnapshot: currentMember.avatarColor,
        createdAt: now,
        updatedAt: now,
      });
    }
    const targetMember = module.members.find((member) => member.memberInstanceId === record.memberInstanceId);
    if (targetMember && targetMember.userId !== database.currentUser.userId) {
      const dedupe = database.moduleInboxItems.find(
        (item) => item.recipientUserId === targetMember.userId && item.type === 'reaction' && item.targetId === recordId,
      );
      if (dedupe) {
        dedupe.status = 'unread';
        dedupe.updatedAt = now;
      } else {
        database.moduleInboxItems.push({
          itemId: createId('inbox'),
          moduleId: record.moduleId,
          recipientUserId: targetMember.userId,
          type: 'reaction',
          title: '记录收到新回应',
          content: `${currentMember.nickname}回应了你的记录`,
          targetType: 'record',
          targetId: recordId,
          recordDate: record.recordDate,
          status: 'unread',
          createdAt: now,
          updatedAt: now,
          expireAt: shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
        });
      }
    }
    return 'set';
  });
}

export interface SubmitMakeupInput {
  moduleId: string;
  recordDate: string;
  originalPath: string;
  stickerPath: string;
  remark: string;
  clientRequestId: string;
  mediaId?: string;
  mediaVariant?: 'sticker' | 'original';
}

export async function submitMakeupRecord(input: SubmitMakeupInput): Promise<{ record: LifeRecord; approval?: MakeupApproval }> {
  await delay(180);
  return updateDatabase((database) => {
    const previousId = database.idempotency[input.clientRequestId];
    if (previousId) {
      const previousRecord = database.records.find((record) => record.recordId === previousId);
      if (previousRecord) {
        return {
          record: previousRecord,
          approval: database.makeupApprovals.find((approval) => approval.recordId === previousRecord.recordId),
        };
      }
    }
    const module = database.modules.find((item) => item.moduleId === input.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    if (!canSubmitMakeup(module.recordPolicy, input.recordDate)) {
      throw new Error(module.recordPolicy === 'relaxed' ? 'MAKEUP_NOT_APPLICABLE' : 'MAKEUP_DATE_INVALID');
    }
    const currentMember = findActiveMember(database, module);
    const duplicate = database.records.find((record) =>
      record.moduleId === input.moduleId
      && record.memberInstanceId === currentMember.memberInstanceId
      && record.recordDate === input.recordDate
      && ['pending', 'active', 'locked'].includes(record.status));
    if (duplicate) throw new Error('RECORD_ALREADY_EXISTS');
    const now = shanghaiNowIso();
    const direct = module.mode === 'solo'
      || (currentMember.role === 'creator' && activeMembers(module).length === 1);
    const record: LifeRecord = {
      recordId: createId('record'),
      moduleId: input.moduleId,
      memberInstanceId: currentMember.memberInstanceId,
      userId: database.currentUser.userId,
      recordDate: input.recordDate,
      originalPath: input.originalPath,
      stickerPath: input.mediaVariant === 'original' ? input.originalPath : input.stickerPath,
      generatedStickerPath: input.stickerPath,
      mediaVariant: input.mediaVariant ?? 'sticker',
      remark: input.remark.trim(),
      source: 'makeup',
      status: direct ? 'locked' : 'pending',
      firstEffectiveAt: now,
      updatedAt: now,
    };
    database.records.push(record);
    database.idempotency[input.clientRequestId] = record.recordId;
    if (direct) {
      refreshLocalRecordProjections(database, module, input.recordDate);
      return { record };
    }
    const attemptNumber = database.makeupApprovals.filter(
      (approval) => approval.moduleId === input.moduleId
        && approval.applicantMemberInstanceId === currentMember.memberInstanceId
        && approval.targetDate === input.recordDate,
    ).length + 1;
    const approval: MakeupApproval = {
      approvalId: createId('approval'),
      moduleId: input.moduleId,
      recordId: record.recordId,
      applicantUserId: database.currentUser.userId,
      applicantMemberInstanceId: currentMember.memberInstanceId,
      targetDate: input.recordDate,
      attemptNumber,
      status: 'pending',
      expireAt: shanghaiNowIso(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      createdAt: now,
      updatedAt: now,
    };
    database.makeupApprovals.push(approval);
    activeMembers(module)
      .filter((member) => member.memberInstanceId !== currentMember.memberInstanceId)
      .forEach((member) => database.moduleInboxItems.push({
        itemId: createId('inbox'),
        moduleId: input.moduleId,
        recipientUserId: member.userId,
        type: 'makeup_approval',
        title: '待审批补卡',
        content: `${currentMember.nickname}申请补记 ${input.recordDate}`,
        targetType: 'makeup_approval',
        targetId: approval.approvalId,
        recordDate: input.recordDate,
        status: 'unread',
        createdAt: now,
        updatedAt: now,
        expireAt: approval.expireAt,
      }));
    activeMembers(module)
      .filter((member) => member.memberInstanceId !== currentMember.memberInstanceId)
      .forEach((member) => database.notifications.push({
        notificationId: createId('notification'),
        userId: member.userId,
        type: 'makeup_approval',
        title: '新的补卡申请',
        content: `「${currentMember.nickname}」申请补记 ${input.recordDate}`,
        moduleId: input.moduleId,
        targetType: 'makeup_approval',
        targetId: approval.approvalId,
        recordDate: input.recordDate,
        actionType: 'approve_makeup',
        actionStatus: 'actionable',
        isRead: false,
        createdAt: now,
        updatedAt: now,
      }));
    addAudit(database, 'submit_makeup', input.moduleId, approval.approvalId);
    return { record, approval };
  });
}

export interface ModuleInboxView extends ModuleInboxItem {
  approval?: MakeupApproval;
  application?: JoinApplication;
  notificationId?: string;
  applicantName?: string;
  stickerPath?: string;
}

export async function getModuleInbox(moduleId: string): Promise<ModuleInboxView[]> {
  await delay(80);
  return updateDatabase((database) => {
    expireBetaState(database);
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    findActiveMember(database, module);
    return database.moduleInboxItems
      .filter((item) => item.moduleId === moduleId && item.recipientUserId === database.currentUser.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => {
        const approval = item.targetType === 'makeup_approval'
          ? database.makeupApprovals.find((candidate) => candidate.approvalId === item.targetId)
          : undefined;
        const applicant = approval
          ? module.members.find((member) => member.memberInstanceId === approval.applicantMemberInstanceId)
          : undefined;
        const record = approval ? database.records.find((candidate) => candidate.recordId === approval.recordId) : undefined;
        const application = item.targetType === 'join_application'
          ? database.joinApplications.find((candidate) => candidate.applicationId === item.targetId)
          : undefined;
        const notification = application ? database.notifications.find((candidate) => candidate.userId === database.currentUser.userId
          && candidate.targetType === 'join_application' && candidate.targetId === application.applicationId) : undefined;
        return { ...item, approval, application, notificationId: notification?.notificationId, applicantName: applicant?.nickname, stickerPath: record?.stickerPath };
      });
  });
}

export function getModuleInboxCount(moduleId: string): number {
  const database = readDatabase();
  return database.moduleInboxItems.filter(
    (item) => item.moduleId === moduleId
      && item.recipientUserId === database.currentUser.userId
      && item.status === 'unread',
  ).length;
}

export async function markModuleInboxRead(itemId: string, _notificationId?: string, _moduleId?: string): Promise<void> {
  await delay(40);
  updateDatabase((database) => {
    const item = database.moduleInboxItems.find(
      (candidate) => candidate.itemId === itemId && candidate.recipientUserId === database.currentUser.userId,
    );
    if (!item || moduleInboxItemRequiresAction(database, item)) return;
    if (item?.status === 'unread') {
      item.status = 'read';
      item.updatedAt = shanghaiNowIso();
    }
    if (hasSynchronizedNotification(item)) {
      database.notifications
        .filter((notification) => notification.userId === database.currentUser.userId
          && notification.targetType === item.targetType && notification.targetId === item.targetId)
        .forEach((notification) => { notification.isRead = true; notification.updatedAt = shanghaiNowIso(); });
    }
  });
}

export async function resolveMakeupApproval(approvalId: string, action: 'approve' | 'reject'): Promise<MakeupApproval> {
  await delay(150);
  return updateDatabase((database) => {
    expireBetaState(database);
    const approval = database.makeupApprovals.find((item) => item.approvalId === approvalId);
    if (!approval) throw new Error('APPROVAL_NOT_FOUND');
    if (approval.status !== 'pending') throw new Error('APPROVAL_ALREADY_RESOLVED');
    const module = database.modules.find((item) => item.moduleId === approval.moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (currentMember.memberInstanceId === approval.applicantMemberInstanceId) throw new Error('APPROVAL_SELF_FORBIDDEN');
    const record = database.records.find((item) => item.recordId === approval.recordId);
    if (!record || record.status !== 'pending') throw new Error('RECORD_STATE_CONFLICT');
    const now = shanghaiNowIso();
    approval.status = action === 'approve' ? 'approved' : 'rejected';
    approval.resolvedAt = now;
    approval.resolvedByUserId = database.currentUser.userId;
    approval.updatedAt = now;
    record.status = action === 'approve' ? 'locked' : 'rejected';
    record.updatedAt = now;
    if (action === 'approve') refreshLocalRecordProjections(database, module, approval.targetDate);
    database.moduleInboxItems
      .filter((item) => item.targetType === 'makeup_approval' && item.targetId === approvalId)
      .forEach((item) => {
        item.type = 'makeup_result';
        item.title = '补卡已处理';
        item.content = `「${currentMember.nickname}」已${action === 'approve' ? '通过' : '拒绝'} ${approval.targetDate} 的补卡申请`;
        item.status = item.recipientUserId === database.currentUser.userId ? 'read' : 'unread';
        item.updatedAt = now;
        item.expireAt = shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      });
    database.notifications
      .filter((notification) => notification.targetType === 'makeup_approval' && notification.targetId === approvalId)
      .forEach((notification) => {
        notification.type = 'makeup_result';
        notification.title = '补卡已处理';
        notification.content = `「${currentMember.nickname}」已${action === 'approve' ? '通过' : '拒绝'} ${approval.targetDate} 的补卡申请`;
        notification.actionType = 'none';
        notification.actionStatus = 'none';
        notification.isRead = notification.userId === database.currentUser.userId;
        notification.updatedAt = now;
      });
    database.moduleInboxItems.push({
      itemId: createId('inbox'),
      moduleId: approval.moduleId,
      recipientUserId: approval.applicantUserId,
      type: 'makeup_result',
      title: action === 'approve' ? '补卡已通过' : '补卡未通过',
      content: `${approval.targetDate} 的补卡${action === 'approve' ? '已经生效' : '已被拒绝'}`,
      targetType: 'record',
      targetId: approval.recordId,
      recordDate: approval.targetDate,
      status: 'unread',
      createdAt: now,
      updatedAt: now,
      expireAt: shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    });
    database.notifications.push({
      notificationId: createId('notification'),
      userId: approval.applicantUserId,
      type: 'makeup_result',
      title: action === 'approve' ? '补卡已通过' : '补卡未通过',
      content: action === 'approve' ? '你的补卡记录已经生效' : '本次补卡申请被拒绝',
      moduleId: approval.moduleId,
      targetType: 'record',
      targetId: approval.recordId,
      recordDate: approval.targetDate,
      actionType: 'none',
      actionStatus: 'none',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
    addAudit(database, `makeup_${action}`, approval.moduleId, approvalId);
    return { ...approval };
  });
}

export async function updateModuleInfo(moduleId: string, name: string, description: string): Promise<LifeModule> {
  await delay(100);
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    if (findActiveMember(database, module).role !== 'creator') throw new Error('CREATOR_REQUIRED');
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName || trimmedName.length > MODULE_NAME_MAX_LENGTH || trimmedDescription.length > MODULE_DESCRIPTION_MAX_LENGTH) {
      throw new Error('MODULE_INPUT_INVALID');
    }
    module.name = trimmedName;
    module.description = trimmedDescription;
    module.updatedAt = shanghaiNowIso();
    addAudit(database, 'update_module', moduleId);
    return { ...module, members: activeMembers(module) };
  });
}

export interface GalleryItem {
  recordId: string;
  recordDate: string;
  memberInstanceId: string;
  displayName: string;
  avatarText: string;
  avatarColor: string;
  avatarUrl?: string;
  isAnonymousExitedMember: boolean;
  remark: string;
  stickerPath: string;
  originalPath: string;
}

export interface GalleryView {
  moduleId: string;
  moduleName: string;
  recordPolicy: LifeModule['recordPolicy'];
  month: string;
  items: GalleryItem[];
}

export async function getModuleGallery(moduleId: string, month: string): Promise<GalleryView> {
  await delay(100);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  const memberSequence = new Map(module.members.map((member) => [member.memberInstanceId, member.joinSequence]));
  const items = database.records
    .filter((record) => record.moduleId === moduleId && record.recordDate.startsWith(month) && isFormalRecord(record))
    .sort((left, right) => right.recordDate.localeCompare(left.recordDate)
      || (memberSequence.get(left.memberInstanceId) ?? 999) - (memberSequence.get(right.memberInstanceId) ?? 999))
    .map<GalleryItem>((record) => {
      const member = module.members.find((item) => item.memberInstanceId === record.memberInstanceId);
      const anonymous = !member?.active;
      return {
        recordId: record.recordId,
        recordDate: record.recordDate,
        memberInstanceId: record.memberInstanceId,
        displayName: anonymous ? '已退出成员' : (member?.nickname ?? '已退出成员'),
        avatarText: anonymous ? '旧' : (member?.avatarText ?? '旧'),
        avatarColor: anonymous ? '#d7d2ca' : (member?.avatarColor ?? '#d7d2ca'),
        avatarUrl: anonymous ? undefined : member?.avatarUrl,
        isAnonymousExitedMember: anonymous,
        remark: record.remark,
        stickerPath: record.stickerPath,
        originalPath: record.originalPath,
      };
    });
  track('gallery_view', { moduleId, month, itemCount: items.length });
  return { moduleId, moduleName: module.name, recordPolicy: module.recordPolicy, month, items };
}

export interface StreakRewardRuleView {
  rules: Array<{
    rule: StreakRewardRule;
    progressDays: number;
    targetMemberName?: string;
  }>;
}

export interface SaveStreakRewardRuleInput {
  targetType: StreakRewardTargetType;
  targetMemberInstanceId?: string;
  streakDays: number;
  prizeTitle: string;
  prizeDescription: string;
  coverMediaId?: string;
  coverPath?: string;
  winProbability: 20 | 50 | 80 | 100;
  termsAccepted: true;
}

export interface PendingStreakReward {
  rewardDrawId: string;
  moduleId: string;
  sponsorName: string;
  targetType: StreakRewardTargetType;
  streakDays: number;
  windowStart: string;
  windowEnd: string;
}

export interface RevealedStreakReward extends PendingStreakReward {
  resultType: 'gift' | 'sticker';
  prizeTitle: string;
  prizeDescription: string;
  stickerPath?: string;
  coverPath?: string;
  stickerRecordDate?: string;
  stickerRemark?: string;
  stickerMemberName?: string;
  revealedAt?: string;
}

export interface ReceivedStreakRewards {
  items: RevealedStreakReward[];
  counts: { all: number; gift: number; sticker: number };
}

export interface StreakRewardPreview {
  pending: PendingStreakReward;
  revealed: RevealedStreakReward;
}

const isNormalFormalRecord = (record: LifeRecord): boolean => record.source === 'normal' && isFormalRecord(record);

function memberIdsForRewardDate(module: LifeModule, date: string): string[] {
  return module.members
    .filter((member) => member.joinedAt.slice(0, 10) <= date && (!member.leftAt || member.leftAt.slice(0, 10) > date))
    .sort((left, right) => left.joinSequence - right.joinSequence)
    .map((member) => member.memberInstanceId);
}

function hasRewardRecord(database: AppDatabase, memberInstanceId: string, date: string): boolean {
  return database.records.some((record) => record.memberInstanceId === memberInstanceId
    && record.recordDate === date && isNormalFormalRecord(record));
}

function sameMemberSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((memberId, index) => memberId === right[index]);
}

function ruleQualifies(
  database: AppDatabase,
  module: LifeModule,
  rule: StreakRewardRule,
  endDate: string,
  triggerMemberInstanceId: string,
): { memberIds: string[]; windowStart: string } | undefined {
  const windowStart = addDays(endDate, 1 - rule.streakDays);
  if (rule.targetType === 'member') {
    const memberId = rule.targetMemberInstanceId;
    if (!memberId || triggerMemberInstanceId !== memberId) return undefined;
    for (let offset = 0; offset < rule.streakDays; offset += 1) {
      const date = addDays(windowStart, offset);
      if (!memberIdsForRewardDate(module, date).includes(memberId) || !hasRewardRecord(database, memberId, date)) return undefined;
    }
    return { memberIds: [memberId], windowStart };
  }

  const expected = memberIdsForRewardDate(module, windowStart);
  if (expected.length < 2) return undefined;
  for (let offset = 0; offset < rule.streakDays; offset += 1) {
    const date = addDays(windowStart, offset);
    const memberIds = memberIdsForRewardDate(module, date);
    if (!sameMemberSet(expected, memberIds) || memberIds.some((memberId) => !hasRewardRecord(database, memberId, date))) return undefined;
  }
  return { memberIds: expected, windowStart };
}

function evaluateLocalStreakRewards(database: AppDatabase, module: LifeModule, triggerRecord: LifeRecord): void {
  if (module.recordPolicy !== 'strict' || triggerRecord.source !== 'normal'
    || triggerRecord.recordDate !== shanghaiDate() || !isFormalRecord(triggerRecord)) return;
  const now = shanghaiNowIso();
  database.streakRewardRules
    .filter((rule) => rule.moduleId === module.moduleId && rule.status === 'active')
    .forEach((rule) => {
      if (rule.expiresAt <= now) {
        rule.status = 'expired';
        rule.updatedAt = now;
        return;
      }
      if (rule.createdAt > triggerRecord.firstEffectiveAt) return;
      const qualification = ruleQualifies(
        database,
        module,
        rule,
        triggerRecord.recordDate,
        triggerRecord.memberInstanceId,
      );
      if (!qualification) return;
      const sponsor = module.members.find((member) => member.memberInstanceId === rule.sponsorMemberInstanceId);
      const event = {
        rewardEventId: createId('reward_event'),
        rewardRuleId: rule.rewardRuleId,
        moduleId: module.moduleId,
        triggerRecordId: triggerRecord.recordId,
        sponsorNameSnapshot: sponsor?.nickname ?? '一位伙伴',
        targetType: rule.targetType,
        coverPathSnapshot: rule.coverPath,
        prizeTitleSnapshot: rule.prizeTitle,
        prizeDescriptionSnapshot: rule.prizeDescription,
        winProbability: rule.winProbability,
        windowStart: qualification.windowStart,
        windowEnd: triggerRecord.recordDate,
        createdAt: now,
      };
      database.streakRewardEvents.push(event);
      qualification.memberIds.forEach((memberInstanceId) => {
        const recipient = module.members.find((member) => member.memberInstanceId === memberInstanceId);
        if (!recipient) return;
        const stickerRecord = database.records
          .filter((record) => record.memberInstanceId === memberInstanceId
            && record.recordDate >= qualification.windowStart && record.recordDate <= triggerRecord.recordDate
            && isNormalFormalRecord(record))
          .sort((left, right) => right.recordDate.localeCompare(left.recordDate))[0];
        const draw: StreakRewardDraw = {
          rewardDrawId: createId('reward_draw'),
          rewardEventId: event.rewardEventId,
          moduleId: module.moduleId,
          recipientUserId: recipient.userId,
          recipientMemberInstanceId: memberInstanceId,
          resultType: Math.random() * 100 < rule.winProbability ? 'gift' : 'sticker',
          stickerRecordId: stickerRecord?.recordId,
          status: 'sealed',
          createdAt: now,
          updatedAt: now,
        };
        database.streakRewardDraws.push(draw);
      });
      rule.status = 'triggered';
      rule.triggeredAt = now;
      rule.updatedAt = now;
    });
}

function rewardProgressDays(database: AppDatabase, module: LifeModule, rule: StreakRewardRule): number {
  let cursor = shanghaiDate();
  const isComplete = (date: string): boolean => {
    if (rule.targetType === 'member') {
      return Boolean(rule.targetMemberInstanceId && memberIdsForRewardDate(module, date).includes(rule.targetMemberInstanceId)
        && hasRewardRecord(database, rule.targetMemberInstanceId, date));
    }
    const members = memberIdsForRewardDate(module, date);
    return members.length >= 2 && members.every((memberId) => hasRewardRecord(database, memberId, date));
  };
  if (!isComplete(cursor)) cursor = addDays(cursor, -1);
  const baseline = memberIdsForRewardDate(module, cursor);
  let days = 0;
  while (days < rule.streakDays && isComplete(cursor)) {
    if (rule.targetType === 'all' && !sameMemberSet(baseline, memberIdsForRewardDate(module, cursor))) break;
    days += 1;
    cursor = addDays(cursor, -1);
  }
  return days;
}

export async function getMyStreakRewardRule(moduleId: string): Promise<StreakRewardRuleView> {
  await delay(60);
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    const now = shanghaiNowIso();
    const rules = database.streakRewardRules
      .filter((item) => item.moduleId === moduleId && item.sponsorMemberInstanceId === currentMember.memberInstanceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    rules.forEach((rule) => {
      if (rule.status === 'active' && rule.expiresAt <= now) {
        rule.status = 'expired';
        rule.updatedAt = now;
      }
    });
    return { rules: rules.map((rule) => ({
      rule,
      progressDays: rule.status === 'active' ? rewardProgressDays(database, module, rule) : 0,
      targetMemberName: rule.targetMemberInstanceId
        ? module.members.find((member) => member.memberInstanceId === rule.targetMemberInstanceId)?.nickname
        : undefined,
    })) };
  });
}

export async function saveStreakRewardRule(
  moduleId: string,
  input: SaveStreakRewardRuleInput,
): Promise<StreakRewardRuleView> {
  await delay(100);
  updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const sponsor = findActiveMember(database, module);
    if (module.recordPolicy !== 'strict') throw new Error('REWARD_STRICT_ONLY');
    const title = input.prizeTitle.trim();
    const description = input.prizeDescription.trim();
    if (!title || title.length > 20 || description.length > 80) throw new Error('REWARD_CONTENT_INVALID');
    if (![20, 50, 80, 100].includes(input.winProbability)) throw new Error('REWARD_PROBABILITY_INVALID');
    if (!Number.isInteger(input.streakDays) || input.streakDays < 1 || input.streakDays > 100) throw new Error('REWARD_DAYS_INVALID');
    if (input.termsAccepted !== true) throw new Error('REWARD_TERMS_REQUIRED');
    if (input.targetType === 'all' && activeMembers(module).length < 2) throw new Error('REWARD_ALL_NEEDS_GROUP');
    if (input.targetType === 'member'
      && !module.members.some((member) => member.active && member.memberInstanceId === input.targetMemberInstanceId)) {
      throw new Error('REWARD_TARGET_INVALID');
    }
    const now = shanghaiNowIso();
    database.streakRewardRules.push({
      rewardRuleId: createId('reward_rule'),
      moduleId,
      sponsorUserId: database.currentUser.userId,
      sponsorMemberInstanceId: sponsor.memberInstanceId,
      targetType: input.targetType,
      targetMemberInstanceId: input.targetType === 'member' ? input.targetMemberInstanceId : undefined,
      prizeTitle: title,
      prizeDescription: description,
      coverMediaId: input.coverMediaId,
      coverPath: input.coverPath,
      winProbability: input.winProbability,
      streakDays: input.streakDays,
      status: 'active',
      expiresAt: shanghaiNowIso(new Date(Date.now() + 90 * 86_400_000)),
      createdAt: now,
      updatedAt: now,
    });
    addAudit(database, 'save_streak_reward', moduleId);
  });
  track('streak_reward_rule_saved', { moduleId, targetType: input.targetType, probability: input.winProbability });
  return getMyStreakRewardRule(moduleId);
}

export async function cancelStreakRewardRule(moduleId: string, rewardRuleId: string): Promise<void> {
  await delay(80);
  updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const sponsor = findActiveMember(database, module);
    const now = shanghaiNowIso();
    const rule = database.streakRewardRules.find((item) => item.rewardRuleId === rewardRuleId
      && item.moduleId === moduleId && item.sponsorMemberInstanceId === sponsor.memberInstanceId);
    if (rule?.status === 'active') {
      rule.status = 'cancelled';
      rule.cancelledAt = now;
      rule.updatedAt = now;
    }
    addAudit(database, 'cancel_streak_reward', moduleId);
  });
}

export async function previewStreakReward(moduleId: string, rewardRuleId: string): Promise<StreakRewardPreview> {
  await delay(80);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  const sponsor = findActiveMember(database, module);
  if (module.recordPolicy !== 'strict') throw new Error('REWARD_STRICT_ONLY');
  const rule = database.streakRewardRules.find((item) => item.rewardRuleId === rewardRuleId
    && item.moduleId === moduleId && item.sponsorMemberInstanceId === sponsor.memberInstanceId
    && item.status === 'active');
  if (!rule) throw new Error('REWARD_RULE_NOT_ACTIVE');

  const recipientMemberId = rule.targetType === 'member'
    ? rule.targetMemberInstanceId
    : sponsor.memberInstanceId;
  const sticker = database.records
    .filter((record) => record.moduleId === moduleId && record.memberInstanceId === recipientMemberId
      && isNormalFormalRecord(record))
    .sort((left, right) => right.recordDate.localeCompare(left.recordDate))[0];
  const rewardDrawId = createId('reward_preview');
  const windowEnd = shanghaiDate();
  const windowStart = addDays(windowEnd, 1 - rule.streakDays);
  const resultType = Math.random() * 100 < rule.winProbability ? 'gift' : 'sticker';
  const pending: PendingStreakReward = {
    rewardDrawId,
    moduleId,
    sponsorName: sponsor.nickname,
    targetType: rule.targetType,
    streakDays: rule.streakDays,
    windowStart,
    windowEnd,
  };
  return {
    pending,
    revealed: {
      ...pending,
      resultType,
      prizeTitle: resultType === 'gift' ? rule.prizeTitle : `${rule.streakDays}日纪念贴`,
      prizeDescription: resultType === 'gift' ? rule.prizeDescription : `把这${rule.streakDays}天收进口袋`,
      stickerPath: resultType === 'sticker' ? sticker?.stickerPath : undefined,
      coverPath: resultType === 'gift' ? rule.coverPath : undefined,
      stickerRecordDate: resultType === 'sticker' ? sticker?.recordDate : undefined,
      stickerRemark: resultType === 'sticker' ? sticker?.remark : undefined,
      stickerMemberName: resultType === 'sticker'
        ? module.members.find((member) => member.memberInstanceId === sticker?.memberInstanceId)?.nickname
        : undefined,
    },
  };
}

export async function getPendingStreakReward(moduleId: string): Promise<PendingStreakReward | undefined> {
  return (await getPendingStreakRewards(moduleId))[0];
}

export async function getPendingStreakRewards(moduleId: string): Promise<PendingStreakReward[]> {
  await delay(50);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  const draws = database.streakRewardDraws
    .filter((item) => item.moduleId === moduleId && item.recipientUserId === database.currentUser.userId
      && item.status === 'sealed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return draws.flatMap((draw) => {
    const event = database.streakRewardEvents.find((item) => item.rewardEventId === draw.rewardEventId);
    if (!event) return [];
    return [{
      rewardDrawId: draw.rewardDrawId,
      moduleId,
      sponsorName: event.sponsorNameSnapshot,
      targetType: event.targetType,
      streakDays: database.streakRewardRules.find((rule) => rule.rewardRuleId === event.rewardRuleId)?.streakDays ?? 7,
      windowStart: event.windowStart,
      windowEnd: event.windowEnd,
    }];
  });
}

export async function revealStreakReward(rewardDrawId: string): Promise<RevealedStreakReward> {
  await delay(180);
  return updateDatabase((database) => {
    const draw = database.streakRewardDraws.find((item) => item.rewardDrawId === rewardDrawId
      && item.recipientUserId === database.currentUser.userId);
    if (!draw) throw new Error('REWARD_DRAW_NOT_FOUND');
    const event = database.streakRewardEvents.find((item) => item.rewardEventId === draw.rewardEventId);
    if (!event) throw new Error('REWARD_EVENT_NOT_FOUND');
    const streakDays = database.streakRewardRules.find((rule) => rule.rewardRuleId === event.rewardRuleId)?.streakDays ?? 7;
    if (draw.status === 'sealed') {
      const now = shanghaiNowIso();
      draw.status = 'revealed';
      draw.revealedAt = now;
      draw.updatedAt = now;
      database.notifications.push({
        notificationId: createId('notification'),
        userId: database.currentUser.userId,
        type: 'reward_result',
        title: draw.resultType === 'gift' ? '连续打卡惊喜' : `${streakDays}日纪念贴`,
        content: draw.resultType === 'gift' ? `你获得了「${event.prizeTitleSnapshot}」` : `你收下了一张${streakDays}日纪念贴`,
        moduleId: draw.moduleId,
        targetType: 'reward_draw',
        targetId: draw.rewardDrawId,
        actionType: 'none',
        actionStatus: 'none',
        isRead: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    const sticker = draw.stickerRecordId
      ? database.records.find((record) => record.recordId === draw.stickerRecordId)
      : undefined;
    return {
      rewardDrawId: draw.rewardDrawId,
      moduleId: draw.moduleId,
      sponsorName: event.sponsorNameSnapshot,
      targetType: event.targetType,
      streakDays,
      windowStart: event.windowStart,
      windowEnd: event.windowEnd,
      resultType: draw.resultType,
      prizeTitle: draw.resultType === 'gift' ? event.prizeTitleSnapshot : `${streakDays}日纪念贴`,
      prizeDescription: draw.resultType === 'gift' ? event.prizeDescriptionSnapshot : `把这${streakDays}天收进口袋`,
      stickerPath: sticker?.stickerPath,
      coverPath: draw.resultType === 'gift' ? event.coverPathSnapshot : undefined,
      stickerRecordDate: draw.resultType === 'sticker' ? sticker?.recordDate : undefined,
      stickerRemark: draw.resultType === 'sticker' ? sticker?.remark : undefined,
      stickerMemberName: draw.resultType === 'sticker'
        ? database.modules.find((item) => item.moduleId === draw.moduleId)?.members
          .find((member) => member.memberInstanceId === sticker?.memberInstanceId)?.nickname
        : undefined,
      revealedAt: draw.revealedAt,
    };
  });
}

export async function getReceivedStreakRewards(moduleId: string): Promise<ReceivedStreakRewards> {
  await delay(60);
  const database = readDatabase();
  const module = database.modules.find((item) => item.moduleId === moduleId);
  if (!module) throw new Error('MODULE_NOT_FOUND');
  findActiveMember(database, module);
  const items = database.streakRewardDraws
    .filter((draw) => draw.moduleId === moduleId && draw.recipientUserId === database.currentUser.userId
      && draw.status === 'revealed')
    .sort((left, right) => (right.revealedAt ?? right.createdAt).localeCompare(left.revealedAt ?? left.createdAt))
    .flatMap((draw) => {
      const event = database.streakRewardEvents.find((entry) => entry.rewardEventId === draw.rewardEventId);
      if (!event) return [];
      const rule = database.streakRewardRules.find((entry) => entry.rewardRuleId === event.rewardRuleId);
      const sticker = draw.stickerRecordId
        ? database.records.find((record) => record.recordId === draw.stickerRecordId) : undefined;
      const streakDays = rule?.streakDays ?? 7;
      return [{
        rewardDrawId: draw.rewardDrawId,
        moduleId,
        sponsorName: event.sponsorNameSnapshot,
        targetType: event.targetType,
        streakDays,
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        resultType: draw.resultType,
        prizeTitle: draw.resultType === 'gift' ? event.prizeTitleSnapshot : `${streakDays}日纪念贴`,
        prizeDescription: draw.resultType === 'gift' ? event.prizeDescriptionSnapshot : `把这${streakDays}天收进口袋`,
        stickerPath: draw.resultType === 'sticker' ? sticker?.stickerPath : undefined,
        coverPath: draw.resultType === 'gift' ? event.coverPathSnapshot : undefined,
        stickerRecordDate: sticker?.recordDate,
        stickerRemark: sticker?.remark,
        stickerMemberName: module.members.find((member) => member.memberInstanceId === sticker?.memberInstanceId)?.nickname,
        revealedAt: draw.revealedAt,
      } satisfies RevealedStreakReward];
    });
  return {
    items,
    counts: {
      all: items.length,
      gift: items.filter((item) => item.resultType === 'gift').length,
      sticker: items.filter((item) => item.resultType === 'sticker').length,
    },
  };
}

export interface ReminderView extends ReminderSubscription {
  moduleName: string;
  checkinNotificationsEnabled: boolean;
  checkinNotificationStatus: NonNullable<ReminderSubscription['checkinNotificationStatus']>;
  checkinNotificationCredits: number;
}

export async function getModuleReminder(moduleId: string): Promise<ReminderView> {
  await delay(60);
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    findActiveMember(database, module);
    let reminder = database.reminders.find(
      (item) => item.moduleId === moduleId && item.userId === database.currentUser.userId,
    );
    if (!reminder) {
      const now = shanghaiNowIso();
      reminder = {
        reminderId: createId('reminder'),
        moduleId,
        userId: database.currentUser.userId,
        enabled: false,
        reminderTime: '21:00',
        inAppEnabled: true,
        subscriptionStatus: 'not_requested',
        paused: false,
        createdAt: now,
        updatedAt: now,
      };
      database.reminders.push(reminder);
    }
    return {
      ...reminder,
      checkinNotificationsEnabled: Boolean(reminder.checkinNotificationsEnabled),
      checkinNotificationStatus: reminder.checkinNotificationStatus ?? 'not_requested',
      checkinNotificationCredits: reminder.checkinNotificationCredits ?? 0,
      moduleName: module.name,
    };
  });
}

export interface UpdateReminderInput {
  enabled: boolean;
  reminderTime: string;
  inAppEnabled: boolean;
  subscriptionStatus: ReminderSubscriptionStatus;
}

export async function updateModuleReminder(moduleId: string, input: UpdateReminderInput): Promise<ReminderView> {
  await delay(90);
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    findActiveMember(database, module);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reminderTime)) throw new Error('REMINDER_TIME_INVALID');
    const now = shanghaiNowIso();
    let reminder = database.reminders.find(
      (item) => item.moduleId === moduleId && item.userId === database.currentUser.userId,
    );
    if (!reminder) {
      reminder = {
        reminderId: createId('reminder'),
        moduleId,
        userId: database.currentUser.userId,
        createdAt: now,
        updatedAt: now,
        paused: false,
        ...input,
      };
      database.reminders.push(reminder);
    } else {
      Object.assign(reminder, input, { paused: false, updatedAt: now });
    }
    addAudit(database, 'update_reminder', moduleId, reminder.reminderId);
    track('reminder_update_success', { moduleId, enabled: input.enabled, subscriptionStatus: input.subscriptionStatus });
    return {
      ...reminder,
      checkinNotificationsEnabled: Boolean(reminder.checkinNotificationsEnabled),
      checkinNotificationStatus: reminder.checkinNotificationStatus ?? 'not_requested',
      checkinNotificationCredits: reminder.checkinNotificationCredits ?? 0,
      moduleName: module.name,
    };
  });
}

export async function updateCheckinNotificationSubscription(
  moduleId: string,
  enabled: boolean,
): Promise<ReminderView> {
  await delay(80);
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    findActiveMember(database, module);
    if (module.mode !== 'group') throw new Error('GROUP_MODULE_REQUIRED');
    const now = shanghaiNowIso();
    let reminder = database.reminders.find(
      (item) => item.moduleId === moduleId && item.userId === database.currentUser.userId,
    );
    if (!reminder) {
      reminder = {
        reminderId: createId('reminder'),
        moduleId,
        userId: database.currentUser.userId,
        enabled: false,
        reminderTime: '21:00',
        inAppEnabled: true,
        subscriptionStatus: 'not_requested',
        paused: false,
        createdAt: now,
        updatedAt: now,
      };
      database.reminders.push(reminder);
    }
    const credits = enabled ? Math.min(20, (reminder.checkinNotificationCredits ?? 0) + 1) : 0;
    Object.assign(reminder, {
      checkinNotificationsEnabled: enabled,
      checkinNotificationStatus: enabled ? 'authorized' : 'disabled',
      checkinNotificationCredits: credits,
      updatedAt: now,
    });
    return {
      ...reminder,
      checkinNotificationsEnabled: enabled,
      checkinNotificationStatus: reminder.checkinNotificationStatus ?? 'not_requested',
      checkinNotificationCredits: credits,
      moduleName: module.name,
    };
  });
}

export function runInAppReminderScan(now = new Date()): number {
  return updateDatabase((database) => {
    purgeExpiredModules(database);
    const today = shanghaiDate(now);
    const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const currentTime = shifted.toISOString().slice(11, 16);
    let delivered = 0;
    const deliveredToUser = new Map<string, number>();
    database.reminders.forEach((reminder) => {
      if (!reminder.enabled || !reminder.inAppEnabled || reminder.paused || reminder.lastSentDate === today) return;
      if (reminder.reminderTime > currentTime) return;
      const module = database.modules.find((item) => item.moduleId === reminder.moduleId && item.status === 'active');
      if (!module?.members.some((member) => member.userId === reminder.userId && member.active)) return;
      const hasRecord = database.records.some(
        (record) => record.moduleId === reminder.moduleId && record.userId === reminder.userId
          && record.recordDate === today && isFormalRecord(record),
      );
      if (hasRecord) return;
      const userCount = deliveredToUser.get(reminder.userId) ?? 0;
      if (userCount >= 3) return;
      const createdAt = shanghaiNowIso(now);
      database.notifications.push({
        notificationId: createId('notification'),
        userId: reminder.userId,
        type: 'reminder',
        title: '今天还没有记录',
        content: `「${module.name}」正在等你留下今天的照片`,
        moduleId: module.moduleId,
        targetType: 'module',
        targetId: module.moduleId,
        actionType: 'none',
        actionStatus: 'none',
        isRead: false,
        createdAt,
        updatedAt: createdAt,
      });
      reminder.lastSentDate = today;
      reminder.updatedAt = createdAt;
      deliveredToUser.set(reminder.userId, userCount + 1);
      delivered += 1;
    });
    return delivered;
  });
}

export interface RecycleModuleView {
  moduleId: string;
  name: string;
  memberCount: number;
  deletedAt: string;
  recycleExpireAt: string;
  remainingDays: number;
}

export async function deleteModuleToRecycle(moduleId: string, _confirmationName?: string): Promise<void> {
  await delay(160);
  updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    const currentMember = findActiveMember(database, module);
    if (currentMember.role !== 'creator') throw new Error('CREATOR_REQUIRED');
    const now = shanghaiNowIso();
    module.status = 'pending_delete';
    module.deletedAt = now;
    module.recycleExpireAt = shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    module.updatedAt = now;
    database.makeupApprovals.filter((item) => item.moduleId === moduleId && item.status === 'pending').forEach((approval) => {
      approval.status = 'cancelled';
      approval.updatedAt = now;
      const record = database.records.find((item) => item.recordId === approval.recordId);
      if (record?.status === 'pending') {
        record.status = 'cancelled';
        record.updatedAt = now;
      }
    });
    database.joinApplications.filter((item) => item.moduleId === moduleId && item.status === 'pending').forEach((item) => {
      item.status = 'cancelled';
      item.resolutionReason = 'module_pending_delete';
      item.updatedAt = now;
    });
    database.inviteTokens.filter((item) => item.moduleId === moduleId && item.status === 'active').forEach((item) => {
      item.status = 'invalid_module';
      item.updatedAt = now;
    });
    database.reminders.filter((item) => item.moduleId === moduleId).forEach((item) => {
      item.paused = true;
      item.updatedAt = now;
    });
    database.notifications.filter((item) => item.moduleId === moduleId && item.actionStatus === 'actionable').forEach((item) => {
      item.actionStatus = 'expired';
      item.updatedAt = now;
    });
    database.moduleInboxItems.filter((item) => item.moduleId === moduleId && !['resolved', 'expired'].includes(item.status)).forEach((item) => {
      item.status = 'resolved';
      item.updatedAt = now;
    });
    database.monthlyMemoryCards = database.monthlyMemoryCards.filter((item) => item.moduleId !== moduleId);
    activeMembers(module).forEach((member) => database.notifications.push({
      notificationId: createId('notification'),
      userId: member.userId,
      type: 'module_state',
      title: '模块已进入回收期',
      content: `「${module.name}」将在7天后永久删除${member.role === 'creator' ? '，你可以在回收站恢复' : ''}`,
      moduleId,
      targetType: 'module',
      targetId: moduleId,
      actionType: 'none',
      actionStatus: 'none',
      isRead: member.userId === database.currentUser.userId,
      createdAt: now,
      updatedAt: now,
    }));
    addAudit(database, 'module_enter_recycle', moduleId);
  });
  track('module_delete_success', { moduleId, recycleDays: 7 });
}

export async function getRecycleBin(): Promise<RecycleModuleView[]> {
  await delay(70);
  return updateDatabase((database) => {
    purgeExpiredModules(database);
    return database.modules
      .filter((module) => module.status === 'pending_delete' && module.creatorUserId === database.currentUser.userId
        && module.deletedAt && module.recycleExpireAt)
      .sort((left, right) => right.deletedAt!.localeCompare(left.deletedAt!))
      .map((module) => ({
        moduleId: module.moduleId,
        name: module.name,
        memberCount: activeMembers(module).length,
        deletedAt: module.deletedAt!,
        recycleExpireAt: module.recycleExpireAt!,
        remainingDays: Math.max(1, Math.ceil((Date.parse(module.recycleExpireAt!) - Date.now()) / 86_400_000)),
      }));
  });
}

export async function restoreRecycledModule(moduleId: string): Promise<LifeModule> {
  await delay(130);
  return updateDatabase((database) => {
    purgeExpiredModules(database);
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    if (module.status !== 'pending_delete') throw new Error('MODULE_NOT_PENDING_DELETE');
    if (module.creatorUserId !== database.currentUser.userId) throw new Error('CREATOR_REQUIRED');
    const now = shanghaiNowIso();
    module.status = 'active';
    module.deletedAt = undefined;
    module.recycleExpireAt = undefined;
    module.updatedAt = now;
    database.reminders.filter((item) => item.moduleId === moduleId).forEach((item) => {
      item.paused = false;
      item.lastSentDate = undefined;
      item.updatedAt = now;
    });
    addAudit(database, 'module_restore', moduleId);
    track('module_restore_success', { moduleId });
    return { ...module, members: activeMembers(module) };
  });
}

function snapshotMembersForDate(module: LifeModule, recordDate: string): ModuleMember[] {
  return module.members.filter((member) => {
    const joinedDate = member.joinedAt.slice(0, 10);
    const leftDate = member.leftAt?.slice(0, 10);
    return joinedDate <= recordDate && (!leftDate || leftDate > recordDate);
  });
}

function ensureSnapshotForDate(database: AppDatabase, module: LifeModule, recordDate: string): DailyModuleSnapshot {
  const now = shanghaiNowIso();
  let snapshot = database.dailySnapshots.find((item) => item.moduleId === module.moduleId && item.recordDate === recordDate);
  const members = snapshot
    ? module.members.filter((member) => snapshot!.memberInstanceIds.includes(member.memberInstanceId))
    : snapshotMembersForDate(module, recordDate);
  const memberIds = members.map((member) => member.memberInstanceId);
  const completed = new Set(database.records
    .filter((record) => record.moduleId === module.moduleId && record.recordDate === recordDate
      && memberIds.includes(record.memberInstanceId) && isFormalRecord(record))
    .map((record) => record.memberInstanceId)).size;
  if (!snapshot) {
    snapshot = {
      snapshotId: createId('snapshot'),
      moduleId: module.moduleId,
      recordDate,
      memberInstanceIds: memberIds,
      requiredMemberCount: memberIds.length,
      completedMemberCount: completed,
      isAllCompleted: memberIds.length > 0 && completed === memberIds.length,
      calculatedAt: now,
      updatedAt: now,
    };
    database.dailySnapshots.push(snapshot);
  } else {
    snapshot.completedMemberCount = completed;
    snapshot.isAllCompleted = snapshot.requiredMemberCount > 0 && completed === snapshot.requiredMemberCount;
    snapshot.updatedAt = now;
  }
  return snapshot;
}

function invalidateLocalMemoryCard(database: AppDatabase, moduleId: string, month: string): void {
  const now = shanghaiNowIso();
  database.monthlyMemoryCards
    .filter((card) => card.moduleId === moduleId && card.month === month)
    .forEach((card) => {
      card.dataVersion = '';
      card.updatedAt = now;
    });
}

function refreshLocalRecordProjections(database: AppDatabase, module: LifeModule, recordDate: string): void {
  if (recordDate < shanghaiDate()) ensureSnapshotForDate(database, module, recordDate);
  invalidateLocalMemoryCard(database, module.moduleId, recordDate.slice(0, 7));
}

function ensureDailySnapshots(database: AppDatabase): void {
  database.modules.filter((module) => module.status === 'active').forEach((module) => {
    const dates = new Set(database.records
      .filter((record) => record.moduleId === module.moduleId && record.recordDate < shanghaiDate() && isFormalRecord(record))
      .map((record) => record.recordDate));
    dates.forEach((date) => ensureSnapshotForDate(database, module, date));
  });
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const result = [...items];
  let state = stableHash(seed) || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function selectFairMemoryRecords(records: LifeRecord[], seed: string): LifeRecord[] {
  const groups = new Map<string, LifeRecord[]>();
  records.forEach((record) => groups.set(record.memberInstanceId, [...(groups.get(record.memberInstanceId) ?? []), record]));
  const memberIds = deterministicShuffle([...groups.keys()], `${seed}:members`);
  const smallestGroupSize = Math.min(...[...groups.values()].map((group) => group.length));
  const perMemberLimit = smallestGroupSize + 1;
  const queues = new Map(memberIds.map((memberId) => [
    memberId,
    deterministicShuffle(groups.get(memberId) ?? [], `${seed}:${memberId}`).slice(0, perMemberLimit),
  ]));
  const selected: LifeRecord[] = [];
  while (selected.length < 8) {
    let added = false;
    memberIds.forEach((memberId) => {
      if (selected.length >= 8) return;
      const next = queues.get(memberId)?.shift();
      if (next) {
        selected.push(next);
        added = true;
      }
    });
    if (!added) break;
  }
  return selected;
}

export type MemoryReportMode = 'week' | 'month';
export interface MemoryModuleOption { moduleId: string; name: string }
export interface MemoryStickerItem {
  recordId: string;
  moduleId: string;
  recordDate: string;
  stickerPath: string;
  displayOrder: number;
}
export interface MemoryFootprintItem {
  date: string;
  recordCount: number;
  level: number;
  stickerPath?: string;
}
export type MemoryCollageAssetType = 'record_sticker' | 'decorative_sticker';
export interface MemoryCollageItem {
  itemId: string;
  assetType: MemoryCollageAssetType;
  recordId?: string;
  moduleId?: string;
  recordDate?: string;
  stickerAssetId?: string;
  name?: string;
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
}
export interface MemoryCollageBoardAsset {
  boardAssetId: string;
  name: string;
  category?: string;
  thumbnailPath: string;
  imagePath: string;
  editableBounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}
export interface MemoryCollageStickerAsset {
  stickerAssetId: string;
  name: string;
  category: string;
  thumbnailPath: string;
  imagePath: string;
  defaultWidth: number;
  defaultHeight: number;
}
export interface SavedMemoryCollage {
  collageId: string;
  version: number;
  savedAt: string;
  board: MemoryCollageBoardAsset | null;
  items: MemoryCollageItem[];
}
export interface MemoryCollageView {
  reportMode: MemoryReportMode;
  periodKey: string;
  scopeKey: string;
  moduleId: string;
  moduleName: string;
  collage: SavedMemoryCollage | null;
  availableRecordStickers: MemoryStickerItem[];
  boards: MemoryCollageBoardAsset[];
  decorativeStickers: MemoryCollageStickerAsset[];
  decorativeStickerCategories: string[];
}
export interface SaveMemoryCollageInput {
  moduleId?: string;
  reportMode: MemoryReportMode;
  periodKey: string;
  boardAssetId?: string;
  baseVersion: number;
  force?: boolean;
  items: Array<{
    assetType: MemoryCollageAssetType;
    recordId?: string;
    stickerAssetId?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    zIndex: number;
  }>;
}
export interface MemoryView {
  reportMode: MemoryReportMode;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  isCurrentPeriod: boolean;
  momentCount: number;
  previousMomentCount: number;
  recordedDays: number;
  previousRecordedDays: number;
  participatedModuleCount: number;
  jointCompletedDays: number;
  previousJointCompletedDays: number;
  hasPartnerModules: boolean;
  longestStreakDays: number;
  previousLongestStreakDays: number;
  currentStreakDays: number;
  currentStreakOngoing: boolean;
  earliestTime?: string;
  latestTime?: string;
  receivedReactionCount: number;
  weeklyRecordCount: number;
  moduleId: string;
  moduleName: string;
  month: string;
  modules: MemoryModuleOption[];
  items: MemoryStickerItem[];
  footprint: MemoryFootprintItem[];
  monthlyJointCompletedDays: number;
  monthlyReceivedReactionCount: number;
  mostUsedEmoji: string;
  latestStickerPath?: string;
  collage?: SavedMemoryCollage | null;
}

export async function getMemoryCollage(
  _moduleId: string | undefined,
  _periodKey: string,
  _reportMode: MemoryReportMode,
): Promise<MemoryCollageView> {
  throw new Error('REMOTE_DATA_REQUIRED');
}

export async function saveMemoryCollage(_input: SaveMemoryCollageInput): Promise<MemoryCollageView> {
  throw new Error('REMOTE_DATA_REQUIRED');
}

function calculateCurrentStreak(recordDates: Set<string>): number {
  let cursor = shanghaiDate();
  if (!recordDates.has(cursor)) cursor = addDays(cursor, -1);
  let streak = 0;
  while (recordDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function getModuleMonthSummary(moduleId: string, month: string): {
  currentUserRecordedDays: number;
  jointCompletedDays: number;
  receivedReactionCount: number;
} {
  return updateDatabase((database) => {
    const module = database.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new Error('MODULE_NOT_FOUND');
    findActiveMember(database, module);
    ensureDailySnapshots(database);
    const currentRecords = database.records.filter((record) => record.moduleId === moduleId
      && record.userId === database.currentUser.userId && record.recordDate.startsWith(month)
      && record.recordDate <= shanghaiDate() && isFormalRecord(record));
    const recordIds = new Set(currentRecords.map((record) => record.recordId));
    return {
      currentUserRecordedDays: new Set(currentRecords.map((record) => record.recordDate)).size,
      jointCompletedDays: database.dailySnapshots.filter((snapshot) => snapshot.moduleId === moduleId
        && snapshot.recordDate.startsWith(month) && snapshot.isAllCompleted).length,
      receivedReactionCount: database.reactions.filter((reaction) => reaction.status === 'active' && recordIds.has(reaction.recordId)).length,
    };
  });
}

export async function refreshModuleMonthSummary(moduleId: string, month: string) {
  return getModuleMonthSummary(moduleId, month);
}

function resolveMemoryCard(database: AppDatabase, moduleId: string, month: string, forceChange: boolean): MonthlyMemoryCard {
  const candidates = database.records
    .filter((record) => record.moduleId === moduleId && record.recordDate.startsWith(month)
      && record.recordDate <= shanghaiDate() && isFormalRecord(record));
  const dataVersion = candidates.map((record) => `${record.recordId}:${record.updatedAt}`).sort().join('|');
  let card = database.monthlyMemoryCards.find(
    (item) => item.userId === database.currentUser.userId && item.moduleId === moduleId && item.month === month,
  );
  const generation = forceChange ? (card?.generation ?? 0) + 1 : (card?.generation ?? 0);
  if (!card || card.dataVersion !== dataVersion || forceChange) {
    const selected = selectFairMemoryRecords(candidates, `${database.currentUser.userId}:${moduleId}:${month}:${generation}`);
    const now = shanghaiNowIso();
    if (!card) {
      card = {
        memoryCardId: createId('memory'),
        userId: database.currentUser.userId,
        moduleId,
        month,
        recordIds: selected.map((record) => record.recordId),
        dataVersion,
        generation,
        createdAt: now,
        updatedAt: now,
      };
      database.monthlyMemoryCards.push(card);
    } else {
      card.recordIds = selected.map((record) => record.recordId);
      card.dataVersion = dataVersion;
      card.generation = generation;
      card.updatedAt = now;
    }
  }
  return card;
}

const localMemoryGeneration = new Map<string, number>();

export async function getMemoryView(
  moduleId?: string,
  periodInput = shanghaiDate().slice(0, 7),
  forceChange = false,
  reportMode: MemoryReportMode = 'month',
  allModules = false,
): Promise<MemoryView> {
  await delay(110);
  return updateDatabase((database) => {
    purgeExpiredModules(database);
    ensureDailySnapshots(database);
    const modules = database.modules.filter((module) => module.status === 'active'
      && module.members.some((member) => member.userId === database.currentUser.userId && member.active));
    const recentModuleId = database.records
      .filter((record) => record.recordDate <= shanghaiDate() && isFormalRecord(record)
        && modules.some((module) => module.moduleId === record.moduleId))
      .sort((left, right) => right.firstEffectiveAt.localeCompare(left.firstEffectiveAt))[0]?.moduleId;
    const selectedModule = modules.find((module) => module.moduleId === moduleId)
      ?? (!allModules ? modules.find((module) => module.moduleId === recentModuleId) ?? modules[0] : undefined);
    const scopedModules = selectedModule ? [selectedModule] : modules;
    const scopedModuleIds = new Set(scopedModules.map((module) => module.moduleId));
    const today = shanghaiDate();
    const range = localMemoryRange(reportMode, periodInput, today);
    const myRecords = database.records.filter((record) => record.userId === database.currentUser.userId
      && scopedModuleIds.has(record.moduleId) && record.recordDate >= range.previousStart
      && record.recordDate < range.endExclusive && record.recordDate <= today && isFormalRecord(record));
    const currentRecords = myRecords.filter((record) => record.recordDate >= range.start);
    const latestRecord = [...currentRecords]
      .sort((left, right) => right.firstEffectiveAt.localeCompare(left.firstEffectiveAt)
        || right.recordId.localeCompare(left.recordId))[0];
    const previousRecords = myRecords.filter((record) => record.recordDate < range.start);
    const currentDates = new Set(currentRecords.map((record) => record.recordDate));
    const previousDates = new Set(previousRecords.map((record) => record.recordDate));
    const allRecordedDates = new Set(database.records.filter((record) => record.userId === database.currentUser.userId
      && scopedModuleIds.has(record.moduleId) && record.recordDate <= range.end
      && record.recordDate <= today && isFormalRecord(record)).map((record) => record.recordDate));
    const currentJoint = database.dailySnapshots.filter((snapshot) => scopedModuleIds.has(snapshot.moduleId)
      && snapshot.recordDate >= range.start && snapshot.recordDate < range.endExclusive
      && snapshot.recordDate <= today && snapshot.requiredMemberCount > 1 && snapshot.isAllCompleted).length;
    const previousJoint = database.dailySnapshots.filter((snapshot) => scopedModuleIds.has(snapshot.moduleId)
      && snapshot.recordDate >= range.previousStart && snapshot.recordDate < range.start
      && snapshot.requiredMemberCount > 1 && snapshot.isAllCompleted).length;
    const hasPartnerModules = scopedModules.some((module) => activeMembers(module).length > 1)
      || database.dailySnapshots.some((snapshot) => scopedModuleIds.has(snapshot.moduleId)
        && snapshot.recordDate >= range.previousStart && snapshot.recordDate < range.endExclusive
        && snapshot.requiredMemberCount > 1);
    const currentRecordIds = new Set(currentRecords.map((record) => record.recordId));
    const received = database.reactions.filter((reaction) => reaction.status === 'active' && currentRecordIds.has(reaction.recordId));
    const emojiCounts = new Map<ReactionEmoji, number>();
    received.forEach((reaction) => emojiCounts.set(reaction.emojiCode, (emojiCounts.get(reaction.emojiCode) ?? 0) + 1));
    const mostUsedCode = [...emojiCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    const normalTimes = currentRecords.filter((record) => record.source !== 'makeup')
      .map((record) => record.firstEffectiveAt?.slice(11, 16))
      .filter(Boolean)
      .sort() as string[];

    const generationKey = `${database.currentUser.userId}:${reportMode}:${range.key}:${selectedModule?.moduleId ?? 'all'}`;
    const generation = (localMemoryGeneration.get(generationKey) ?? 0) + (forceChange ? 1 : 0);
    localMemoryGeneration.set(generationKey, generation);
    const collageCandidates = database.records.filter((record) => scopedModuleIds.has(record.moduleId)
      && record.recordDate >= range.start && record.recordDate < range.endExclusive
      && record.recordDate <= today && isFormalRecord(record));
    const cardRecords = reportMode === 'month' && selectedModule
      ? resolveMemoryCard(database, selectedModule.moduleId, range.key, forceChange).recordIds
          .map((recordId) => database.records.find((record) => record.recordId === recordId))
          .filter(Boolean) as LifeRecord[]
      : selectFairMemoryRecords(collageCandidates, `${generationKey}:${generation}`);
    const featured = cardRecords[0];
    const countByDate = new Map<string, number>();
    currentRecords.forEach((record) => countByDate.set(record.recordDate, (countByDate.get(record.recordDate) ?? 0) + 1));
    const currentEnd = range.end < today ? range.end : today;
    return {
      reportMode,
      periodKey: range.key,
      periodStart: range.start,
      periodEnd: currentEnd,
      isCurrentPeriod: range.isCurrent,
      momentCount: currentRecords.length,
      previousMomentCount: previousRecords.length,
      recordedDays: currentDates.size,
      previousRecordedDays: previousDates.size,
      participatedModuleCount: new Set(currentRecords.map((record) => record.moduleId)).size,
      jointCompletedDays: currentJoint,
      previousJointCompletedDays: previousJoint,
      hasPartnerModules,
      longestStreakDays: longestMemoryStreak(currentDates),
      previousLongestStreakDays: longestMemoryStreak(previousDates),
      currentStreakDays: calculateTrailingMemoryStreak(allRecordedDates, currentEnd),
      currentStreakOngoing: allRecordedDates.has(currentEnd),
      earliestTime: normalTimes[0],
      latestTime: normalTimes.at(-1),
      receivedReactionCount: received.length,
      weeklyRecordCount: currentRecords.length,
      moduleId: selectedModule?.moduleId ?? '',
      moduleName: selectedModule?.name ?? '',
      month: reportMode === 'month' ? range.key : range.start.slice(0, 7),
      modules: modules.map((module) => ({ moduleId: module.moduleId, name: module.name })),
      items: cardRecords.map((record, index) => ({
        recordId: record.recordId,
        moduleId: record.moduleId,
        recordDate: record.recordDate,
        stickerPath: record.stickerPath,
        displayOrder: index,
      })),
      footprint: [...countByDate.entries()].map(([date, recordCount]) => ({
        date,
        recordCount,
        level: Math.min(4, recordCount),
        ...(featured?.recordDate === date ? { stickerPath: featured.stickerPath } : {}),
      })),
      monthlyJointCompletedDays: reportMode === 'month' ? currentJoint : 0,
      monthlyReceivedReactionCount: reportMode === 'month' ? received.length : 0,
      mostUsedEmoji: mostUsedCode ? REACTION_EMOJIS[mostUsedCode] : '—',
      ...(latestRecord?.stickerPath
        ? { latestStickerPath: latestRecord.generatedStickerPath ?? latestRecord.stickerPath }
        : {}),
    };
  });
}

function localMemoryRange(reportMode: MemoryReportMode, period: string, today: string): {
  key: string;
  start: string;
  end: string;
  endExclusive: string;
  previousStart: string;
  isCurrent: boolean;
} {
  if (reportMode === 'month') {
    const key = /^\d{4}-\d{2}$/.test(period) ? period : today.slice(0, 7);
    const start = `${key}-01`;
    const endExclusive = localShiftMonth(key, 1);
    return {
      key,
      start,
      end: addDays(endExclusive, -1),
      endExclusive,
      previousStart: localShiftMonth(key, -1),
      isCurrent: key === today.slice(0, 7),
    };
  }
  const key = localWeekStart(/^\d{4}-\d{2}-\d{2}$/.test(period) ? period : today);
  const endExclusive = addDays(key, 7);
  return {
    key,
    start: key,
    end: addDays(endExclusive, -1),
    endExclusive,
    previousStart: addDays(key, -7),
    isCurrent: key === localWeekStart(today),
  };
}

function localShiftMonth(month: string, amount: number): string {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value - 1 + amount, 1)).toISOString().slice(0, 10);
}

function localWeekStart(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - weekday + 1);
  return parsed.toISOString().slice(0, 10);
}

function longestMemoryStreak(dates: Set<string>): number {
  let longest = 0;
  let current = 0;
  let previous = '';
  [...dates].sort().forEach((date) => {
    current = previous && addDays(previous, 1) === date ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  });
  return longest;
}

function calculateTrailingMemoryStreak(dates: Set<string>, end: string): number {
  let cursor = dates.has(end) ? end : addDays(end, -1);
  let streak = 0;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export interface PrivacyView {
  version: string;
  updatedDate: string;
  deletionRequest?: AppDatabase['accountDeletionRequest'];
}

export async function getPrivacyView(): Promise<PrivacyView> {
  await delay(40);
  const database = readDatabase();
  return { version: 'V1.0', updatedDate: database.privacyVersion, deletionRequest: database.accountDeletionRequest };
}

export async function syncPrivacyConsent(agreed: boolean): Promise<void> {
  await delay(20);
  setTrackingConsent(agreed);
}

export async function requestAccountDeletion(): Promise<NonNullable<AppDatabase['accountDeletionRequest']>> {
  await delay(100);
  return updateDatabase((database) => {
    if (database.accountDeletionRequest?.status === 'cooling_off') return database.accountDeletionRequest;
    const now = shanghaiNowIso();
    database.accountDeletionRequest = {
      requestId: createId('account_delete'),
      userId: database.currentUser.userId,
      status: 'cooling_off',
      requestedAt: now,
      executeAfter: shanghaiNowIso(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
      updatedAt: now,
    };
    addAudit(database, 'account_deletion_requested', undefined, database.accountDeletionRequest.requestId);
    track('account_deletion_request_success', { coolingOffDays: 7 });
    return database.accountDeletionRequest;
  });
}

export async function cancelAccountDeletion(): Promise<void> {
  await delay(80);
  updateDatabase((database) => {
    if (!database.accountDeletionRequest || database.accountDeletionRequest.status !== 'cooling_off') return;
    database.accountDeletionRequest.status = 'cancelled';
    database.accountDeletionRequest.updatedAt = shanghaiNowIso();
    addAudit(database, 'account_deletion_cancelled', undefined, database.accountDeletionRequest.requestId);
  });
}
