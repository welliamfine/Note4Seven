import { SUBSCRIBE_TEMPLATE_ID } from '../config/runtime';
import type {
  AccountDeletionRequest,
  CalendarCell,
  CalendarRecordView,
  CheckinProcessingStatus,
  CheckinUploadInput,
  CheckinUploadResult,
  HomeModuleView,
  JoinApplication,
  LifeModule,
  LifeRecord,
  MakeupApproval,
  MediaResult,
  MediaStickerSources,
  ModuleMember,
  ModuleTemplate,
  PreparedMediaFile,
  ReactionEmoji,
  User,
} from '../types/domain';
import { buildMonthGrid, shanghaiDate, shanghaiNowIso } from '../utils/date';
import { createId } from '../utils/id';
import { setTrackingConsent, track } from './tracker';
import type {
  CreateModuleInput,
  GalleryView,
  InvitePreview,
  MemberManagementView,
  MemoryView,
  ModuleInboxView,
  NotificationView,
  PrivacyView,
  ProfileOverview,
  ReactionView,
  RecycleModuleView,
  ReminderView,
  SaveRecordInput,
  SubmitMakeupInput,
  UpdateCurrentUserProfileInput,
  UpdateReminderInput,
} from './local-api';
import { remoteRequest, uploadBackendFile } from './transport-client';

type Json = Record<string, any>;

const moduleCache = new Map<string, LifeModule>();
const recordCache = new Map<string, LifeRecord>();
const makeupCache = new Map<string, MakeupApproval>();
const inboxCountCache = new Map<string, number>();
const monthSummaryCache = new Map<string, { currentUserRecordedDays: number; jointCompletedDays: number; receivedReactionCount: number }>();
const preparedMediaCache = new Map<string, PreparedMediaFile>();
interface MediaReservation {
  mediaId: string;
  upload: { cloudPath: string };
}
const mediaReservationCache = new Map<string, Promise<MediaReservation>>();
let currentUserCache: User | null = null;
let unreadNotificationCount = 0;

function avatar(nickname: string, url?: string | null): Pick<User, 'avatarText' | 'avatarColor' | 'avatarUrl'> {
  let hash = 0;
  for (const character of nickname) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const colors = ['#6f8f72', '#b76e79', '#667fa8', '#a77a45', '#7e6da8'];
  return { avatarText: nickname.slice(0, 1) || '微', avatarColor: colors[hash % colors.length], avatarUrl: url ?? undefined };
}

function member(raw: Json): ModuleMember {
  const nickname = String(raw.nickname ?? raw.displayName ?? '微信用户');
  return {
    userId: String(raw.userId ?? ''),
    nickname,
    ...avatar(nickname, raw.avatarUrl),
    memberInstanceId: String(raw.memberInstanceId),
    role: raw.role === 'creator' ? 'creator' : 'member',
    joinSequence: Number(raw.joinSequence ?? 1),
    joinedAt: String(raw.joinedAt ?? shanghaiNowIso()),
    active: true,
  };
}

function mapRecord(raw: Json): LifeRecord {
  const result: LifeRecord = {
    recordId: String(raw.recordId),
    mediaId: raw.mediaId ? String(raw.mediaId) : undefined,
    moduleId: String(raw.moduleId),
    memberInstanceId: String(raw.memberInstanceId),
    userId: String(raw.userId ?? ''),
    recordDate: String(raw.recordDate),
    originalPath: String(raw.originalUrl ?? raw.originalThumbnailUrl ?? ''),
    stickerPath: String(raw.stickerThumbnailUrl ?? raw.stickerUrl ?? ''),
    remark: String(raw.remark ?? ''),
    source: raw.source === 'makeup' ? 'makeup' : 'normal',
    status: raw.status,
    firstEffectiveAt: String(raw.firstEffectiveAt ?? raw.updatedAt ?? shanghaiNowIso()),
    updatedAt: String(raw.updatedAt ?? raw.firstEffectiveAt ?? shanghaiNowIso()),
    version: Number(raw.version ?? 0),
  };
  recordCache.set(result.recordId, result);
  return result;
}

async function moduleFromDetail(moduleId: string): Promise<LifeModule> {
  const result = await remoteRequest<Json>(`/modules/${moduleId}`);
  const raw = result.module;
  const members = (result.memberStatusBar as Json[]).map(member);
  const creator = members.find((item) => item.role === 'creator');
  const module: LifeModule = {
    moduleId,
    name: String(raw.name),
    description: String(raw.description ?? ''),
    mode: raw.mode === 'group' ? 'group' : 'solo',
    status: raw.status,
    creatorUserId: creator?.userId ?? '',
    createdAt: String(raw.createdAt ?? shanghaiNowIso()),
    updatedAt: String(raw.updatedAt ?? shanghaiNowIso()),
    members,
    version: Number(raw.version ?? 0),
  };
  moduleCache.set(moduleId, module);
  return module;
}

export async function getCurrentUser(): Promise<User> {
  const result = await remoteRequest<Json>('/users/me');
  const nickname = String(result.nickname ?? '微信用户');
  currentUserCache = { userId: String(result.userId), nickname, ...avatar(nickname, result.avatarUrl) };
  unreadNotificationCount = Number(result.unreadNotificationCount ?? unreadNotificationCount);
  return currentUserCache;
}

export async function getProfileOverview(): Promise<ProfileOverview> {
  const result = await remoteRequest<Json>('/users/me');
  const nickname = String(result.nickname ?? '微信用户');
  currentUserCache = { userId: String(result.userId), nickname, ...avatar(nickname, result.avatarUrl) };
  unreadNotificationCount = Number(result.unreadNotificationCount ?? 0);
  return {
    user: currentUserCache,
    recordedDays: Number(result.recordedDays ?? 0),
    moduleCount: Number(result.activeModuleCount ?? 0),
    unreadCount: unreadNotificationCount,
  };
}

