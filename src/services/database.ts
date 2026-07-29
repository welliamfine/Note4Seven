import type {
  AppDatabase,
  AppNotification,
  DailyModuleSnapshot,
  JoinApplication,
  LifeModule,
  LifeRecord,
  MakeupApproval,
  ModuleInboxItem,
  ModuleMember,
  MonthlyMemoryCard,
  Reaction,
  ReminderSubscription,
  User,
} from '../types/domain';
import { DEFAULT_MODULE_TEMPLATES } from '../config/module-templates';
import { addDays, shanghaiDate, shanghaiNowIso } from '../utils/date';

const DATABASE_KEY = 'notemylife.alpha.database.v1';
const SCHEMA_VERSION = 9;

export const STICKER_PATHS = [
  '/assets/stickers/group-1.png',
  '/assets/stickers/group-3.png',
  '/assets/stickers/group-4.png',
  '/assets/stickers/group-5.png',
  '/assets/stickers/group-12.png',
  '/assets/stickers/group-13.png',
  '/assets/stickers/group-14.png',
  '/assets/stickers/group-15.png',
];

const createDefaultTemplates = (): AppDatabase['templates'] => DEFAULT_MODULE_TEMPLATES.map((template) => ({
  templateId: template.localTemplateId,
  name: template.name,
  description: template.description,
  stickerPath: STICKER_PATHS[template.stickerIndex],
}));

const me: User = {
  userId: 'user_me',
  nickname: '小满',
  avatarText: '🐰',
  avatarColor: '#e65f45',
};

const friends: User[] = [
  { userId: 'user_lin', nickname: '阿树', avatarText: '🐻', avatarColor: '#e9dfcf' },
  { userId: 'user_qiu', nickname: '橙子', avatarText: '🦊', avatarColor: '#f2dfcf' },
  { userId: 'user_an', nickname: '阿南', avatarText: '🐶', avatarColor: '#ded9cf' },
];

function member(user: User, moduleId: string, sequence: number, role: 'creator' | 'member'): ModuleMember {
  return {
    ...user,
    memberInstanceId: `${moduleId}_member_${sequence}`,
    role,
    joinSequence: sequence,
    joinedAt: shanghaiNowIso(new Date(Date.now() - sequence * 7 * 86_400_000)),
    active: true,
  };
}

function seedRecord(
  module: LifeModule,
  targetMember: ModuleMember,
  recordDate: string,
  stickerIndex: number,
  hour: number,
  remark: string,
): LifeRecord {
  const today = shanghaiDate();
  return {
    recordId: `${module.moduleId}_${targetMember.joinSequence}_${recordDate}`,
    moduleId: module.moduleId,
    memberInstanceId: targetMember.memberInstanceId,
    userId: targetMember.userId,
    recordDate,
    originalPath: STICKER_PATHS[stickerIndex % STICKER_PATHS.length],
    stickerPath: STICKER_PATHS[stickerIndex % STICKER_PATHS.length],
    remark,
    source: 'normal',
    status: recordDate === today ? 'active' : 'locked',
    firstEffectiveAt: `${recordDate}T${String(hour).padStart(2, '0')}:20:00+08:00`,
    updatedAt: `${recordDate}T${String(hour).padStart(2, '0')}:20:00+08:00`,
  };
}

