import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeHomePreviewUpdates, queueHomePreviewUpdate } from '../src/services/home-preview-cache';
import { shanghaiDate } from '../src/utils/date';

const api = vi.hoisted(() => ({
  getHomeModules: vi.fn(),
  getCalendar: vi.fn(),
  getCurrentUser: vi.fn(),
  getTemplates: vi.fn(async () => []),
  getMemoryView: vi.fn(),
  getProfileOverview: vi.fn(),
  setModulePinned: vi.fn(),
}));

vi.mock('../src/services/api', () => ({
  ...api,
  MODULE_DESCRIPTION_MAX_LENGTH: 200,
  MODULE_NAME_MAX_LENGTH: 10,
  PROFILE_NICKNAME_MAX_LENGTH: 20,
  createModule: vi.fn(),
  updateCurrentUserProfile: vi.fn(),
}));

vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

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

const homeResult = {
  pinned: [{
    moduleId: 'module_1',
    name: 'Daily',
    description: '',
    mode: 'solo',
    status: 'active',
    creatorUserId: 'user_1',
    createdAt: '2026-07-01T00:00:00+08:00',
    updatedAt: '2026-07-01T00:00:00+08:00',
    members: [],
    version: 1,
    pinned: true,
    unreadInboxCount: 0,
    todayPreviewItems: [{ recordId: 'record_1', stickerPath: '/sticker.png', displayOrder: 0 }],
  }],
  normal: [],
};

const createPage = () => {
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(update: Record<string, unknown>, callback?: () => void) {
      Object.entries(update).forEach(([path, value]) => setDataPath(this.data, path, value));
      callback?.();
    },
  } as PageDefinition & {
    data: Record<string, any>;
    setData: (update: Record<string, unknown>, callback?: () => void) => void;
    onLoad: () => void;
    onShow: () => void;
    onHide: () => void;
    loadHome: (showLoading?: boolean) => Promise<boolean>;
    togglePinFromBubble: (event: { currentTarget: { dataset: { id: string } } }) => Promise<void>;
  };
  return page;
};