export async function updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<User> {
  let avatarMediaId: string | undefined;
  if (input.avatarUrl && input.avatarUrl !== currentUserCache?.avatarUrl) {
    avatarMediaId = (await uploadAndProcess(input.avatarUrl, 'avatar')).mediaId;
  }
  const result = await remoteRequest<Json>('/users/me', {
    method: 'PATCH',
    data: { nickname: input.nickname.trim(), avatarMediaId, clientRequestId: createId('profile') },
  });
  const nickname = String(result.nickname);
  currentUserCache = { userId: String(result.userId), nickname, ...avatar(nickname, result.avatarUrl) };
  moduleCache.clear();
  return currentUserCache;
}

export async function getTemplates(): Promise<ModuleTemplate[]> {
  const result = await remoteRequest<Json>('/module-templates');
  const stickers = ['/assets/stickers/group-1.png', '/assets/stickers/group-3.png', '/assets/stickers/group-4.png', '/assets/stickers/group-5.png'];
  return (result.items as Json[]).map((item, index) => ({
    templateId: String(item.templateId), name: String(item.name), description: String(item.description ?? ''), stickerPath: stickers[index % stickers.length],
  }));
}

export async function getHomeModules(): Promise<{ pinned: HomeModuleView[]; normal: HomeModuleView[] }> {
  const result = await remoteRequest<Json>('/home/modules');
  const groups = result.groups as Json[];
  const map = (raw: Json): HomeModuleView => {
    const members = (raw.activeMembers as Json[]).map(member);
    const module: HomeModuleView = {
      moduleId: String(raw.moduleId), name: String(raw.moduleName), description: String(raw.description ?? ''),
      mode: raw.mode === 'group' ? 'group' : 'solo', status: raw.status, creatorUserId: String(raw.creatorUserId ?? members.find((item) => item.role === 'creator')?.userId ?? ''),
      createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt), members, version: Number(raw.version ?? 0),
      pinned: Boolean(raw.isPinned),
      todayPreviewItems: (raw.todayPreviewItems as Json[]).map((item) => ({ recordId: String(item.recordId), stickerPath: String(item.stickerThumbnailUrl), displayOrder: Number(item.displayOrder) })),
    };
    moduleCache.set(module.moduleId, module);
    return module;
  };
  return {
    pinned: (groups.find((item) => item.groupType === 'pinned')?.items ?? []).map(map),
    normal: (groups.find((item) => item.groupType === 'normal')?.items ?? []).map(map),
  };
}

export async function setModulePinned(moduleId: string, pinned: boolean): Promise<void> {
  await remoteRequest(`/modules/${moduleId}/pin`, { method: 'PUT', data: { isPinned: pinned, clientRequestId: createId('pin') } });
}

export async function removeModuleForCurrentUser(moduleId: string): Promise<'deleted' | 'left'> {
  const module = moduleCache.get(moduleId) ?? await moduleFromDetail(moduleId);
  const mine = module.members.find((item) => item.userId === currentUserCache?.userId);
  if (module.members.length === 1 && mine?.role === 'creator') {
    await deleteModuleToRecycle(moduleId, module.name);
    return 'deleted';
  }
  await remoteRequest(`/modules/${moduleId}/leave`, { method: 'POST', data: { clientRequestId: createId('leave') } });
  moduleCache.delete(moduleId);
  return 'left';
}

export async function createModule(input: CreateModuleInput): Promise<LifeModule> {
  const result = await remoteRequest<Json>('/modules', { method: 'POST', data: input });
  return moduleFromDetail(String(result.moduleId));
}

export async function getModule(moduleId: string): Promise<LifeModule> {
  return moduleFromDetail(moduleId);
}

export async function getCalendar(moduleId: string, month: string): Promise<CalendarCell[]> {
  const [result, module] = await Promise.all([
    remoteRequest<Json>(`/modules/${moduleId}/calendar?month=${encodeURIComponent(month)}`),
    moduleFromDetail(moduleId),
  ]);
  const dayByDate = new Map((result.days as Json[]).map((day) => [String(day.date), day]));
  return buildMonthGrid(month).map((cell) => {
    const day = dayByDate.get(cell.date);
    const records = day ? (day.memberSlots as Json[]).filter((slot) => slot.hasRecord).map((slot): CalendarRecordView => {
      const target = module.members.find((item) => item.memberInstanceId === slot.memberInstanceId) ?? module.members[0];
      return {
        recordId: String(slot.recordId), moduleId, memberInstanceId: String(slot.memberInstanceId), userId: target?.userId ?? '', recordDate: cell.date,
        originalPath: String(slot.stickerThumbnailUrl ?? ''), stickerPath: String(slot.stickerThumbnailUrl ?? ''), remark: '', source: 'normal', status: 'active',
        firstEffectiveAt: `${cell.date}T00:00:00+08:00`, updatedAt: `${cell.date}T00:00:00+08:00`, member: target, slot: String(slot.layoutSlot).replace(/_/g, '-'),
      };
    }) : [];
    return {
      ...cell,
      isToday: Boolean(day?.isToday),
      isFuture: day ? Boolean(day.isFuture) : cell.date > shanghaiDate(),
      hasRecords: records.length > 0,
      hasPendingMakeup: Boolean(day?.hasPendingMakeup),
      processingCheckinId: day?.processingCheckinId ? String(day.processingCheckinId) : undefined,
      records,
    };
  });
}

export async function getDateRecords(moduleId: string, recordDate: string): Promise<LifeRecord[]> {
  const result = await remoteRequest<Json>(`/modules/${moduleId}/dates/${recordDate}`);
  return (result.records as Json[]).map(mapRecord);
}