function createSeedDatabase(): AppDatabase {
  const today = shanghaiDate();
  const now = shanghaiNowIso();
  const coffee: LifeModule = {
    moduleId: 'module_coffee',
    name: '今天喝了什么',
    description: '把每天的一杯小快乐留下来',
    mode: 'solo',
    recordPolicy: 'strict',
    status: 'active',
    creatorUserId: me.userId,
    createdAt: now,
    updatedAt: now,
    members: [member(me, 'module_coffee', 1, 'creator')],
  };
  const dinner: LifeModule = {
    moduleId: 'module_dinner',
    name: '今天吃什么',
    description: '认真吃饭，也认真分享',
    mode: 'group',
    recordPolicy: 'strict',
    status: 'active',
    creatorUserId: friends[0].userId,
    createdAt: now,
    updatedAt: now,
    members: [
      member(friends[0], 'module_dinner', 1, 'creator'),
      member(me, 'module_dinner', 2, 'member'),
      member(friends[1], 'module_dinner', 3, 'member'),
    ],
  };
  const weekend: LifeModule = {
    moduleId: 'module_weekend',
    name: '周末去哪里',
    description: '收集那些值得出门的日子',
    mode: 'group',
    recordPolicy: 'strict',
    status: 'active',
    creatorUserId: me.userId,
    createdAt: now,
    updatedAt: now,
    members: [
      member(me, 'module_weekend', 1, 'creator'),
      member(friends[2], 'module_weekend', 2, 'member'),
    ],
  };

  const records: LifeRecord[] = [
    seedRecord(coffee, coffee.members[0], today, 0, 9, '冰美式，清醒开工'),
    seedRecord(dinner, dinner.members[0], today, 5, 12, '午饭很满足'),
    seedRecord(dinner, dinner.members[2], today, 6, 13, ''),
    seedRecord(weekend, weekend.members[1], addDays(today, -1), 3, 16, '散步遇到好天气'),
  ];

  for (let offset = 1; offset <= 12; offset += 1) {
    const date = addDays(today, -offset);
    records.push(seedRecord(coffee, coffee.members[0], date, offset, 8 + (offset % 3), offset % 2 ? '' : '今日份咖啡'));
    if (offset % 2 === 0) records.push(seedRecord(dinner, dinner.members[0], date, offset + 3, 12, '好好吃饭'));
    if (offset % 3 !== 0) records.push(seedRecord(dinner, dinner.members[1], date, offset + 4, 13, '今天也吃饱了'));
    if (offset % 4 !== 0) records.push(seedRecord(dinner, dinner.members[2], date, offset + 5, 19, '晚餐打卡'));
  }

  const pendingRecord = seedRecord(dinner, dinner.members[2], addDays(today, -1), 4, 20, '补记昨天的晚餐');
  pendingRecord.recordId = 'record_makeup_pending';
  pendingRecord.source = 'makeup';
  pendingRecord.status = 'pending';
  records.push(pendingRecord);

  const makeupApprovals: MakeupApproval[] = [{
    approvalId: 'approval_seed_makeup',
    moduleId: dinner.moduleId,
    recordId: pendingRecord.recordId,
    applicantUserId: dinner.members[2].userId,
    applicantMemberInstanceId: dinner.members[2].memberInstanceId,
    targetDate: pendingRecord.recordDate,
    attemptNumber: 1,
    status: 'pending',
    expireAt: shanghaiNowIso(new Date(Date.now() + 20 * 60 * 60 * 1000)),
    createdAt: now,
    updatedAt: now,
  }];

  const joinApplications: JoinApplication[] = [{
    applicationId: 'application_seed_join',
    moduleId: weekend.moduleId,
    applicantUserId: 'user_he',
    inviteId: 'invite_seed',
    status: 'pending',
    applicantNameSnapshot: '禾禾',
    applicantAvatarTextSnapshot: '🌿',
    applicantAvatarColorSnapshot: '#d8e2d4',
    expireAt: shanghaiNowIso(new Date(Date.now() + 6 * 24 * 60 * 60 * 1000)),
    createdAt: now,
    updatedAt: now,
  }];

  const notifications: AppNotification[] = [{
    notificationId: 'notification_seed_join',
    userId: me.userId,
    type: 'join_application',
    title: '新的加入申请',
    content: '禾禾申请加入「周末去哪里」',
    moduleId: weekend.moduleId,
    targetType: 'join_application',
    targetId: 'application_seed_join',
    actionType: 'approve_join',
    actionStatus: 'actionable',
    isRead: false,
    createdAt: now,
    updatedAt: now,
  }];

  const moduleInboxItems: ModuleInboxItem[] = [{
    itemId: 'inbox_seed_makeup',
    moduleId: dinner.moduleId,
    recipientUserId: me.userId,
    type: 'makeup_approval',
    title: '待审批补卡',
    content: `橙子申请补记 ${pendingRecord.recordDate}`,
    targetType: 'makeup_approval',
    targetId: 'approval_seed_makeup',
    recordDate: pendingRecord.recordDate,
    status: 'unread',
    createdAt: now,
    updatedAt: now,
    expireAt: makeupApprovals[0].expireAt,
  }, {
    itemId: 'inbox_seed_join',
    moduleId: weekend.moduleId,
    recipientUserId: me.userId,
    type: 'join_application',
    title: '新的加入申请',
    content: '禾禾申请加入「周末去哪里」',
    targetType: 'join_application',
    targetId: 'application_seed_join',
    status: 'unread',
    createdAt: now,
    updatedAt: now,
    expireAt: joinApplications[0].expireAt,
  }];

  const reactions: Reaction[] = [{
    reactionId: 'reaction_seed_dinner',
    moduleId: dinner.moduleId,
    recordId: `${dinner.moduleId}_1_${today}`,
    reactorUserId: me.userId,
    reactorMemberInstanceId: dinner.members[1].memberInstanceId,
    emojiCode: 'yummy',
    status: 'active',
    reactorNameSnapshot: me.nickname,
    reactorAvatarTextSnapshot: me.avatarText,
    reactorAvatarColorSnapshot: me.avatarColor,
    createdAt: now,
    updatedAt: now,
  }];

  const reminders: ReminderSubscription[] = [{
    reminderId: 'reminder_seed_coffee',
    moduleId: coffee.moduleId,
    userId: me.userId,
    enabled: true,
    reminderTime: '21:00',
    inAppEnabled: true,
    subscriptionStatus: 'not_requested',
    paused: false,
    createdAt: now,
    updatedAt: now,
  }];

  const dailySnapshots: DailyModuleSnapshot[] = [];
  const monthlyMemoryCards: MonthlyMemoryCard[] = [];

  return {
    schemaVersion: SCHEMA_VERSION,
    betaDemoSeeded: true,
    currentUser: me,
    modules: [coffee, dinner, weekend],
    preferences: [
      { moduleId: coffee.moduleId, userId: me.userId, pinned: true },
      { moduleId: dinner.moduleId, userId: me.userId, pinned: false },
      { moduleId: weekend.moduleId, userId: me.userId, pinned: false },
    ],
    records,
    templates: createDefaultTemplates(),
    reactions,
    makeupApprovals,
    inviteTokens: [],
    joinApplications,
    notifications,
    moduleInboxItems,
    auditLog: [],
    reminders,
    dailySnapshots,
    monthlyMemoryCards,
    privacyVersion: '2026-07-21',
    idempotency: {},
  };
}

