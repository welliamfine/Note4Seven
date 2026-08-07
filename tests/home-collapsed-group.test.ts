import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/api', () => ({
  MODULE_DESCRIPTION_MAX_LENGTH: 200,
  MODULE_NAME_MAX_LENGTH: 10,
  PROFILE_NICKNAME_MAX_LENGTH: 20,
  createModule: vi.fn(),
  getCalendar: vi.fn(),
  getCurrentUser: vi.fn(),
  getHomeModules: vi.fn(),
  getMemoryView: vi.fn(),
  getProfileOverview: vi.fn(),
  getTemplates: vi.fn(),
  setModulePinned: vi.fn(),
  updateCurrentUserProfile: vi.fn(),
}));
vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

interface PageDefinition {
  data: Record<string, unknown>;
  openModule: (event: WechatMiniprogram.TouchEvent) => void;
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
  togglePinnedGroup: () => void;
  toggleNormalGroup: () => void;
};

const cardTap = (pinned: boolean): WechatMiniprogram.TouchEvent => ({
  currentTarget: { dataset: { id: 'module_1', pinned } },
} as unknown as WechatMiniprogram.TouchEvent);

describe('collapsed home groups', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      navigateTo: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/pages/home/index');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { pinned: true, expandedKey: 'pinnedExpanded', expandingKey: 'pinnedExpanding' },
    { pinned: false, expandedKey: 'normalExpanded', expandingKey: 'normalExpanding' },
  ])('expands a collapsed $expandedKey group instead of opening its top card', async ({ pinned, expandedKey, expandingKey }) => {
    const page = createPage();
    page.data[expandedKey] = false;

    page.openModule(cardTap(pinned));

    expect(page.data[expandingKey]).toBe(true);
    expect(wx.navigateTo).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(page.data[expandedKey]).toBe(true);
    expect(page.data[expandingKey]).toBe(false);
  });

  it('opens a module normally when its group is expanded', () => {
    const page = createPage();
    page.data.normalExpanded = true;

    page.openModule(cardTap(false));

    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: '/subpackages/module-detail/index?moduleId=module_1',
    });
  });
});
