import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getCalendar: vi.fn(),
  getCurrentUser: vi.fn(),
  getHomeModules: vi.fn(),
  getMemoryView: vi.fn(),
  getProfileOverview: vi.fn(),
  getTemplates: vi.fn(async () => []),
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

const memoryResult = {
  reportMode: 'month',
  periodKey: '2026-08',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  isCurrentPeriod: true,
  month: '2026-08',
  moduleId: '',
  moduleName: '全部模块',
  modules: [{ moduleId: 'module_1', name: 'Daily' }],
  momentCount: 1,
  previousMomentCount: 0,
  recordedDays: 1,
  previousRecordedDays: 0,
  participatedModuleCount: 1,
  weeklyRecordCount: 1,
  monthlyJointCompletedDays: 0,
  jointCompletedDays: 0,
  previousJointCompletedDays: 0,
  hasPartnerModules: false,
  longestStreakDays: 1,
  previousLongestStreakDays: 0,
  currentStreakDays: 1,
  currentStreakOngoing: true,
  monthlyReceivedReactionCount: 0,
  receivedReactionCount: 0,
  mostUsedEmoji: '',
  footprint: [{ date: '2026-08-01', recordCount: 1, level: 1 }],
  items: [{
    recordId: 'record_1',
    moduleId: 'module_1',
    recordDate: '2026-08-01',
    stickerPath: '/sticker.png',
    displayOrder: 0,
  }],
};

const createPage = () => ({
  ...pageDefinition,
  data: structuredClone(pageDefinition.data),
  setData(this: { data: Record<string, unknown> }, update: Record<string, unknown>, callback?: () => void) {
    Object.assign(this.data, update);
    callback?.();
  },
}) as unknown as PageDefinition & {
  data: Record<string, any>;
  onLoad: () => void;
  onShow: () => void;
  onHide: () => void;
  changePrimaryTab: (index: number) => void;
  onPrimarySwiperChange: (event: { detail: { current: number } }) => void;
  onPrimarySwiperAnimationFinish: (event: { detail: { current: number } }) => void;
};

describe('memory entry animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.getTemplates.mockResolvedValue([]);
    api.getHomeModules.mockResolvedValue({ pinned: [], normal: [] });
    api.getCurrentUser.mockResolvedValue({ userId: 'user_1' });
    api.getMemoryView.mockResolvedValue(memoryResult);
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
      getImageInfo: vi.fn(({ success }: { success: (value: Record<string, unknown>) => void }) => success({})),
      showToast: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the primary-page transition and reuses memory data on later entries', async () => {
    await import('../src/pages/home/index');
    const page = createPage();
    page.onLoad();
    page.onShow();

    page.changePrimaryTab(1);
    page.onPrimarySwiperChange({ detail: { current: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getMemoryView).toHaveBeenCalledTimes(2);
    expect(page.data.memoryStickers).toHaveLength(1);
    expect(page.data.memoryStickerPhase).toBe('sticker-hidden');

    page.onPrimarySwiperAnimationFinish({ detail: { current: 1 } });
    await vi.advanceTimersByTimeAsync(79);
    expect(page.data.memoryStickerPhase).toBe('sticker-hidden');
    await vi.advanceTimersByTimeAsync(1);
    expect(page.data.memoryStickerPhase).toBe('sticker-entering');
    await vi.runAllTimersAsync();
    expect(page.data.memoryStickerPhase).toBe('sticker-visible');

    page.onPrimarySwiperChange({ detail: { current: 2 } });
    page.onPrimarySwiperAnimationFinish({ detail: { current: 2 } });
    page.changePrimaryTab(1);
    page.onPrimarySwiperChange({ detail: { current: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getMemoryView).toHaveBeenCalledTimes(2);
    expect(page.data.memoryStickerPhase).toBe('sticker-hidden');
    page.onPrimarySwiperAnimationFinish({ detail: { current: 1 } });
    await vi.advanceTimersByTimeAsync(80);
    expect(page.data.memoryStickerPhase).toBe('sticker-entering');
    page.onHide();
  });

  it('replays cached stickers without reloading the standalone memory page', async () => {
    await import('../src/pages/memory/index');
    const page = createPage();
    page.onLoad();
    page.onShow();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getMemoryView).toHaveBeenCalledTimes(2);
    expect(page.data.stickers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(page.data.stickerPhase).toBe('sticker-entering');
    await vi.runAllTimersAsync();
    expect(page.data.stickerPhase).toBe('sticker-visible');

    page.onHide();
    page.onShow();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getMemoryView).toHaveBeenCalledTimes(2);
    expect(page.data.stickerPhase).toBe('sticker-hidden');
    await vi.advanceTimersByTimeAsync(80);
    expect(page.data.stickerPhase).toBe('sticker-entering');
    page.onHide();
  });
});