function seedBetaDemoState(database: AppDatabase): void {
  if (database.betaDemoSeeded) return;
  const seed = createSeedDatabase();
  const moduleIds = new Set(database.modules.map((module) => module.moduleId));

  seed.records
    .filter((record) => record.status === 'pending' && moduleIds.has(record.moduleId))
    .forEach((record) => {
      const module = database.modules.find((item) => item.moduleId === record.moduleId);
      if (!module?.members.some((member) => member.memberInstanceId === record.memberInstanceId)) return;
      if (!database.records.some((item) => item.recordId === record.recordId)) database.records.push(record);
    });
  seed.makeupApprovals
    .filter((approval) => database.records.some((record) => record.recordId === approval.recordId))
    .forEach((approval) => {
      if (!database.makeupApprovals.some((item) => item.approvalId === approval.approvalId)) database.makeupApprovals.push(approval);
    });
  seed.moduleInboxItems
    .filter((item) => item.recipientUserId === database.currentUser.userId
      && database.makeupApprovals.some((approval) => approval.approvalId === item.targetId))
    .forEach((item) => {
      if (!database.moduleInboxItems.some((candidate) => candidate.itemId === item.itemId)) database.moduleInboxItems.push(item);
    });
  seed.joinApplications
    .filter((application) => moduleIds.has(application.moduleId))
    .forEach((application) => {
      const module = database.modules.find((item) => item.moduleId === application.moduleId);
      if (module?.creatorUserId !== database.currentUser.userId) return;
      if (!database.joinApplications.some((item) => item.applicationId === application.applicationId)) database.joinApplications.push(application);
    });
  seed.notifications
    .filter((notification) => notification.userId === database.currentUser.userId
      && (!notification.targetId || database.joinApplications.some((application) => application.applicationId === notification.targetId)))
    .forEach((notification) => {
      if (!database.notifications.some((item) => item.notificationId === notification.notificationId)) database.notifications.push(notification);
    });
  database.betaDemoSeeded = true;
}

function migrateToBeta(database: AppDatabase): void {
  database.reactions ??= [];
  database.makeupApprovals ??= [];
  database.inviteTokens ??= [];
  database.joinApplications ??= [];
  database.notifications ??= [];
  database.moduleInboxItems ??= [];
  database.auditLog ??= [];
  seedBetaDemoState(database);
  database.schemaVersion = 4;
}

