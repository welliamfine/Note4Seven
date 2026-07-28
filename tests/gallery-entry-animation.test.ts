import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getModuleGallery: vi.fn() }));

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
  onLoad: (query: Record<string, string | undefined>) => void;
  onShow: () => void;
  onHide: () => void;
};

describe('gallery entry animation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    api.getModuleGallery.mockReset();
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getImageInfo: vi.fn(),
      showToast: vi.fn(),
      navigateBack: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/subpackages/module-gallery/index');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preloads gallery images, pops them in, and reuses the rendered view on show', async () => {
    let finishRequest!: (value: Record<string, unknown>) => void;
    api.getModuleGallery.mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }));
    const page = createPage();
    page.onLoad({ moduleId: 'module_1', month: '2026-07' });
    page.onShow();

    finishRequest({
      moduleId: 'module_1',
      moduleName: 'Daily',
      month: '2026-07',
      items: [
        { recordId: 'record_1', recordDate: '2026-07-20', memberInstanceId: 'member_1', displayName: 'Seven', avatarText: 'S', avatarColor: '#eee', remark: '', stickerPath: '/one.png', originalPath: '/one.png' },
        { recordId: 'record_2', recordDate: '2026-07-21', memberInstanceId: 'member_1', displayName: 'Seven', avatarText: 'S', avatarColor: '#eee', remark: '', stickerPath: '/two.png', originalPath: '/two.png' },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.loading).toBe(false);
    expect(page.data.view.items).toHaveLength(2);
    expect(page.data.stickerPhase).toBe('sticker-hidden');
    const getImageInfo = wx.getImageInfo as ReturnType<typeof vi.fn>;
    expect(getImageInfo).toHaveBeenCalledTimes(2);
    getImageInfo.mock.calls.forEach(([options]) => options.success({}));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(80);
    expect(page.data.stickerPhase).toBe('sticker-entering');
    await vi.runAllTimersAsync();
    expect(page.data.stickerPhase).toBe('sticker-visible');

    const renderedView = page.data.view;
    page.onHide();
    page.onShow();
    expect(page.data.view).toBe(renderedView);
    expect(api.getModuleGallery).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(page.data.stickerPhase).toBe('sticker-visible');
    expect(api.getModuleGallery).toHaveBeenCalledTimes(1);
  });
});
