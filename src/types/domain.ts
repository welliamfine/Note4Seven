export type ModuleMode = 'solo' | 'group';
export type MemberRole = 'creator' | 'member';
export type RecordStatus = 'pending' | 'active' | 'locked' | 'rejected' | 'cancelled' | 'expired';
export type MediaStatus = 'idle' | 'selected' | 'processing' | 'ready' | 'failed';
export type ReactionEmoji = 'heart' | 'like' | 'laugh' | 'yummy' | 'hug' | 'cheer';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type InviteStatus = 'active' | 'expired' | 'invalid_module';
export type JoinApplicationStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ModuleStatus = 'active' | 'pending_delete';
export type ReminderSubscriptionStatus = 'not_requested' | 'authorized' | 'denied';

export interface User {
  userId: string;
  nickname: string;
  avatarText: string;
  avatarColor: string;
  avatarUrl?: string;
}

export interface ModuleMember extends User {
  memberInstanceId: string;
  role: MemberRole;
  joinSequence: number;
  joinedAt: string;
  active: boolean;
  leftAt?: string;
  leaveReason?: 'self_exit' | 'removed' | 'module_deleted';
}

export interface LifeModule {
  moduleId: string;
  name: string;
  description: string;
  mode: ModuleMode;
  status: ModuleStatus;
  creatorUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  recycleExpireAt?: string;
  members: ModuleMember[];
  version?: number;
}

