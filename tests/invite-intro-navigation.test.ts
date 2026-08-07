import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/api', () => ({
  getInvitePreview: vi.fn(),
  submitJoinApplication: vi.fn(),
}));
vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

interface PageDefinition {
  goBack: () => void;
}

let pageDefinition: PageDefinition;

describe('invite intro navigation', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('wx', {
      navigateBack: vi.fn(),
      switchTab: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/subpackages/invite-intro/index');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns to the previous page when opened inside the mini program', () => {
    vi.stubGlobal('getCurrentPages', () => [{ route: 'pages/home/index' }, { route: 'subpackages/invite-intro/index' }]);

    pageDefinition.goBack();

    expect(wx.navigateBack).toHaveBeenCalledOnce();
    expect(wx.switchTab).not.toHaveBeenCalled();
  });

  it('opens the home tab when a QR code launch has no previous page', () => {
    vi.stubGlobal('getCurrentPages', () => [{ route: 'subpackages/invite-intro/index' }]);

    pageDefinition.goBack();

    expect(wx.navigateBack).not.toHaveBeenCalled();
    expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/home/index' });
  });
});
