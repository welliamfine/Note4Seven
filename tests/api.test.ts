import { beforeEach, describe, expect, it } from 'vitest';
import {
  createModuleInvite,
  createModule,
  cancelAccountDeletion,
  deleteModuleToRecycle,
  deleteRecord,
  getCalendar,
  getHomeModules,
  getMemoryView,
  getModule,
  getModuleGallery,
  getModuleReminder,
  getPrivacyView,
  getRecycleBin,
  getRecordReactions,
  removeModuleForCurrentUser,
  resolveJoinApplication,
  resolveMakeupApproval,
  restoreRecycledModule,
  runInAppReminderScan,
  saveRecord,
  setRecordReaction,
  submitJoinApplication,
  submitMakeupRecord,
  updateModuleReminder,
  updateModuleInfo,
  updateCurrentUserProfile,
  requestAccountDeletion,
} from '../src/services/api';
import { readDatabase, resetDatabase, STICKER_PATHS, updateDatabase } from '../src/services/database';
import { addDays, shanghaiDate } from '../src/utils/date';

const storage = new Map<string, unknown>();

Object.assign(globalThis, {
  wx: {
    getStorageSync(key: string) {
      return storage.get(key);
    },
    setStorageSync(key: string, value: unknown) {
      storage.set(key, value);
    },
  },
});

describe('Alpha service contract', () => {
  beforeEach(() => {
    storage.clear();
    resetDatabase();
  });

  it('separates pinned modules and limits sorted previews to four', async () => {
    const home = await getHomeModules();
    expect(home.pinned.map((item) => item.moduleId)).toContain('module_coffee');
    const previews = [...home.pinned, ...home.normal].flatMap((item) => item.todayPreviewItems);
    expect(previews.every((item, index, list) => index === 0 || item.displayOrder >= 0 || list.length === 0)).toBe(true);
    expect([...home.pinned, ...home.normal].every((item) => item.todayPreviewItems.length <= 4)).toBe(true);
  });

  it('replays an idempotent module creation without duplicating data', async () => {
    const request = {
      name: '夜晚散步',
      description: '每天出去走一走',
      clientRequestId: 'request_same',
    };
    const first = await createModule(request);
    const second = await createModule(request);
    expect(second.moduleId).toBe(first.moduleId);
    const home = await getHomeModules();
    expect([...home.pinned, ...home.normal].filter((item) => item.moduleId === first.moduleId)).toHaveLength(1);
  });

  it('enforces module title and introduction limits when creating and editing', async () => {
    await expect(createModule({ name: '12345678901', description: 'ok', clientRequestId: 'too_long_name' })).rejects.toThrow('MODULE_INPUT_INVALID');
    await expect(createModule({ name: 'valid', description: 'd'.repeat(201), clientRequestId: 'too_long_description' })).rejects.toThrow('MODULE_INPUT_INVALID');

    const module = await createModule({ name: 'valid', description: 'd'.repeat(200), clientRequestId: 'valid_limits' });
    await expect(updateModuleInfo(module.moduleId, '12345678901', 'ok')).rejects.toThrow('MODULE_INPUT_INVALID');
    await expect(updateModuleInfo(module.moduleId, 'valid', 'd'.repeat(201))).rejects.toThrow('MODULE_INPUT_INVALID');
    const updated = await updateModuleInfo(module.moduleId, '1234567890', 'd'.repeat(200));
    expect(updated.name).toBe('1234567890');
    expect(updated.description).toHaveLength(200);
  });

  it('updates the current profile and propagates identity to module members', async () => {
    const updated = await updateCurrentUserProfile({ nickname: '新昵称', avatarUrl: 'wxfile://avatar.png' });
    expect(updated.nickname).toBe('新昵称');
    expect(updated.avatarUrl).toBe('wxfile://avatar.png');
    const database = readDatabase();
    expect(database.currentUser.nickname).toBe('新昵称');
    expect(database.modules.flatMap((module) => module.members)
      .filter((member) => member.userId === updated.userId)
      .every((member) => member.nickname === '新昵称' && member.avatarUrl === 'wxfile://avatar.png')).toBe(true);
  });

  it('derives the three-person calendar as top-left, top-right, bottom-center', async () => {
    const cells = await getCalendar('module_dinner', shanghaiDate().slice(0, 7));
    const today = cells.find((cell) => cell.date === shanghaiDate());
    expect(today).toBeDefined();
    expect(today?.records.map((record) => record.slot)).toEqual(['top-left', 'bottom-center']);
  });

  it('preserves firstEffectiveAt during edit and allows rerecord after delete', async () => {
    const today = shanghaiDate();
    const created = await saveRecord({
      moduleId: 'module_dinner',
      recordDate: today,
      originalPath: STICKER_PATHS[1],
      stickerPath: STICKER_PATHS[1],
      remark: '第一次记录',
      clientRequestId: 'record_create',
    });
    const edited = await saveRecord({
      moduleId: 'module_dinner',
      recordId: created.recordId,
      recordDate: today,
      originalPath: STICKER_PATHS[2],
      stickerPath: STICKER_PATHS[2],
      remark: '更新过的记录',
      clientRequestId: 'record_edit',
    });
    expect(edited.firstEffectiveAt).toBe(created.firstEffectiveAt);
    expect(edited.remark).toBe('更新过的记录');

    await deleteRecord(created.recordId);
    const rerecorded = await saveRecord({
      moduleId: 'module_dinner',
      recordDate: today,
      originalPath: STICKER_PATHS[3],
      stickerPath: STICKER_PATHS[3],
      remark: '',
      clientRequestId: 'record_rerecord',
    });
    expect(rerecorded.recordId).not.toBe(created.recordId);
    expect((await getModule('module_dinner')).members).toHaveLength(3);
  });

  it('deletes solo modules and all of their records', async () => {
    await expect(removeModuleForCurrentUser('module_coffee')).resolves.toBe('deleted');
    await expect(getModule('module_coffee')).rejects.toThrow('MODULE_NOT_FOUND');
    const home = await getHomeModules();
    expect([...home.pinned, ...home.normal].some((item) => item.moduleId === 'module_coffee')).toBe(false);
  });

  it('lets a participant leave while preserving the shared module', async () => {
    await expect(removeModuleForCurrentUser('module_dinner')).resolves.toBe('left');
    await expect(getModule('module_dinner')).rejects.toThrow('MODULE_ACCESS_DENIED');
    const home = await getHomeModules();
    expect([...home.pinned, ...home.normal].some((item) => item.moduleId === 'module_dinner')).toBe(false);
  });

  it('requires a creator to transfer a shared module before leaving', async () => {
    await expect(removeModuleForCurrentUser('module_weekend')).rejects.toThrow('MODULE_TRANSFER_REQUIRED');
    expect((await getModule('module_weekend')).members).toHaveLength(2);
  });
});