export interface ReminderSubscription {
  reminderId: string;
  moduleId: string;
  userId: string;
  enabled: boolean;
  reminderTime: string;
  inAppEnabled: boolean;
  subscriptionStatus: ReminderSubscriptionStatus;
  paused: boolean;
  lastSentDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DailyModuleSnapshot {
  snapshotId: string;
  moduleId: string;
  recordDate: string;
  memberInstanceIds: string[];
  requiredMemberCount: number;
  completedMemberCount: number;
  isAllCompleted: boolean;
  calculatedAt: string;
  updatedAt: string;
}

export interface MonthlyMemoryCard {
  memoryCardId: string;
  userId: string;
  moduleId: string;
  month: string;
  recordIds: string[];
  dataVersion: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountDeletionRequest {
  requestId: string;
  userId: string;
  status: 'cooling_off' | 'cancelled' | 'completed';
  requestedAt: string;
  executeAfter: string;
  updatedAt: string;
}

export interface UserModulePreference {
  moduleId: string;
  userId: string;
  pinned: boolean;
}

export interface LifeRecord {
  recordId: string;
  mediaId?: string;
  moduleId: string;
  memberInstanceId: string;
  userId: string;
  recordDate: string;
  originalPath: string;
  stickerPath: string;
  remark: string;
  source: 'normal' | 'makeup';
  status: RecordStatus;
  firstEffectiveAt: string;
  updatedAt: string;
  version?: number;
}

export interface Reaction {
  reactionId: string;
  moduleId: string;
  recordId: string;
  reactorUserId: string;
  reactorMemberInstanceId: string;
  emojiCode: ReactionEmoji;
  status: 'active' | 'cancelled';
  reactorNameSnapshot: string;
  reactorAvatarTextSnapshot: string;
  reactorAvatarColorSnapshot: string;
  createdAt: string;
  updatedAt: string;
}

export interface MakeupApproval {
  approvalId: string;
  moduleId: string;
  recordId: string;
  applicantUserId: string;
  applicantMemberInstanceId: string;
  targetDate: string;
  attemptNumber: number;
  status: ApprovalStatus;
  expireAt: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
  resolutionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InviteToken {
  inviteId: string;
  moduleId: string;
  createdByUserId: string;
  createdByMemberInstanceId: string;
  token: string;
  status: InviteStatus;
  expireAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface JoinApplication {
  applicationId: string;
  moduleId: string;
  applicantUserId: string;
  inviteId: string;
  status: JoinApplicationStatus;
  applicantNameSnapshot: string;
  applicantAvatarTextSnapshot: string;
  applicantAvatarColorSnapshot: string;
  expireAt: string;
  reapplyAllowedAt?: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
  resultMemberInstanceId?: string;
  resolutionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppNotification {
  notificationId: string;
  userId: string;
  type: 'join_application' | 'join_result' | 'member_change' | 'member_removed' | 'creator_transferred' | 'reaction' | 'makeup_result' | 'module_state' | 'reminder' | 'account';
  title: string;
  content: string;
  moduleId?: string;
  targetType?: 'module' | 'join_application' | 'record' | 'member';
  targetId?: string;
  recordDate?: string;
  actionType: 'none' | 'approve_join';
  actionStatus: 'none' | 'actionable' | 'processing' | 'resolved' | 'expired';
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleInboxItem {
  itemId: string;
  moduleId: string;
  recipientUserId: string;
  type: 'join_application' | 'makeup_approval' | 'makeup_result' | 'member_change' | 'module_state' | 'reaction';
  title: string;
  content: string;
  targetType: 'join_application' | 'makeup_approval' | 'record' | 'member' | 'module';
  targetId: string;
  recordDate?: string;
  status: 'unread' | 'read' | 'resolved' | 'expired';
  createdAt: string;
  updatedAt: string;
  expireAt: string;
}

export interface AuditEntry {
  auditId: string;
  moduleId?: string;
  actorUserId: string;
  action: string;
  targetId?: string;
  createdAt: string;
}

export interface ModuleTemplate {
  templateId: string;
  name: string;
  description: string;
  stickerPath: string;
}

export interface AppDatabase {
  schemaVersion: number;
  betaDemoSeeded?: boolean;
  currentUser: User;
  modules: LifeModule[];
  preferences: UserModulePreference[];
  records: LifeRecord[];
  templates: ModuleTemplate[];
  reactions: Reaction[];
  makeupApprovals: MakeupApproval[];
  inviteTokens: InviteToken[];
  joinApplications: JoinApplication[];
  notifications: AppNotification[];
  moduleInboxItems: ModuleInboxItem[];
  auditLog: AuditEntry[];
  reminders: ReminderSubscription[];
  dailySnapshots: DailyModuleSnapshot[];
  monthlyMemoryCards: MonthlyMemoryCard[];
  accountDeletionRequest?: AccountDeletionRequest;
  privacyVersion: string;
  idempotency: Record<string, string>;
}

export interface StickerPreview {
  recordId: string;
  memberInstanceId?: string;
  stickerPath: string;
  displayOrder: number;
}

export interface HomeModuleView extends LifeModule {
  pinned: boolean;
  unreadInboxCount: number;
  lastActivityAt?: string;
  todayPreviewItems: StickerPreview[];
}

export interface CalendarRecordView extends LifeRecord {
  member: ModuleMember;
  slot: string;
}

export interface CalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isFuture: boolean;
  hasRecords: boolean;
  hasPendingMakeup?: boolean;
  processingCheckinId?: string;
  records: CalendarRecordView[];
}

export interface MediaResult {
  mediaId: string;
  originalPath: string;
  stickerPath: string;
  stickerFallbackPath?: string;
}

export interface MediaStickerSources {
  stickerPath: string;
  stickerFallbackPath?: string;
}

export interface PreparedMediaFile {
  filePath: string;
  mimeType: 'image/jpeg' | 'image/png';
  fileSize: number;
  width: number;
  height: number;
}

export interface CheckinUploadInput {
  moduleId: string;
  recordDate: string;
  remark: string;
  filePath: string;
  sourceType: 'camera' | 'gallery';
  clientRequestId: string;
}

export interface CheckinUploadResult {
  checkinId: string;
  mediaId: string;
}

export interface CheckinProcessingStatus {
  checkinId: string;
  mediaId: string;
  displayStatus: 'waiting' | 'ready' | 'rejected' | 'failed' | 'cancelled';
  stage: 'uploading' | 'reviewing_and_matting' | 'reviewing' | 'matting' | 'finalizing' | 'completed' | 'review_rejected' | 'matting_failed';
  canLeave: boolean;
  elapsedMs: number;
  stickerUrl?: string;
  retryable: boolean;
  message?: string;
}