export async function getCurrentMakeupApproval(moduleId: string, recordDate: string): Promise<MakeupApproval | undefined> {
  return [...makeupCache.values()].find((item) => item.moduleId === moduleId && item.targetDate === recordDate && item.status === 'pending');
}

export async function processMedia(
  originalPath: string,
  moduleId?: string,
  onUploadProgress?: (progress: number) => void,
  onProcessing?: () => void,
  sourceType: 'camera' | 'gallery' = 'gallery',
): Promise<MediaResult> {
  if (!moduleId) throw new Error('MODULE_NOT_FOUND');
  return uploadAndProcess(originalPath, 'record_photo', moduleId, onUploadProgress, onProcessing, sourceType);
}

export async function refreshMediaStickerSources(mediaId: string): Promise<MediaStickerSources> {
  const state = await remoteRequest<Json>(`/media/${mediaId}`);
  if (state.status !== 'ready') throw new Error(String(state.failureCode ?? 'MEDIA_NOT_READY'));
  return mediaStickerSources(state);
}

export function prewarmMediaUpload(moduleId: string): void {
  void ensureMediaReservation(moduleId).catch(() => {
    // The normal create endpoint remains available when prewarming fails.
  });
}

export function discardPrewarmedMediaUpload(moduleId: string): void {
  const pending = mediaReservationCache.get(moduleId);
  if (!pending) return;
  mediaReservationCache.delete(moduleId);
  void pending.then((reservation) => remoteRequest(`/media/${reservation.mediaId}/abandon`, {
    method: 'POST',
    data: { clientRequestId: createId('media_abandon') },
  })).catch(() => {
    // Reserved rows are also eligible for the backend's abandoned-media cleanup.
  });
}

export async function initializeAndUploadCheckin(
  input: CheckinUploadInput,
  onProgress?: (progress: number) => void,
  onInitialized?: (result: CheckinUploadResult) => void,
): Promise<CheckinUploadResult> {
  const prepared = await prepareMediaFile(input.filePath, 'record_photo');
  const created = await remoteRequest<Json>(`/modules/${input.moduleId}/checkins/media/init`, {
    method: 'POST',
    data: {
      recordDate: input.recordDate,
      remark: input.remark,
      sourceType: input.sourceType,
      fileName: prepared.filePath.split('/').pop() ?? 'upload.jpg',
      mimeType: prepared.mimeType,
      fileSize: prepared.fileSize,
      width: prepared.width,
      height: prepared.height,
      clientRequestId: input.clientRequestId,
    },
  });
  const initialized = { checkinId: String(created.recordId), mediaId: String(created.mediaId) };
  onInitialized?.(initialized);
  const uploadStartedAt = Date.now();
  const upload = await uploadToCloudWithRetry(
    String(created.upload.cloudPath),
    prepared.filePath,
    onProgress,
  );
  track('media_upload_complete', {
    purpose: 'record_photo',
    durationMs: Date.now() - uploadStartedAt,
    fileSize: prepared.fileSize,
  });
  await remoteRequest(`/media/${created.mediaId}/upload-complete`, {
    method: 'POST',
    data: { etag: 'cloud-upload', fileId: upload.fileID, clientRequestId: createId('upload_done') },
  });
  return initialized;
}

export async function getCheckinProcessingStatus(checkinId: string): Promise<CheckinProcessingStatus> {
  const result = await remoteRequest<Json>(`/checkins/${checkinId}/processing-status`);
  return {
    checkinId: String(result.checkinId),
    mediaId: String(result.mediaId),
    displayStatus: result.displayStatus,
    stage: result.stage,
    canLeave: Boolean(result.canLeave),
    elapsedMs: Number(result.elapsedMs ?? 0),
    stickerUrl: result.stickerUrl ? String(result.stickerUrl) : undefined,
    retryable: Boolean(result.retryable),
    message: result.message ? String(result.message) : undefined,
  };
}

export async function retryCheckinMatting(checkinId: string): Promise<void> {
  await remoteRequest(`/checkins/${checkinId}/retry-matting`, {
    method: 'POST', data: { clientRequestId: createId('retry_matting') },
  });
}

export async function cancelProcessingCheckin(checkinId: string): Promise<void> {
  await remoteRequest(`/checkins/${checkinId}`, {
    method: 'DELETE', data: { clientRequestId: createId('cancel_checkin') },
  });
}

export async function saveRecord(input: SaveRecordInput): Promise<LifeRecord> {
  if (input.recordId) {
    const previous = recordCache.get(input.recordId) ?? mapRecord(await remoteRequest<Json>(`/records/${input.recordId}`));
    const mediaId = input.mediaId ?? previous.mediaId;
    if (!mediaId) throw new Error('MEDIA_NOT_READY');
    await remoteRequest(`/records/${input.recordId}`, { method: 'PATCH', data: { mediaId, remark: input.remark, version: previous.version ?? 0, clientRequestId: input.clientRequestId } });
    return mapRecord(await remoteRequest<Json>(`/records/${input.recordId}`));
  }
  if (!input.mediaId) throw new Error('MEDIA_NOT_READY');
  const created = await remoteRequest<Json>(`/modules/${input.moduleId}/records`, {
    method: 'POST', data: { recordDate: input.recordDate, mediaId: input.mediaId, remark: input.remark, clientRequestId: input.clientRequestId },
  });
  return mapRecord(await remoteRequest<Json>(`/records/${created.recordId}`));
}

export function currentUserRecord(records: LifeRecord[]): LifeRecord | undefined {
  return records.find((record) => record.userId === currentUserCache?.userId);
}