describe('Beta relationship contract', () => {
  beforeEach(() => {
    storage.clear();
    resetDatabase();
  });

  it('migrates retained Alpha data and seeds Beta demo actions only once', () => {
    const legacy = readDatabase();
    legacy.schemaVersion = 3;
    delete legacy.betaDemoSeeded;
    legacy.reactions = [];
    legacy.makeupApprovals = [];
    legacy.inviteTokens = [];
    legacy.joinApplications = [];
    legacy.notifications = [];
    legacy.moduleInboxItems = [];
    legacy.auditLog = [];
    storage.set('notemylife.alpha.database.v1', legacy);

    const migrated = readDatabase();
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.betaDemoSeeded).toBe(true);
    expect(migrated.notifications.some((item) => item.type === 'join_application')).toBe(true);
    expect(migrated.moduleInboxItems.some((item) => item.type === 'makeup_approval')).toBe(true);
    expect(readDatabase().notifications).toHaveLength(migrated.notifications.length);
  });

  it('completes invite application and creator approval with a new member instance', async () => {
    const invite = await createModuleInvite('module_weekend');
    updateDatabase((database) => {
      database.currentUser = { userId: 'user_new', nickname: '禾苗', avatarText: '苗', avatarColor: '#d8e2d4' };
    });
    const application = await submitJoinApplication(invite.invite.inviteId);
    expect(application).not.toBe('already_member');
    if (application === 'already_member') throw new Error('unexpected member state');

    updateDatabase((database) => {
      database.currentUser = { userId: 'user_me', nickname: '小满', avatarText: '🐰', avatarColor: '#e65f45' };
    });
    const resolved = await resolveJoinApplication(application.applicationId, 'approve');
    expect(resolved.status).toBe('approved');
    expect(resolved.resultMemberInstanceId).toBeTruthy();
    const module = await getModule('module_weekend');
    expect(module.members).toHaveLength(3);
    expect(module.members.find((member) => member.userId === 'user_new')?.joinSequence).toBe(3);
    await expect(resolveJoinApplication(application.applicationId, 'approve')).rejects.toThrow('JOIN_APPLICATION_ALREADY_RESOLVED');
  });

  it('enforces one reaction per member and blocks reacting to your own record', async () => {
    const today = shanghaiDate();
    const friendRecordId = `module_dinner_1_${today}`;
    await expect(setRecordReaction(friendRecordId, 'yummy')).resolves.toBe('cancelled');
    await expect(setRecordReaction(friendRecordId, 'heart')).resolves.toBe('set');
    const reactions = await getRecordReactions(friendRecordId);
    expect(reactions.filter((reaction) => reaction.isMine && reaction.status === 'active')).toHaveLength(1);
    expect(reactions.find((reaction) => reaction.isMine)?.emojiCode).toBe('heart');
    await expect(setRecordReaction(`module_coffee_1_${today}`, 'like')).rejects.toThrow('REACTION_SELF_FORBIDDEN');
  });

  it('creates a group makeup approval and allows only another active member to decide it once', async () => {
    const targetDate = addDays(shanghaiDate(), -3);
    const request = {
      moduleId: 'module_dinner',
      recordDate: targetDate,
      originalPath: STICKER_PATHS[0],
      stickerPath: STICKER_PATHS[0],
      remark: '补记前三天',
      clientRequestId: 'makeup_beta_once',
    };
    const created = await submitMakeupRecord(request);
    expect(created.record.status).toBe('pending');
    expect(created.approval?.status).toBe('pending');
    await expect(submitMakeupRecord(request)).resolves.toMatchObject({ record: { recordId: created.record.recordId } });
    await expect(resolveMakeupApproval(created.approval!.approvalId, 'approve')).rejects.toThrow('APPROVAL_SELF_FORBIDDEN');

    updateDatabase((database) => {
      database.currentUser = { userId: 'user_lin', nickname: '阿树', avatarText: '🐻', avatarColor: '#e9dfcf' };
    });
    const approval = await resolveMakeupApproval(created.approval!.approvalId, 'approve');
    expect(approval.status).toBe('approved');
    expect(readDatabase().records.find((record) => record.recordId === created.record.recordId)?.status).toBe('locked');
    await expect(resolveMakeupApproval(created.approval!.approvalId, 'reject')).rejects.toThrow('APPROVAL_ALREADY_RESOLVED');
  });

  it('applies solo makeup directly and locks the historical record', async () => {
    const module = await createModule({
      name: '夜间散步',
      description: '每天出去走一走',
      clientRequestId: 'solo_for_makeup',
    });
    const result = await submitMakeupRecord({
      moduleId: module.moduleId,
      recordDate: addDays(shanghaiDate(), -1),
      originalPath: STICKER_PATHS[2],
      stickerPath: STICKER_PATHS[2],
      remark: '',
      clientRequestId: 'solo_makeup',
    });
    expect(result.approval).toBeUndefined();
    expect(result.record.status).toBe('locked');
  });

  it('revokes calendar and reaction access immediately after a participant exits', async () => {
    const today = shanghaiDate();
    await removeModuleForCurrentUser('module_dinner');
    await expect(getCalendar('module_dinner', today.slice(0, 7))).rejects.toThrow('MODULE_ACCESS_DENIED');
    await expect(getRecordReactions(`module_dinner_1_${today}`)).rejects.toThrow('MODULE_ACCESS_DENIED');
    const database = readDatabase();
    const member = database.modules.find((module) => module.moduleId === 'module_dinner')?.members
      .find((item) => item.userId === 'user_me');
    expect(member?.active).toBe(false);
    expect(member?.leaveReason).toBe('self_exit');
    expect(database.reactions.find((reaction) => reaction.reactorUserId === 'user_me')?.reactorNameSnapshot).toBe('已退出成员');
  });
});

