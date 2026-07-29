import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getModule: vi.fn(),
  getCurrentUser: vi.fn(),
  getCalendar: vi.fn(),
  refreshModule: vi.fn(),
  saveRecord: vi.fn(),
  getCurrentMakeupApproval: vi.fn(),
  getDateRecords: vi.fn(),
  getRecordReactions: vi.fn(),
  getModuleMonthSummary: vi.fn(() => ({
    currentUserRecordedDays: 4,
    jointCompletedDays: 2,
    receivedReactionCount: 3,
  })),
  refreshModuleMonthSummary: vi.fn(async () => ({
    currentUserRecordedDays: 4,
    jointCompletedDays: 2,
    receivedReactionCount: 3,
  })),
  getModuleInbox: vi.fn(() => Promise.resolve([])),
  getModuleInboxCount: vi.fn(() => 2),
}));

const homePreview = vi.hoisted(() => ({
  queueHomePreviewUpdate: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/services/api', () => ({
  ...api,
  cancelProcessingCheckin: vi.fn(),
  currentUserRecord: vi.fn(),
  createModuleInvite: vi.fn(),
  deleteRecord: vi.fn(),
  discardPrewarmedMediaUpload: vi.fn(),
  getCheckinProcessingStatus: vi.fn(),
  getCurrentMakeupApproval: api.getCurrentMakeupApproval,
  getDateRecords: api.getDateRecords,
  getReactionOptions: vi.fn(() => []),
  getRecordReactions: api.getRecordReactions,
  prewarmMediaUpload: vi.fn(),
  processMedia: vi.fn(),
  refreshMediaStickerSources: vi.fn(),
  retryCheckinMatting: vi.fn(),
  saveRecord: api.saveRecord,
  setRecordReaction: vi.fn(),
  submitMakeupRecord: vi.fn(),
}));

vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));
vi.mock('../src/services/home-preview-cache', () => homePreview);

