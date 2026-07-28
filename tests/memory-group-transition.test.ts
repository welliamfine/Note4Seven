import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getMemoryView: vi.fn() }));

vi.mock('../src/services/api', () => ({ ...api }));
vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

interface PageDefinition {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

let pageDefinition: PageDefinition;

const createPage = () => ({
  ...pageDefinition,
  data: structuredClone(pageDefinition.data),
  setData(this: { data: Record<string, unknown> }, update: Record<string, unknown>, callback?: () => void) {
    Object.assign(this.data, update);
    callback?.();
  },
}) as unknown as PageDefinition & {
  data: Record<string, any>;
  changeGroup: () => Promise<void>;
};

describe('memory group transition', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    api.getMemoryView.mockReset();
    vi.stubGlobal('wx', {
      getImageInfo: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/pages/memory/index');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the old stickers visible until the new images are ready, then pops them in', async () => {
    let finishRequest!: (value: Record<string, unknown>) => void;
    api.getMemoryView.mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }));
    const page = createPage();
    Object.assign(page.data, {
      moduleId: 'module_1',
      month: '2026-07',
      stickers: [{ id: 'old_record', path: '/old.png', popDelay: 0 }],
      stickerPhase: 'sticker-visible',
    });

    const transition = page.changeGroup();
    expect(page.data.changingGroup).toBe(true);
    expect(page.data.stickerPhase).toBe('sticker-visible');

    finishRequest({
      month: '2026-07',
      moduleId: 'module_1',
      moduleName: 'Daily',
      modules: [{ moduleId: 'module_1', name: 'Daily' }],
      recordedDays: 3,
      participatedModuleCount: 1,
      weeklyRecordCount: 4,
      monthlyJointCompletedDays: 2,
      jointCompletedDays: 2,
      currentStreakDays: 5,
      monthlyReceivedReactionCount: 6,
      receivedReactionCount: 6,
      mostUsedEmoji: 'heart',
      items: [{ recordId: 'new_record', stickerPath: '/new.png', displayOrder: 0 }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const getImageInfo = wx.getImageInfo as ReturnType<typeof vi.fn>;
    expect(getImageInfo).toHaveBeenCalledWith(expect.objectContaining({ src: '/new.png' }));
    expect(page.data.stickers[0].id).toBe('old_record');
    expect(page.data.stickerPhase).toBe('sticker-visible');

    getImageInfo.mock.calls[0][0].success({});
    await vi.advanceTimersByTimeAsync(0);
    expect(page.data.stickerPhase).toBe('sticker-leaving');

    await vi.advanceTimersByTimeAsync(150);
    expect(page.data.stickers[0].id).toBe('new_record');
    expect(page.data.stickerPhase).toBe('sticker-hidden');

    await vi.advanceTimersByTimeAsync(80);
    expect(page.data.stickerPhase).toBe('sticker-entering');

    await vi.runAllTimersAsync();
    await transition;
    expect(page.data.stickerPhase).toBe('sticker-visible');
    expect(page.data.changingGroup).toBe(false);
  });
});