export async function deleteRecord(recordId: string): Promise<void> {
  const record = recordCache.get(recordId) ?? mapRecord(await remoteRequest<Json>(`/records/${recordId}`));
  await remoteRequest(`/records/${recordId}`, { method: 'DELETE', data: { version: record.version ?? 0, clientRequestId: createId('record_delete') } });
  recordCache.delete(recordId);
}

export async function getMemberManagement(moduleId: string): Promise<MemberManagementView> {
  const [module, result] = await Promise.all([moduleFromDetail(moduleId), remoteRequest<Json>(`/modules/${moduleId}/members`)]);
  const members = (result.members as Json[]).map((raw) => {
    const mapped = member(raw);
    return { ...mapped, isMine: Boolean(raw.isCurrentUser), recordedToday: raw.todayRecordStatus === 'active' || raw.todayRecordStatus === 'locked', joinedDate: mapped.joinedAt.slice(0, 10) };
  });
  module.members = members;
  return { module, members, currentRole: members.find((item) => item.isMine)?.role ?? 'member', inviteAvailable: Boolean(result.inviteAvailable), memberLimit: Number(result.memberLimit) };
}

export async function transferModuleCreator(moduleId: string, targetMemberInstanceId: string): Promise<void> {
  await remoteRequest(`/modules/${moduleId}/creator-transfer`, { method: 'POST', data: { targetMemberInstanceId, clientRequestId: createId('transfer') } });
  moduleCache.delete(moduleId);
}

export async function removeModuleMember(moduleId: string, targetMemberInstanceId: string): Promise<void> {
  await remoteRequest(`/modules/${moduleId}/members/${targetMemberInstanceId}/remove`, { method: 'POST', data: { clientRequestId: createId('remove_member') } });
  moduleCache.delete(moduleId);
}

function mapInvite(raw: Json): InvitePreview {
  const inviterName = String(raw.inviterName ?? '微信用户');
  return {
    invite: {
      inviteId: String(raw.inviteId), moduleId: String(raw.moduleId), createdByUserId: '', createdByMemberInstanceId: '', token: String(raw.inviteId),
      status: raw.status === 'active' ? 'active' : 'expired', expireAt: String(raw.expireAt), createdAt: shanghaiNowIso(), updatedAt: shanghaiNowIso(),
    },
    module: { moduleId: String(raw.moduleId), name: String(raw.moduleName), description: String(raw.description ?? '') },
    inviter: { userId: '', nickname: inviterName, ...avatar(inviterName, raw.inviterAvatarUrl) },
    memberCount: Number(raw.activeMemberCount), memberLimit: Number(raw.memberLimit), valid: raw.status === 'active' && Number(raw.activeMemberCount) < Number(raw.memberLimit),
  };
}

export async function createModuleInvite(moduleId: string): Promise<InvitePreview> {
  const created = await remoteRequest<Json>(`/modules/${moduleId}/invites`, { method: 'POST', data: { clientRequestId: createId('invite') } });
  return mapInvite(await remoteRequest<Json>(`/invites/${encodeURIComponent(created.inviteId)}/share-preview`));
}

export async function getInvitePreview(inviteId: string): Promise<InvitePreview> {
  const path = inviteId.startsWith('inv_')
    ? `/public/invites/${encodeURIComponent(inviteId)}`
    : `/public/invite-scenes/${encodeURIComponent(inviteId)}`;
  return mapInvite(await remoteRequest<Json>(path, { public: true }));
}

function mapApplication(raw: Json, inviteId = ''): JoinApplication {
  const now = shanghaiNowIso();
  return {
    applicationId: String(raw.applicationId), moduleId: String(raw.moduleId), applicantUserId: String(raw.applicantUserId ?? ''), inviteId,
    status: raw.status, applicantNameSnapshot: String(raw.applicantName ?? currentUserCache?.nickname ?? '微信用户'),
    applicantAvatarTextSnapshot: avatar(String(raw.applicantName ?? '微')).avatarText,
    applicantAvatarColorSnapshot: avatar(String(raw.applicantName ?? '微')).avatarColor,
    expireAt: String(raw.expireAt ?? now), reapplyAllowedAt: raw.reapplyAllowedAt ?? undefined, resolvedAt: raw.resolvedAt ?? undefined,
    resultMemberInstanceId: raw.memberInstanceId ?? undefined, createdAt: String(raw.createdAt ?? now), updatedAt: String(raw.resolvedAt ?? raw.createdAt ?? now),
  };
}

export async function submitJoinApplication(inviteId: string): Promise<JoinApplication | 'already_member'> {
  const result = await remoteRequest<Json>(`/invites/${encodeURIComponent(inviteId)}/applications`, { method: 'POST', data: { clientRequestId: createId('join') } });
  return result.status === 'already_member' ? 'already_member' : mapApplication(result, inviteId);
}

export async function getNotifications(): Promise<NotificationView[]> {
  const result = await remoteRequest<Json>('/notifications');
  const items = result.items as Json[];
  unreadNotificationCount = items.filter((item) => !item.isRead).length;
  return Promise.all(items.map(async (item): Promise<NotificationView> => {
    const target = item.target as Json | null;
    const application = target?.type === 'join_application' ? mapApplication(await remoteRequest<Json>(`/join-applications/${target.id}`)) : undefined;
    return {
      notificationId: String(item.notificationId), userId: currentUserCache?.userId ?? '', type: item.type === 'join_application_created' ? 'join_application' : item.type,
      title: String(item.title), content: String(item.content ?? ''), moduleId: application?.moduleId,
      targetType: target?.type, targetId: target?.id, recordDate: item.recordDate ?? undefined,
      actionType: item.actionType, actionStatus: item.actionStatus, isRead: Boolean(item.isRead), createdAt: String(item.createdAt), updatedAt: String(item.createdAt),
      moduleName: '', application,
    } as NotificationView;
  }));
}