interface PageDefinition {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

let pageDefinition: PageDefinition;

const setDataPath = (data: Record<string, any>, path: string, value: unknown) => {
  const segments = path.replace(/\[(\d+)]/g, '.$1').split('.');
  let target = data;
  segments.slice(0, -1).forEach((segment) => { target = target[segment]; });
  target[segments[segments.length - 1]] = value;
};

const createPage = () => ({
  ...pageDefinition,
  data: structuredClone(pageDefinition.data),
  setData(this: { data: Record<string, unknown> }, update: Record<string, unknown>, callback?: () => void) {
    Object.entries(update).forEach(([path, value]) => setDataPath(this.data, path, value));
    callback?.();
  },
}) as unknown as PageDefinition & {
  data: Record<string, any>;
  onLoad: (query: Record<string, string | undefined>) => void;
  onShow: () => void;
  onHide: () => void;
  onUnload: () => void;
  submitRecord: () => Promise<void>;
  openDateValue: (recordDate: string) => Promise<void>;
  openEditor: (record?: Record<string, unknown>, recordDate?: string, forceMakeup?: boolean) => void;
};

describe('module detail entry cache', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    api.getModule.mockReset();
    api.getCurrentUser.mockReset();
    api.getCalendar.mockReset();
    api.refreshModule.mockReset();
    api.saveRecord.mockReset();
    api.getCurrentMakeupApproval.mockReset();
    api.getDateRecords.mockReset();
    api.getRecordReactions.mockReset();
    homePreview.queueHomePreviewUpdate.mockClear();
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      showToast: vi.fn(),
      navigateBack: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/subpackages/module-detail/index');
  });

  it('uses direct create and edit actions for relaxed historical and future dates', async () => {
    const page = createPage();
    const member = {
      memberInstanceId: 'member_relaxed', userId: 'user_1', nickname: 'Seven', avatarText: 'S',
      avatarColor: '#eee', role: 'creator', joinSequence: 1, joinedAt: '2026-07-01T00:00:00+08:00', active: true,
    };
    page.data.module = {
      moduleId: 'module_relaxed', name: '随手记录', description: '', mode: 'solo', recordPolicy: 'relaxed',
      status: 'active', creatorUserId: 'user_1', createdAt: '2026-07-01T00:00:00+08:00',
      updatedAt: '2026-07-01T00:00:00+08:00', version: 1, members: [member],
    };
    page.data.moduleId = 'module_relaxed';
    page.data.currentUser = { userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee' };
    api.getDateRecords.mockResolvedValueOnce([]);

    await page.openDateValue('2099-12-31');

    expect(api.getCurrentMakeupApproval).not.toHaveBeenCalled();
    expect(page.data.dateAction).toBe('record_date');
    expect(page.data.dateActionText).toBe('记录这一天');
    expect(page.data.dateMessage).toContain('当天纳入统计');
    page.openEditor(undefined, '2099-12-31');
    expect(page.data.editorMode).toBe('create');
    expect(page.data.editorTitle).toContain('12月31日');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restores the same calendar immediately and only replays stickers', async () => {
    const firstPage = createPage();
    const module = {
      moduleId: 'module_cache_entry',
      name: 'Daily',
      description: '',
      mode: 'solo',
      status: 'active',
      creatorUserId: 'user_1',
      createdAt: '2026-07-01T00:00:00+08:00',
      updatedAt: '2026-07-01T00:00:00+08:00',
      version: 1,
      members: [{
        memberInstanceId: 'member_1',
        userId: 'user_1',
        nickname: 'Seven',
        avatarText: 'S',
        avatarColor: '#eee',
        avatarUrl: 'https://media.test/avatar.png?signature=first',
        role: 'creator',
        joinedAt: '2026-07-01T00:00:00+08:00',
      }],
    };
    const currentUser = {
      userId: 'user_1',
      nickname: 'Seven',
      avatarText: 'S',
      avatarColor: '#eee',
      avatarUrl: 'https://media.test/avatar.png?signature=first',
    };
    const calendar = [{
      date: firstPage.data.today,
      day: Number(String(firstPage.data.today).slice(-2)),
      inMonth: true,
      isToday: true,
      isFuture: false,
      hasRecords: true,
      hasPendingMakeup: false,
      records: [{
        recordId: 'record_1',
        moduleId: module.moduleId,
        memberInstanceId: 'member_1',
        userId: 'user_1',
        recordDate: firstPage.data.today,
        originalPath: 'https://media.test/sticker.png?signature=first',
        stickerPath: 'https://media.test/sticker.png?signature=first',
        remark: '',
        source: 'normal',
        status: 'active',
        firstEffectiveAt: '2026-07-27T00:00:00+08:00',
        updatedAt: '2026-07-27T00:00:00+08:00',
        member: module.members[0],
        slot: 'center',
      }],
    }];
    api.getModule.mockResolvedValue(module);
    api.getCurrentUser.mockResolvedValue(currentUser);
    api.getCalendar.mockResolvedValue(calendar);

    firstPage.onLoad({ moduleId: module.moduleId });
    firstPage.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(firstPage.data.loading).toBe(false);
    expect(api.getModule).toHaveBeenCalledTimes(1);
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(api.getCalendar).toHaveBeenCalledTimes(1);

    const moduleBeforeChildReturn = firstPage.data.module;
    const memberViewsBeforeChildReturn = firstPage.data.memberViews;
    const calendarBeforeChildReturn = firstPage.data.calendar;
    firstPage.onShow();
    expect(firstPage.data.module).toBe(moduleBeforeChildReturn);
    expect(firstPage.data.memberViews).toBe(memberViewsBeforeChildReturn);
    expect(firstPage.data.calendar).toBe(calendarBeforeChildReturn);
    expect(firstPage.data.monthStickerPhase).toBe('sticker-hidden');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(firstPage.data.monthStickerPhase).toBe('sticker-visible');
    expect(api.getModule).toHaveBeenCalledTimes(1);
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(api.getCalendar).toHaveBeenCalledTimes(2);
    firstPage.onUnload();

    const secondPage = createPage();
    secondPage.onLoad({ moduleId: module.moduleId });

    expect(secondPage.data.loading).toBe(false);
    expect(secondPage.data.memberViews[0].avatarUrl).toBe(module.members[0].avatarUrl);
    expect(secondPage.data.calendar[0].records[0].stickerPath).toBe(calendar[0].records[0].stickerPath);
    expect(secondPage.data.cellBackgroundPhase).toBe('cell-fill-visible');
    expect(secondPage.data.todoBadgePhase).toBe('badge-visible');
    expect(secondPage.data.monthStickerPhase).toBe('sticker-hidden');
    expect(api.getModule).toHaveBeenCalledTimes(1);
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(api.getCalendar).toHaveBeenCalledTimes(2);

    secondPage.onShow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(secondPage.data.monthStickerPhase).toBe('sticker-visible');
    expect(api.getCalendar).toHaveBeenCalledTimes(3);
    secondPage.onUnload();
  });

  it('queues the saved today sticker for the cached home before returning', async () => {
    const page = createPage();
    const module = {
      moduleId: 'module_saved_preview',
      name: 'Daily',
      description: '',
      mode: 'solo',
      status: 'active',
      creatorUserId: 'user_1',
      createdAt: '2026-07-01T00:00:00+08:00',
      updatedAt: '2026-07-01T00:00:00+08:00',
      version: 1,
      members: [{
        memberInstanceId: 'member_1',
        userId: 'user_1',
        nickname: 'Seven',
        avatarText: 'S',
        avatarColor: '#eee',
        role: 'creator',
        joinedAt: '2026-07-01T00:00:00+08:00',
      }],
    };
    const currentUser = {
      userId: 'user_1',
      nickname: 'Seven',
      avatarText: 'S',
      avatarColor: '#eee',
    };
    const savedRecord = {
      recordId: 'record_saved',
      mediaId: 'media_1',
      moduleId: module.moduleId,
      memberInstanceId: 'member_1',
      userId: 'user_1',
      recordDate: page.data.today,
      originalPath: 'https://media.test/original.png',
      stickerPath: 'https://media.test/sticker.png',
      remark: '',
      source: 'normal',
      status: 'active',
      firstEffectiveAt: '2026-07-27T00:00:00+08:00',
      updatedAt: '2026-07-27T00:00:00+08:00',
    };
    const calendar = [{
      date: page.data.today,
      day: Number(String(page.data.today).slice(-2)),
      inMonth: true,
      isToday: true,
      isFuture: false,
      hasRecords: true,
      hasPendingMakeup: false,
      records: [{ ...savedRecord, member: module.members[0], slot: 'center' }],
    }];
    api.saveRecord.mockResolvedValue(savedRecord);
    api.getModule.mockResolvedValue(module);
    api.getCurrentUser.mockResolvedValue(currentUser);
    api.getCalendar.mockResolvedValue(calendar);
    Object.assign(page.data, {
      moduleId: module.moduleId,
      module,
      currentUser,
      calendar: [{
        date: page.data.today,
        day: Number(String(page.data.today).slice(-2)),
        inMonth: true,
        isToday: true,
        isFuture: false,
        hasRecords: false,
        hasPendingMakeup: false,
        records: [],
      }],
      memberViews: [{
        memberInstanceId: 'member_1',
        nickname: 'Seven',
        avatarText: 'S',
        avatarColor: '#eee',
        roleLabel: '',
        isMine: true,
        recordedToday: false,
      }],
      memberCalendars: [{
        memberInstanceId: 'member_1',
        displayName: 'Seven',
        avatarText: 'S',
        avatarColor: '#eee',
        rowCount: 1,
        cells: [{
          date: page.data.today,
          day: Number(String(page.data.today).slice(-2)),
          inMonth: true,
          isToday: true,
          hasRecord: false,
          recordId: '',
          stickerPath: '',
        }],
      }],
      editorOpen: true,
      editorMode: 'create',
      editorDate: page.data.today,
      editorOriginalPath: savedRecord.originalPath,
      editorMediaId: savedRecord.mediaId,
      editorStickerPath: savedRecord.stickerPath,
      editorMediaStatus: 'ready',
      saving: false,
    });
    const renderedCalendar = page.data.calendar;
    const renderedMembers = page.data.memberViews;

    const submission = page.submitRecord();
    await vi.runAllTimersAsync();
    await submission;

    expect(homePreview.queueHomePreviewUpdate).toHaveBeenCalledWith({
      type: 'upsert',
      moduleId: module.moduleId,
      recordId: savedRecord.recordId,
      memberInstanceId: savedRecord.memberInstanceId,
      previousRecordId: undefined,
      stickerPath: savedRecord.stickerPath,
    });
    expect(page.data.calendar).toBe(renderedCalendar);
    expect(page.data.memberViews).toBe(renderedMembers);
    expect(page.data.calendar[0].records).toEqual([
      expect.objectContaining({ recordId: savedRecord.recordId, motionPhase: '' }),
    ]);
    expect(api.getCalendar).not.toHaveBeenCalled();
  });

  it('merges another member check-in while preserving the rendered calendar and avatars', async () => {
    const page = createPage();
    const module = {
      moduleId: 'module_remote_sync',
      name: 'Together',
      description: '',
      mode: 'group',
      status: 'active',
      creatorUserId: 'user_1',
      createdAt: '2026-07-01T00:00:00+08:00',
      updatedAt: '2026-07-01T00:00:00+08:00',
      version: 1,
      members: [{
        memberInstanceId: 'member_1', userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee', role: 'creator', joinedAt: '2026-07-01T00:00:00+08:00',
      }, {
        memberInstanceId: 'member_2', userId: 'user_2', nickname: 'Friend', avatarText: 'F', avatarColor: '#ddd', role: 'member', joinedAt: '2026-07-02T00:00:00+08:00',
      }],
    };
    const currentUser = { userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee' };
    const emptyCalendar = [{
      date: page.data.today,
      day: Number(String(page.data.today).slice(-2)),
      inMonth: true,
      isToday: true,
      isFuture: false,
      hasRecords: false,
      hasPendingMakeup: false,
      records: [],
    }];
    const remoteRecord = {
      recordId: 'record_remote',
      moduleId: module.moduleId,
      memberInstanceId: 'member_2',
      userId: 'user_2',
      recordDate: page.data.today,
      originalPath: 'https://media.test/remote.png?signature=one',
      stickerPath: 'https://media.test/remote.png?signature=one',
      remark: '',
      source: 'normal',
      status: 'active',
      firstEffectiveAt: '2026-07-27T00:00:00+08:00',
      updatedAt: '2026-07-27T00:00:00+08:00',
      member: module.members[1],
      slot: 'bottom-center',
    };
    api.getModule.mockResolvedValue(module);
    api.getCurrentUser.mockResolvedValue(currentUser);
    api.getCalendar
      .mockResolvedValueOnce(emptyCalendar)
      .mockResolvedValueOnce([{ ...emptyCalendar[0], hasRecords: true, records: [remoteRecord] }]);

    page.onLoad({ moduleId: module.moduleId });
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);
    const calendar = page.data.calendar;
    const memberViews = page.data.memberViews;

    await vi.advanceTimersByTimeAsync(4_000);

    expect(page.data.calendar).toBe(calendar);
    expect(page.data.memberViews).toBe(memberViews);
    expect(page.data.calendar[0].records).toEqual([
      expect.objectContaining({ recordId: 'record_remote', motionPhase: '' }),
    ]);
    expect(page.data.memberViews[1].recordedToday).toBe(true);
    expect(api.getCalendar).toHaveBeenCalledTimes(2);
    page.onUnload();
  });

  it('removes an exited member from detail without replacing the module or calendar', async () => {
    const page = createPage();
    const members = [{
      memberInstanceId: 'member_1', userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee',
      role: 'creator', joinSequence: 1, joinedAt: '2026-07-01T00:00:00+08:00', active: true,
    }, {
      memberInstanceId: 'member_2', userId: 'user_2', nickname: 'Friend', avatarText: 'F', avatarColor: '#ddd',
      role: 'member', joinSequence: 2, joinedAt: '2026-07-02T00:00:00+08:00', active: true,
    }];
    const module = {
      moduleId: 'module_member_exit', name: 'Together', description: '', mode: 'group', status: 'active',
      creatorUserId: 'user_1', createdAt: '2026-07-01T00:00:00+08:00', updatedAt: '2026-07-01T00:00:00+08:00',
      version: 1, members,
    };
    const currentUser = { userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee' };
    const calendar = [{
      date: page.data.today,
      day: Number(String(page.data.today).slice(-2)),
      inMonth: true,
      isToday: true,
      isFuture: false,
      hasRecords: false,
      hasPendingMakeup: false,
      records: [],
    }];
    api.getModule.mockResolvedValue(module);
    api.getCurrentUser.mockResolvedValue(currentUser);
    api.getCalendar.mockResolvedValue(calendar);
    api.refreshModule.mockResolvedValue({ ...module, members: [members[0]], version: 2 });

    page.onLoad({ moduleId: module.moduleId });
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);
    const renderedModule = page.data.module;
    const renderedCalendar = page.data.calendar;

    await vi.advanceTimersByTimeAsync(4_000);

    expect(page.data.module).toBe(renderedModule);
    expect(page.data.calendar).toBe(renderedCalendar);
    expect(page.data.module.members).toHaveLength(1);
    expect(page.data.memberViews).toHaveLength(1);
    expect(page.data.memberCalendars).toHaveLength(1);
    expect(page.data.module.members[0].memberInstanceId).toBe('member_1');
    expect(api.refreshModule).toHaveBeenCalledWith(module.moduleId);
    page.onUnload();
  });
});