function migrateToRc(database: AppDatabase): void {
  database.modules.forEach((module) => {
    module.status ??= 'active';
  });
  database.reminders ??= [];
  database.dailySnapshots ??= [];
  database.monthlyMemoryCards ??= [];
  database.privacyVersion ??= '2026-07-21';
  database.schemaVersion = 5;
}

function migrateToNote4Seven(database: AppDatabase): void {
  database.templates = createDefaultTemplates();
  database.schemaVersion = 6;
}

function migrateTemplateCopy(database: AppDatabase): void {
  database.templates = createDefaultTemplates();
  database.schemaVersion = 7;
}

function migrateJoinApplicationsToModuleInbox(database: AppDatabase): void {
  database.notifications
    .filter((notification) => notification.targetType === 'join_application' && notification.targetId)
    .forEach((notification) => {
      if (database.moduleInboxItems.some((item) => item.recipientUserId === notification.userId
        && item.targetType === 'join_application' && item.targetId === notification.targetId)) return;
      const application = database.joinApplications.find((item) => item.applicationId === notification.targetId);
      if (!application) return;
      database.moduleInboxItems.push({
        itemId: `inbox_${notification.notificationId}`,
        moduleId: application.moduleId,
        recipientUserId: notification.userId,
        type: 'join_application',
        title: notification.title,
        content: notification.content,
        targetType: 'join_application',
        targetId: application.applicationId,
        status: notification.actionStatus === 'resolved' ? 'resolved' : notification.isRead ? 'read' : 'unread',
        createdAt: notification.createdAt,
        updatedAt: notification.updatedAt,
        expireAt: application.expireAt,
      });
    });
  database.schemaVersion = 8;
}

function migrateRecordPolicies(database: AppDatabase): void {
  database.modules.forEach((module) => {
    module.recordPolicy ??= 'strict';
  });
  database.schemaVersion = SCHEMA_VERSION;
}

export function bootstrapDatabase(): void {
  const existing = wx.getStorageSync(DATABASE_KEY) as AppDatabase | undefined;
  if (existing?.schemaVersion === 2) {
    const migratePath = (path: string): string => path.replace(/(\/assets\/stickers\/group-\d+)\.webp$/, '$1.png');
    existing.records.forEach((record) => {
      record.originalPath = migratePath(record.originalPath);
      record.stickerPath = migratePath(record.stickerPath);
    });
    existing.templates.forEach((template) => {
      template.stickerPath = migratePath(template.stickerPath);
    });
    existing.schemaVersion = 3;
  }
  if (existing?.schemaVersion === 3) {
    migrateToBeta(existing);
  }
  if (existing?.schemaVersion === 4) {
    if (!existing.betaDemoSeeded) seedBetaDemoState(existing);
    migrateToRc(existing);
  }
  if (existing?.schemaVersion === 5) {
    migrateToNote4Seven(existing);
  }
  if (existing?.schemaVersion === 6) {
    migrateTemplateCopy(existing);
  }
  if (existing?.schemaVersion === 7) {
    migrateJoinApplicationsToModuleInbox(existing);
  }
  if (existing?.schemaVersion === 8) {
    migrateRecordPolicies(existing);
    wx.setStorageSync(DATABASE_KEY, existing);
  } else if (existing?.schemaVersion === SCHEMA_VERSION && !existing.betaDemoSeeded) {
    seedBetaDemoState(existing);
    wx.setStorageSync(DATABASE_KEY, existing);
  } else if (!existing || existing.schemaVersion !== SCHEMA_VERSION) {
    wx.setStorageSync(DATABASE_KEY, createSeedDatabase());
  }
}

export function readDatabase(): AppDatabase {
  bootstrapDatabase();
  return wx.getStorageSync(DATABASE_KEY) as AppDatabase;
}

export function writeDatabase(database: AppDatabase): void {
  wx.setStorageSync(DATABASE_KEY, database);
}

export function updateDatabase<T>(updater: (database: AppDatabase) => T): T {
  const database = readDatabase();
  const result = updater(database);
  writeDatabase(database);
  return result;
}

export function resetDatabase(): void {
  wx.setStorageSync(DATABASE_KEY, createSeedDatabase());
}
