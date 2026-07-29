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
    Object.entries(update).forEach(([path, value]) => {
      const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = this.data;
      keys.slice(0, -1).forEach((key) => { target = target[key] as Record<string, unknown>; });
      target[keys.at(-1)!] = value;
    });
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

  it('preloads gallery images and replaces an edited sticker without reloading the page', async () => {
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
    await vi.advanceTimersByTimeAsync(600);
    expect(page.data.stickerPhase).toBe('sticker-visible');

    const renderedView = page.data.view;
    const unchangedItem = renderedView.items[1];
    page.onHide();
    api.getModuleGallery.mockResolvedValueOnce({
      moduleId: 'module_1',
      moduleName: 'Daily',
      month: '2026-07',
      items: [
        { recordId: 'record_1', recordDate: '2026-07-20', memberInstanceId: 'member_1', displayName: 'Seven', avatarText: 'S', avatarColor: '#eee', remark: '', stickerPath: '/one-new.png', originalPath: '/one-new.png' },
        { recordId: 'record_2', recordDate: '2026-07-21', memberInstanceId: 'member_1', displayName: 'Seven', avatarText: 'S', avatarColor: '#eee', remark: '', stickerPath: '/two.png', originalPath: '/two.png' },
      ],
    });
    page.onShow();
    expect(page.data.view).toBe(renderedView);
    expect(page.data.loading).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    const refreshedPreload = getImageInfo.mock.calls.find(([options]) => options.src === '/one-new.png');
    expect(refreshedPreload).toBeTruthy();
    refreshedPreload?.[0].success({});
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getModuleGallery).toHaveBeenCalledTimes(2);
    expect(page.data.view.items[0].stickerPath).toBe('/one-new.png');
    expect(page.data.view.items[0].syncPhase).toBe('sticker-hidden');
    expect(page.data.view.items[1]).toBe(unchangedItem);
    expect(page.data.loading).toBe(false);
    page.onHide();
    expect(page.data.view.items[0].syncPhase).toBe('');
  });
});