export function getUnreadNotificationCount(): number { return unreadNotificationCount; }

export async function markNotificationRead(notificationId: string): Promise<void> {
  await remoteRequest(`/notifications/${notificationId}/read`, { method: 'POST', data: { clientRequestId: createId('notice_read') } });
  unreadNotificationCount = Math.max(0, unreadNotificationCount - 1);
}

export async function markAllNotificationsRead(): Promise<void> {
  await remoteRequest('/notifications/read-all', { method: 'POST', data: { clientRequestId: createId('notice_all') } });
  unreadNotificationCount = 0;
}

export async function resolveJoinApplication(applicationId: string, action: 'approve' | 'reject'): Promise<JoinApplication> {
  const result = await remoteRequest<Json>(`/join-applications/${applicationId}/${action}`, { method: 'POST', data: { clientRequestId: createId(`join_${action}`) } });
  const detail = await remoteRequest<Json>(`/join-applications/${applicationId}`);
  return mapApplication({ ...detail, ...result });
}

const emojis: Record<ReactionEmoji, string> = { heart: '❤️', like: '👍', laugh: '😂', yummy: '😋', hug: '🫂', cheer: '💪' };
export function getReactionOptions(): Array<{ code: ReactionEmoji; emoji: string; label: string }> {
  return [
    { code: 'heart', emoji: '❤️', label: '喜欢' }, { code: 'like', emoji: '👍', label: '收到' }, { code: 'laugh', emoji: '😂', label: '好笑' },
    { code: 'yummy', emoji: '😋', label: '不错' }, { code: 'hug', emoji: '🫂', label: '抱抱' }, { code: 'cheer', emoji: '💪', label: '加油' },
  ];
}

export async function getRecordReactions(recordId: string): Promise<ReactionView[]> {
  const result = await remoteRequest<Json>(`/records/${recordId}/reactions`);
  return (result.items as Json[]).map((item) => ({
    reactionId: String(item.reactionId), moduleId: String(item.moduleId), recordId, reactorUserId: String(item.reactorUserId),
    reactorMemberInstanceId: String(item.reactorMemberInstanceId), emojiCode: item.emojiCode, status: 'active', reactorNameSnapshot: String(item.reactorName),
    reactorAvatarTextSnapshot: avatar(String(item.reactorName)).avatarText, reactorAvatarColorSnapshot: avatar(String(item.reactorName)).avatarColor,
    createdAt: String(item.createdAt), updatedAt: String(item.createdAt), isMine: Boolean(item.isMine), emoji: emojis[item.emojiCode as ReactionEmoji],
  }));
}

export async function setRecordReaction(recordId: string, emojiCode: ReactionEmoji): Promise<'set' | 'cancelled'> {
  const mine = (await getRecordReactions(recordId)).find((item) => item.isMine);
  if (mine?.emojiCode === emojiCode) {
    await remoteRequest(`/records/${recordId}/reaction`, { method: 'DELETE', data: { clientRequestId: createId('reaction_delete') } });
    return 'cancelled';
  }
  await remoteRequest(`/records/${recordId}/reaction`, { method: 'PUT', data: { emojiCode, clientRequestId: createId('reaction_set') } });
  return 'set';
}

export async function submitMakeupRecord(input: SubmitMakeupInput): Promise<{ record: LifeRecord; approval?: MakeupApproval }> {
  if (!input.mediaId) throw new Error('MEDIA_NOT_READY');
  const result = await remoteRequest<Json>(`/modules/${input.moduleId}/makeup-applications`, {
    method: 'POST', data: { recordDate: input.recordDate, mediaId: input.mediaId, remark: input.remark, clientRequestId: input.clientRequestId },
  });
  const record = mapRecord({ ...result.record, moduleId: input.moduleId, mediaId: input.mediaId, memberInstanceId: '', userId: currentUserCache?.userId, originalUrl: input.originalPath, stickerUrl: input.stickerPath, remark: input.remark, source: 'makeup' });
  if (!result.approval) return { record };
  const approval = await getApproval(String(result.approval.approvalId));
  makeupCache.set(approval.approvalId, approval);
  return { record, approval };
}

async function getApproval(approvalId: string): Promise<MakeupApproval> {
  const raw = await remoteRequest<Json>(`/makeup-applications/${approvalId}`);
  return {
    approvalId: String(raw.approvalId), moduleId: String(raw.moduleId), recordId: String(raw.recordId), applicantUserId: String(raw.applicantUserId),
    applicantMemberInstanceId: String(raw.applicantMemberInstanceId), targetDate: String(raw.targetDate), attemptNumber: Number(raw.attemptNumber),
    status: raw.status, expireAt: String(raw.expireAt), resolvedAt: raw.resolvedAt ?? undefined, resolvedByUserId: raw.resolvedByUserId ?? undefined,
    resolutionReason: raw.resolutionReason ?? undefined, createdAt: String(raw.createdAt ?? shanghaiNowIso()), updatedAt: String(raw.resolvedAt ?? raw.createdAt ?? shanghaiNowIso()),
  };
}

export async function getModuleInbox(moduleId: string): Promise<ModuleInboxView[]> {
  const result = await remoteRequest<Json>(`/modules/${moduleId}/inbox`);
  const items = await Promise.all((result.items as Json[]).map(async (item): Promise<ModuleInboxView> => {
    const approval = item.targetType === 'makeup_approval' ? await getApproval(String(item.targetId)) : undefined;
    return {
      itemId: String(item.itemId), moduleId, recipientUserId: currentUserCache?.userId ?? '', type: item.type, title: String(item.title), content: String(item.content),
      targetType: item.targetType, targetId: String(item.targetId), recordDate: item.recordDate ?? undefined, status: item.status,
      createdAt: String(item.createdAt), updatedAt: String(item.createdAt), expireAt: String(item.expireAt), approval,
    } as ModuleInboxView;
  }));
  inboxCountCache.set(moduleId, items.filter((item) => item.status === 'unread').length);
  return items;
}