describe('home return cache', () => {
  beforeEach(async () => {
    await consumeHomePreviewUpdates();
    vi.useFakeTimers();
    api.getHomeModules.mockReset();
    api.getCalendar.mockReset();
    api.getCurrentUser.mockReset();
    api.getTemplates.mockClear();
    api.setModulePinned.mockReset();
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      showToast: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/pages/home/index');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconciles cached home previews without replacing its modules', async () => {
    api.getHomeModules.mockResolvedValueOnce(homeResult);
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);
    const pinnedModules = page.data.pinnedModules;

    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.data.loading).toBe(false);
    expect(page.data.pinnedModules).toBe(pinnedModules);
    expect(api.getHomeModules).toHaveBeenCalledTimes(2);
    expect(api.getHomeModules).toHaveBeenNthCalledWith(1, { reconcileNotifications: true });
    expect(api.getHomeModules).toHaveBeenNthCalledWith(2, { reconcileNotifications: false });
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    page.onHide();
  });

  it('keeps the local module order after pinning without reloading home', async () => {
    api.getHomeModules.mockResolvedValueOnce(homeResult);
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    api.setModulePinned.mockResolvedValueOnce(undefined);
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);

    const pinChange = page.togglePinFromBubble({ currentTarget: { dataset: { id: 'module_1' } } });
    await vi.runAllTimersAsync();
    await pinChange;

    expect(api.setModulePinned).toHaveBeenCalledWith('module_1', false);
    expect(page.data.pinnedModules).toHaveLength(0);
    expect(page.data.normalModules[0].moduleId).toBe('module_1');
    expect(api.getHomeModules).toHaveBeenCalledTimes(1);
  });

  it('applies a preloaded check-in sticker without replacing home modules or avatars', async () => {
    api.getHomeModules.mockImplementation(async () => structuredClone(homeResult));
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);
    const pinnedModules = page.data.pinnedModules;
    const members = page.data.pinnedModules[0].members;

    void queueHomePreviewUpdate({
      type: 'upsert',
      moduleId: 'module_1',
      recordId: 'record_2',
      stickerPath: '/new-sticker.png',
    });
    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.data.pinnedModules).toBe(pinnedModules);
    expect(page.data.pinnedModules[0].members).toBe(members);
    expect(page.data.pinnedModules[0].todayPreviewItems).toEqual([
      { recordId: 'record_1', stickerPath: '/sticker.png', displayOrder: 0 },
      { recordId: 'record_2', stickerPath: '/new-sticker.png', displayOrder: 1 },
    ]);
    expect(page.data.homeStickerPhase).toBe('sticker-visible');
    expect(api.getHomeModules).toHaveBeenCalledTimes(2);
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    page.onHide();
  });

  it('merges another device check-in without replacing the visible module or avatars', async () => {
    api.getHomeModules
      .mockResolvedValueOnce(homeResult)
      .mockResolvedValueOnce({
        pinned: [{
          ...homeResult.pinned[0],
          todayPreviewItems: [
            ...homeResult.pinned[0].todayPreviewItems,
            { recordId: 'record_remote', stickerPath: '/remote-sticker.png', displayOrder: 1 },
          ],
        }],
        normal: [],
      });
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);
    const pinnedModules = page.data.pinnedModules;
    const members = page.data.pinnedModules[0].members;

    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.data.pinnedModules).toBe(pinnedModules);
    expect(page.data.pinnedModules[0].members).toBe(members);
    expect(page.data.pinnedModules[0].todayPreviewItems).toEqual([
      { recordId: 'record_1', stickerPath: '/sticker.png', displayOrder: 0 },
      { recordId: 'record_remote', stickerPath: '/remote-sticker.png', displayOrder: 1, motionPhase: '' },
    ]);
    expect(api.getHomeModules).toHaveBeenCalledTimes(2);
    page.onHide();
  });

  it('removes an exited member avatar without replacing the home module', async () => {
    const members = [{
      memberInstanceId: 'member_1', userId: 'user_1', nickname: 'Seven', avatarText: 'S', avatarColor: '#eee',
      avatarUrl: 'https://media.test/one.png?signature=old', role: 'creator', joinSequence: 1,
      joinedAt: '2026-07-01T00:00:00+08:00', active: true,
    }, {
      memberInstanceId: 'member_2', userId: 'user_2', nickname: 'Friend', avatarText: 'F', avatarColor: '#ddd',
      avatarUrl: 'https://media.test/two.png?signature=old', role: 'member', joinSequence: 2,
      joinedAt: '2026-07-02T00:00:00+08:00', active: true,
    }];
    const initial = {
      pinned: [{ ...homeResult.pinned[0], mode: 'group', members }],
      normal: [],
    };
    const afterExit = {
      pinned: [{
        ...initial.pinned[0],
        members: [{ ...members[0], avatarUrl: 'https://media.test/one.png?signature=new' }],
      }],
      normal: [],
    };
    api.getHomeModules.mockResolvedValueOnce(initial).mockResolvedValueOnce(afterExit);
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);
    const pinnedModules = page.data.pinnedModules;
    const remainingMember = page.data.pinnedModules[0].members[0];

    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.data.pinnedModules).toBe(pinnedModules);
    expect(page.data.pinnedModules[0].members).toHaveLength(1);
    expect(page.data.pinnedModules[0].members[0]).toBe(remainingMember);
    expect(api.getHomeModules).toHaveBeenCalledTimes(2);
    page.onHide();
  });

  it('repairs a remote check-in snapshot instead of evicting an active member sticker', async () => {
    const members = [1, 2, 3, 4].map((index) => ({
      memberInstanceId: `member_${index}`,
      userId: `user_${index}`,
      nickname: `Member ${index}`,
      avatarText: String(index),
      avatarColor: '#eee',
      role: index === 1 ? 'creator' as const : 'member' as const,
      joinSequence: index,
      joinedAt: `2026-07-0${index}T00:00:00+08:00`,
      active: true,
    }));
    const previews = [1, 2, 3].map((index) => ({
      recordId: `record_${index}`,
      memberInstanceId: `member_${index}`,
      stickerPath: `/${index}.png`,
      displayOrder: index - 1,
    }));
    const initial = {
      pinned: [{ ...homeResult.pinned[0], mode: 'group', members, todayPreviewItems: previews }],
      normal: [],
    };
    const incompleteRemote = {
      pinned: [{
        ...initial.pinned[0],
        todayPreviewItems: previews,
      }],
      normal: [],
    };
    const today = shanghaiDate();
    const records = [1, 2, 3, 4].map((index) => ({
      recordId: `record_${index}`,
      moduleId: 'module_1',
      memberInstanceId: `member_${index}`,
      userId: `user_${index}`,
      recordDate: today,
      originalPath: `/${index}.png`,
      stickerPath: `/${index}.png`,
      remark: '',
      source: 'normal' as const,
      status: 'active' as const,
      firstEffectiveAt: `${today}T00:00:0${index}+08:00`,
      updatedAt: `${today}T00:00:0${index}+08:00`,
    }));
    api.getHomeModules.mockResolvedValueOnce(initial).mockResolvedValueOnce(incompleteRemote);
    api.getCalendar.mockResolvedValueOnce([{
      date: today, day: Number(today.slice(8, 10)), inMonth: true, isToday: true, isFuture: false,
      hasRecords: true, records,
    }]);
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'user_1' });
    const page = createPage();
    page.onLoad();
    await page.loadHome(true);
    const pinnedModules = page.data.pinnedModules;
    const oldPreviews = [...page.data.pinnedModules[0].todayPreviewItems];

    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(api.getCalendar).toHaveBeenCalledWith('module_1', expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(page.data.pinnedModules).toBe(pinnedModules);
    expect(page.data.pinnedModules[0].todayPreviewItems).toHaveLength(4);
    expect(page.data.pinnedModules[0].todayPreviewItems.slice(0, 3)).toEqual(oldPreviews);
    expect(page.data.pinnedModules[0].todayPreviewItems[3]).toMatchObject({
      recordId: 'record_4',
      memberInstanceId: 'member_4',
      motionPhase: '',
    });
    page.onHide();
  });
});