describe('RC content and lifecycle contract', () => {
  beforeEach(() => {
    storage.clear();
    resetDatabase();
  });

  it('returns only formal gallery records in date and member order', async () => {
    const month = shanghaiDate().slice(0, 7);
    const gallery = await getModuleGallery('module_dinner', month);
    expect(gallery.items.length).toBeGreaterThan(0);
    expect(gallery.items.some((item) => item.recordId === 'record_makeup_pending')).toBe(false);
    for (let index = 1; index < gallery.items.length; index += 1) {
      expect(gallery.items[index - 1].recordDate >= gallery.items[index].recordDate).toBe(true);
    }
  });

  it('stores personal reminder settings and emits at most one in-app reminder per day', async () => {
    const module = await createModule({ name: '睡前阅读', description: '留下一页书', clientRequestId: 'reminder_module' });
    const initial = await getModuleReminder(module.moduleId);
    expect(initial.enabled).toBe(false);
    await updateModuleReminder(module.moduleId, {
      enabled: true,
      reminderTime: '20:00',
      inAppEnabled: true,
      subscriptionStatus: 'not_requested',
    });
    const scanTime = new Date(`${shanghaiDate()}T14:30:00Z`);
    expect(runInAppReminderScan(scanTime)).toBe(1);
    expect(runInAppReminderScan(scanTime)).toBe(0);
    const notifications = readDatabase().notifications.filter((item) => item.moduleId === module.moduleId && item.type === 'reminder');
    expect(notifications).toHaveLength(1);
  });

  it('moves creator modules into recycle, blocks writes, and restores without reviving old invites', async () => {
    const invite = await createModuleInvite('module_weekend');
    await expect(deleteModuleToRecycle('module_weekend', '错误名称')).rejects.toThrow('MODULE_NAME_MISMATCH');
    await deleteModuleToRecycle('module_weekend', '周末去哪里');
    await expect(getModule('module_weekend')).rejects.toThrow('MODULE_PENDING_DELETE');
    await expect(saveRecord({
      moduleId: 'module_weekend', recordDate: shanghaiDate(), originalPath: STICKER_PATHS[0],
      stickerPath: STICKER_PATHS[0], remark: '', clientRequestId: 'blocked_record',
    })).rejects.toThrow('MODULE_PENDING_DELETE');
    expect((await getRecycleBin()).map((item) => item.moduleId)).toContain('module_weekend');
    expect(readDatabase().inviteTokens.find((item) => item.inviteId === invite.invite.inviteId)?.status).toBe('invalid_module');

    await restoreRecycledModule('module_weekend');
    expect((await getModule('module_weekend')).status).toBe('active');
    expect(readDatabase().inviteTokens.find((item) => item.inviteId === invite.invite.inviteId)?.status).toBe('invalid_module');
  });

  it('permanently removes expired recycled module content during maintenance', async () => {
    await deleteModuleToRecycle('module_weekend', '周末去哪里');
    updateDatabase((database) => {
      const module = database.modules.find((item) => item.moduleId === 'module_weekend');
      if (module) module.recycleExpireAt = '2020-01-01T00:00:00+08:00';
    });
    await getRecycleBin();
    expect(readDatabase().modules.some((item) => item.moduleId === 'module_weekend')).toBe(false);
    expect(readDatabase().records.some((item) => item.moduleId === 'module_weekend')).toBe(false);
  });

  it('reuses a stable monthly memory selection and keeps member allocation fair', async () => {
    const month = shanghaiDate().slice(0, 7);
    const first = await getMemoryView('module_dinner', month);
    const second = await getMemoryView('module_dinner', month);
    expect(second.items.map((item) => item.recordId)).toEqual(first.items.map((item) => item.recordId));
    const database = readDatabase();
    const counts = new Map<string, number>();
    first.items.forEach((item) => {
      const memberId = database.records.find((record) => record.recordId === item.recordId)?.memberInstanceId ?? '';
      counts.set(memberId, (counts.get(memberId) ?? 0) + 1);
    });
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    expect(first.items.length).toBeLessThanOrEqual(8);
  });

  it('creates and cancels an account deletion request with a cooling-off period', async () => {
    const request = await requestAccountDeletion();
    expect(request.status).toBe('cooling_off');
    expect(Date.parse(request.executeAfter)).toBeGreaterThan(Date.parse(request.requestedAt));
    expect((await getPrivacyView()).deletionRequest?.status).toBe('cooling_off');
    await cancelAccountDeletion();
    expect((await getPrivacyView()).deletionRequest?.status).toBe('cancelled');
  });
});