export function getModuleInboxCount(moduleId: string): number { return inboxCountCache.get(moduleId) ?? 0; }

export async function markModuleInboxRead(itemId: string): Promise<void> {
  await remoteRequest(`/module-inbox-items/${itemId}/read`, { method: 'POST', data: { clientRequestId: createId('inbox_read') } });
}

export async function resolveMakeupApproval(approvalId: string, action: 'approve' | 'reject'): Promise<MakeupApproval> {
  await remoteRequest(`/makeup-applications/${approvalId}/${action}`, { method: 'POST', data: { clientRequestId: createId(`makeup_${action}`) } });
  const approval = await getApproval(approvalId);
  makeupCache.set(approvalId, approval);
  return approval;
}

export async function updateModuleInfo(moduleId: string, name: string, description: string): Promise<LifeModule> {
  const module = moduleCache.get(moduleId) ?? await moduleFromDetail(moduleId);
  await remoteRequest(`/modules/${moduleId}`, { method: 'PATCH', data: { name, description, version: module.version ?? 0, clientRequestId: createId('module_update') } });
  return moduleFromDetail(moduleId);
}

export async function getModuleGallery(moduleId: string, month: string): Promise<GalleryView> {
  const [result, module] = await Promise.all([remoteRequest<Json>(`/modules/${moduleId}/gallery?month=${month}`), moduleFromDetail(moduleId)]);
  return {
    moduleId, moduleName: module.name, month,
    items: (result.items as Json[]).map((item) => ({
      recordId: String(item.recordId), recordDate: String(item.recordDate), memberInstanceId: String(item.memberInstanceId), displayName: String(item.displayName),
      ...avatar(String(item.displayName)), isAnonymousExitedMember: Boolean(item.isAnonymousExitedMember), remark: String(item.remark ?? ''),
      stickerPath: String(item.stickerThumbnailUrl), originalPath: String(item.stickerThumbnailUrl),
    })),
  };
}

export async function getModuleReminder(moduleId: string): Promise<ReminderView> {
  const [raw, module] = await Promise.all([remoteRequest<Json>(`/modules/${moduleId}/reminder`), moduleFromDetail(moduleId)]);
  return {
    reminderId: String(raw.reminderId ?? ''), moduleId, userId: currentUserCache?.userId ?? '', enabled: Boolean(raw.enabled), reminderTime: String(raw.reminderTime).slice(0, 5),
    inAppEnabled: true, subscriptionStatus: raw.subscriptionStatus, paused: false, lastSentDate: raw.lastSentDate ?? undefined,
    createdAt: String(raw.createdAt ?? shanghaiNowIso()), updatedAt: String(raw.updatedAt ?? shanghaiNowIso()), moduleName: module.name,
  };
}

export async function updateModuleReminder(moduleId: string, input: UpdateReminderInput): Promise<ReminderView> {
  let subscriptionStatus = input.subscriptionStatus;
  if (input.enabled && subscriptionStatus !== 'authorized') {
    const permission = await wx.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TEMPLATE_ID] });
    subscriptionStatus = permission[SUBSCRIBE_TEMPLATE_ID] === 'accept' ? 'authorized' : 'denied';
  }
  await remoteRequest(`/modules/${moduleId}/reminder`, {
    method: 'PUT', data: { enabled: input.enabled && subscriptionStatus === 'authorized', reminderTime: `${input.reminderTime}:00`, subscriptionStatus, clientRequestId: createId('reminder') },
  });
  return getModuleReminder(moduleId);
}

export function runInAppReminderScan(): number { return 0; }

export async function deleteModuleToRecycle(moduleId: string, confirmationName: string): Promise<void> {
  await remoteRequest(`/modules/${moduleId}/delete`, { method: 'POST', data: { confirmationName, clientRequestId: createId('module_delete') } });
  moduleCache.delete(moduleId);
}

export async function getRecycleBin(): Promise<RecycleModuleView[]> {
  const result = await remoteRequest<Json>('/modules/recycle-bin');
  return (result.items as Json[]).map((item) => ({
    moduleId: String(item.moduleId), name: String(item.name), memberCount: Number(item.activeMemberCount ?? 0), deletedAt: String(item.deletedAt), recycleExpireAt: String(item.recycleExpireAt),
    remainingDays: Math.max(1, Math.ceil((Date.parse(String(item.recycleExpireAt)) - Date.now()) / 86_400_000)),
  }));
}

export async function restoreRecycledModule(moduleId: string): Promise<LifeModule> {
  await remoteRequest(`/modules/${moduleId}/restore`, { method: 'POST', data: { clientRequestId: createId('restore') } });
  return moduleFromDetail(moduleId);
}

function isoWeek(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const target = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return `${target.getUTCFullYear()}-W${String(Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)).padStart(2, '0')}`;
}

export async function getMemoryView(moduleId?: string, month = shanghaiDate().slice(0, 7), forceChange = false): Promise<MemoryView> {
  const home = await getHomeModules();
  const modules = [...home.pinned, ...home.normal];
  const selected = modules.find((item) => item.moduleId === moduleId) ?? modules[0];
  if (!selected) throw new Error('NO_ACTIVE_MODULE');
  const [weekly, card] = await Promise.all([
    remoteRequest<Json>(`/memories/weekly-overview?week=${isoWeek()}`),
    forceChange
      ? remoteRequest<Json>('/memories/monthly-card/change-group', { method: 'POST', data: { moduleId: selected.moduleId, month, clientRequestId: createId('memory_group') } })
      : remoteRequest<Json>(`/memories/monthly-card?moduleId=${selected.moduleId}&month=${month}`),
  ]);
  const summary = {
    currentUserRecordedDays: Number(card.currentUserRecordedDays ?? 0), jointCompletedDays: Number(card.jointCompletedDays ?? 0), receivedReactionCount: Number(card.receivedReactionCount ?? 0),
  };
  monthSummaryCache.set(`${selected.moduleId}:${month}`, summary);
  const emojiMap: Record<string, string> = { heart: '❤️', like: '👍', laugh: '😂', yummy: '😋', hug: '🫂', cheer: '💪' };
  return {
    recordedDays: Number(weekly.recordedDays), participatedModuleCount: Number(weekly.participatedModuleCount), jointCompletedDays: Number(weekly.jointCompletedDays),
    currentStreakDays: Number(weekly.currentStreakDays), receivedReactionCount: Number(weekly.receivedReactionCount), weeklyRecordCount: Number(weekly.weeklyRecordCount),
    moduleId: selected.moduleId, moduleName: selected.name, month, modules: modules.map((item) => ({ moduleId: item.moduleId, name: item.name })),
    items: (card.items as Json[]).map((item) => ({ recordId: String(item.recordId), stickerPath: String(item.stickerThumbnailUrl), displayOrder: Number(item.displayOrder) })),
    monthlyJointCompletedDays: Number(card.jointCompletedDays), monthlyReceivedReactionCount: Number(card.receivedReactionCount), mostUsedEmoji: emojiMap[String(card.mostUsedEmojiCode)] ?? '—',
  };
}

export function getModuleMonthSummary(moduleId: string, month: string) {
  return monthSummaryCache.get(`${moduleId}:${month}`) ?? { currentUserRecordedDays: 0, jointCompletedDays: 0, receivedReactionCount: 0 };
}

export async function getPrivacyView(): Promise<PrivacyView> {
  const [privacy, deletion] = await Promise.all([
    remoteRequest<Json>('/privacy/current'),
    remoteRequest<Json | null>('/users/me/deletion-request'),
  ]);
  return { version: `V${privacy.version}`, updatedDate: String(privacy.version), deletionRequest: deletion ? mapDeletion(deletion) : undefined };
}

export async function syncPrivacyConsent(agreed: boolean): Promise<void> {
  const privacy = await remoteRequest<Json>('/privacy/current');
  await remoteRequest('/privacy/consents', {
    method: 'POST',
    data: {
      privacyVersion: String(privacy.version),
      agreed,
      clientRequestId: createId(agreed ? 'privacy_agree' : 'privacy_revoke'),
    },
  });
  setTrackingConsent(agreed);
}

export async function requestAccountDeletion(): Promise<AccountDeletionRequest> {
  return mapDeletion(await remoteRequest<Json>('/users/me/deletion-request', { method: 'POST', data: { clientRequestId: createId('delete_account') } }));
}

export async function cancelAccountDeletion(): Promise<void> {
  await remoteRequest('/users/me/deletion-request/cancel', { method: 'POST', data: { clientRequestId: createId('cancel_delete') } });
}

function mapDeletion(raw: Json): AccountDeletionRequest {
  return {
    requestId: String(raw.requestId), userId: currentUserCache?.userId ?? '', status: raw.status, requestedAt: String(raw.requestedAt), executeAfter: String(raw.executeAfter),
    updatedAt: String(raw.updatedAt ?? raw.requestedAt),
  };
}

async function uploadAndProcess(
  filePath: string,
  purpose: 'record_photo' | 'avatar',
  moduleId?: string,
  onUploadProgress?: (progress: number) => void,
  onProcessing?: () => void,
  sourceType: 'camera' | 'gallery' = 'gallery',
): Promise<MediaResult> {
  const prepared = await prepareMediaFile(filePath, purpose);
  const created = purpose === 'record_photo' && moduleId
    ? await consumeMediaReservation(moduleId, prepared)
    : await createMediaUpload(prepared, purpose, moduleId);
  const objectKey = String(created.upload.cloudPath);
  const uploadStartedAt = Date.now();
  const upload = await uploadToCloudWithRetry(objectKey, prepared.filePath, onUploadProgress);
  track('media_upload_complete', {
    purpose,
    durationMs: Date.now() - uploadStartedAt,
    fileSize: prepared.fileSize,
  });
  onProcessing?.();
  let uploadNotificationError: unknown;
  const uploadNotification = delay(250)
    .then(() => notifyUploadComplete(created.mediaId, upload.fileID, prepared, sourceType))
    .catch((error) => { uploadNotificationError = error; });
  const startedAt = Date.now();
  while (true) {
    const state = await remoteRequest<Json>(`/media/${created.mediaId}?waitMs=2500`);
    if (state.status === 'ready') {
      const stickerSources = mediaStickerSources(state);
      return {
        mediaId: String(created.mediaId),
        originalPath: prepared.filePath,
        ...stickerSources,
      };
    }
    if (state.status === 'failed') throw new Error(String(state.failureCode ?? 'MEDIA_PROCESSING_FAILED'));
    if (state.status === 'abandoned') throw new Error('MEDIA_ABANDONED');
    if (Date.now() - startedAt > 12_000 && uploadNotificationError && ['created', 'uploading'].includes(String(state.status))) {
      throw uploadNotificationError;
    }
    await delay(80);
  }
}

function mediaStickerSources(state: Json): MediaStickerSources {
  const stickerThumbnailPath = String(state.assets?.stickerThumbnailUrl ?? '');
  const stickerFullPath = String(state.assets?.stickerUrl ?? '');
  const stickerPath = stickerThumbnailPath || stickerFullPath;
  if (!stickerPath) throw new Error('MEDIA_ASSET_MISSING');
  return {
    stickerPath,
    stickerFallbackPath: stickerThumbnailPath && stickerFullPath ? stickerFullPath : undefined,
  };
}

function ensureMediaReservation(moduleId: string): Promise<MediaReservation> {
  const existing = mediaReservationCache.get(moduleId);
  if (existing) return existing;
  const pending = remoteRequest<MediaReservation>('/media/reservations', {
    method: 'POST',
    data: { moduleId, purpose: 'record_photo', clientRequestId: createId('media_reserve') },
  });
  mediaReservationCache.set(moduleId, pending);
  void pending.catch(() => {
    if (mediaReservationCache.get(moduleId) === pending) mediaReservationCache.delete(moduleId);
  });
  return pending;
}

async function consumeMediaReservation(moduleId: string, prepared: PreparedMediaFile): Promise<MediaReservation> {
  const pending = ensureMediaReservation(moduleId);
  if (mediaReservationCache.get(moduleId) === pending) mediaReservationCache.delete(moduleId);
  try {
    return await pending;
  } catch {
    return createMediaUpload(prepared, 'record_photo', moduleId);
  }
}

async function createMediaUpload(
  prepared: PreparedMediaFile | undefined,
  purpose: 'record_photo' | 'avatar',
  moduleId?: string,
): Promise<MediaReservation> {
  if (purpose === 'record_photo' && moduleId && !prepared) {
    return remoteRequest<MediaReservation>('/media/reservations', {
      method: 'POST',
      data: { moduleId, purpose, clientRequestId: createId('media_reserve') },
    });
  }
  if (!prepared) throw new Error('MEDIA_PREPARE_REQUIRED');
  return remoteRequest<MediaReservation>('/media', {
    method: 'POST', data: {
      moduleId,
      purpose,
      sourceType: 'gallery',
      fileName: prepared.filePath.split('/').pop() ?? 'upload.jpg',
      mimeType: prepared.mimeType,
      fileSize: prepared.fileSize,
      width: prepared.width,
      height: prepared.height,
      clientRequestId: createId('media'),
    },
  });
}

async function notifyUploadComplete(
  mediaId: string,
  fileId: string,
  prepared: PreparedMediaFile,
  sourceType: 'camera' | 'gallery',
): Promise<void> {
  let lastError: unknown;
  const clientRequestId = createId('upload_done');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await remoteRequest(`/media/${mediaId}/upload-complete`, {
        method: 'POST',
        data: {
          etag: 'cloud-upload',
          fileId,
          sourceType,
          mimeType: prepared.mimeType,
          fileSize: prepared.fileSize,
          width: prepared.width,
          height: prepared.height,
          clientRequestId,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && (error as Error & { statusCode?: number }).statusCode === 422) throw error;
      if (attempt < 2) await delay(400 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function prepareMediaFile(
  filePath: string,
  purpose: 'record_photo' | 'avatar',
): Promise<PreparedMediaFile> {
  const cacheKey = `${purpose}:${filePath}`;
  const cached = preparedMediaCache.get(cacheKey);
  if (cached) return cached;
  const startedAt = Date.now();
  const [sourceInfo, sourceSize] = await Promise.all([imageInfo(filePath), statFile(filePath)]);
  if (!['jpeg', 'png'].includes(sourceInfo.type)) throw new Error('MEDIA_FORMAT_NOT_SUPPORTED');
  const targetBytes = purpose === 'avatar' ? 160 * 1024 : 180 * 1024;
  const stages = purpose === 'avatar'
    ? [{ edge: 512, quality: 76 }, { edge: 448, quality: 66 }]
    : [{ edge: 720, quality: 68 }, { edge: 640, quality: 58 }, { edge: 560, quality: 50 }];
  let compressedPath = filePath;
  let finalInfo = sourceInfo;
  let fileSize = sourceSize;
  for (const stage of stages) {
    const scale = Math.min(1, stage.edge / Math.max(sourceInfo.width, sourceInfo.height));
    compressedPath = await compressImage(
      filePath,
      stage.quality,
      Math.max(32, Math.round(sourceInfo.width * scale)),
      Math.max(32, Math.round(sourceInfo.height * scale)),
    );
    [finalInfo, fileSize] = await Promise.all([imageInfo(compressedPath), statFile(compressedPath)]);
    if (fileSize <= targetBytes) break;
  }
  if (fileSize > 512 * 1024) throw new Error('MEDIA_COMPRESSED_TOO_LARGE');
  const prepared: PreparedMediaFile = {
    filePath: compressedPath,
    mimeType: finalInfo.type === 'png' ? 'image/png' : 'image/jpeg',
    fileSize,
    width: finalInfo.width,
    height: finalInfo.height,
  };
  track('media_prepare_complete', {
    purpose,
    durationMs: Date.now() - startedAt,
    fileSize,
    width: finalInfo.width,
    height: finalInfo.height,
  });
  preparedMediaCache.set(cacheKey, prepared);
  if (preparedMediaCache.size > 8) {
    const oldest = preparedMediaCache.keys().next().value as string | undefined;
    if (oldest) preparedMediaCache.delete(oldest);
  }
  return prepared;
}

function compressImage(src: string, quality: number, compressedWidth: number, compressedHeight: number): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality,
      compressedWidth,
      compressedHeight,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: reject,
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadToCloudWithRetry(
  cloudPath: string,
  filePath: string,
  onProgress?: (progress: number) => void,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await uploadBackendFile(cloudPath, filePath, onProgress);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function imageInfo(src: string): Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject }));
}

function statFile(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().stat({
      path,
      success: ({ stats }) => resolve(Array.isArray(stats) ? 0 : stats.size),
      fail: reject,
    });
  });
}
