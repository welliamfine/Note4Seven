import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getMemoryView: vi.fn() }));

vi.mock('../src/services/api', () => ({ ...api }));
vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

interface PageDefinition {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

let pageDefinition: PageDefinition;
let runMemoryCollageActionTransition: (
  currentVisible: boolean,
  targetVisible: boolean,
  isActive: () => boolean,
  onPhase: (phase: string) => void,
) => Promise<boolean>;

const memoryView = (reportMode: 'week' | 'month') => ({
  reportMode,
  periodKey: reportMode === 'month' ? '2026-08' : '2026-08-03',
  periodStart: reportMode === 'month' ? '2026-08-01' : '2026-08-03',
  periodEnd: reportMode === 'month' ? '2026-08-31' : '2026-08-09',
  isCurrentPeriod: true,
  month: '2026-08',
  moduleId: '',
  moduleName: 'All modules',
  modules: [{ moduleId: 'module_1', name: 'Daily' }],
  momentCount: reportMode === 'month' ? 8 : 3,
  previousMomentCount: 0,
  recordedDays: reportMode === 'month' ? 6 : 3,
  previousRecordedDays: 0,
  participatedModuleCount: 1,
  weeklyRecordCount: 3,
  monthlyJointCompletedDays: 0,
  jointCompletedDays: 0,
  previousJointCompletedDays: 0,
  hasPartnerModules: false,
  longestStreakDays: 4,
  previousLongestStreakDays: 0,
  currentStreakDays: 3,
  currentStreakOngoing: true,
  monthlyReceivedReactionCount: 0,
  receivedReactionCount: 0,
  mostUsedEmoji: '',
  footprint: [],
  items: [{
    recordId: `${reportMode}_record`,
    moduleId: 'module_1',
    recordDate: '2026-08-05',
    stickerPath: `/${reportMode}.png`,
    displayOrder: 0,
  }],
});

const createPage = () => ({
  ...pageDefinition,
  data: structuredClone(pageDefinition.data),
  weekViewApplyCount: 0,
  setData(
    this: { data: Record<string, unknown>; weekViewApplyCount: number },
    update: Record<string, unknown>,
    callback?: () => void,
  ) {
    if (update.reportMode === 'week') this.weekViewApplyCount += 1;
    Object.assign(this.data, update);
    callback?.();
  },
  getTabBar: () => undefined,
}) as unknown as PageDefinition & {
  data: Record<string, any>;
  onLoad: () => void;
  onShow: () => void;
  transitionReportMode: (mode: 'week' | 'month') => Promise<void>;
  weekViewApplyCount: number;
};

describe('memory report transition', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    api.getMemoryView.mockReset();
    api.getMemoryView.mockImplementation((
      _moduleId: string | undefined,
      _period: string,
      _forceChange: boolean,
      reportMode: 'week' | 'month',
    ) => Promise.resolve(memoryView(reportMode)));
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
      getImageInfo: vi.fn(({ success }: { success: (value: Record<string, unknown>) => void }) => success({})),
      showToast: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/pages/memory/index');
    ({ runMemoryCollageActionTransition } = await import('../src/utils/memory-report-transition'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rolls text out, swaps to the prewarmed view, then pops surfaces in', async () => {
    (wx.getImageInfo as ReturnType<typeof vi.fn>).mockImplementation(({
      src,
      success,
    }: {
      src: string;
      success: (value: Record<string, unknown>) => void;
    }) => {
      if (src !== '/week.png') success({});
    });
    const page = createPage();
    page.onLoad();
    page.onShow();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.getMemoryView).toHaveBeenCalledTimes(2);
    expect(page.data.reportMode).toBe('month');

    const transition = page.transitionReportMode('week');
    expect(page.data.reportTabMode).toBe('week');
    expect(page.data.reportMode).toBe('month');
    expect(page.data.summaryPeriodMotionClass).toBe('memory-text-exit-up');
    expect(page.data.summaryCountMotionClass).toBe('memory-text-exit-up');
    expect(page.data.summaryStickerPhase).toBe('sticker-leaving');
    expect(page.data.memoryBoardPhase).toBe('memory-surface-leaving');
    expect(page.data.memoryHeatmapPhase).toBe('memory-surface-leaving');

    await vi.advanceTimersByTimeAsync(180);
    expect(page.data.reportMode).toBe('week');
    expect(page.data.loading).toBe(false);
    expect(page.data.summaryPeriodMotionClass).toBe('memory-text-enter-up');
    expect(page.data.summaryCountMotionClass).toBe('memory-text-enter-up');
    expect(page.data.summaryStickerPhase).toBe('sticker-entering');
    expect(page.data.memoryBoardPhase).toBe('memory-surface-entering');
    expect(page.data.memoryHeatmapPhase).toBe('memory-surface-entering');

    await vi.advanceTimersByTimeAsync(400);
    await transition;
    expect(page.data.reportTransitioning).toBe(false);
    expect(page.data.summaryPeriodMotionClass).toBe('memory-text-visible');
    expect(page.data.summaryCountMotionClass).toBe('memory-text-visible');
    expect(page.data.summaryStickerPhase).toBe('sticker-visible');
    expect(page.data.memoryBoardPhase).toBe('memory-surface-visible');
    expect(page.data.memoryHeatmapPhase).toBe('memory-surface-visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.weekViewApplyCount).toBe(1);
  });

  it('shrinks before collapsing and reserves space before popping the control in', async () => {
    const phases: string[] = [];
    const remove = runMemoryCollageActionTransition(true, false, () => true, (phase) => phases.push(phase));
    expect(phases).toEqual(['action-leaving']);
    await vi.advanceTimersByTimeAsync(150);
    expect(phases).toEqual(['action-leaving', 'action-collapsing']);
    await vi.advanceTimersByTimeAsync(220);
    await expect(remove).resolves.toBe(true);
    expect(phases.at(-1)).toBe('action-hidden');

    phases.length = 0;
    const add = runMemoryCollageActionTransition(false, true, () => true, (phase) => phases.push(phase));
    expect(phases).toEqual(['action-expanding']);
    await vi.advanceTimersByTimeAsync(220);
    expect(phases).toEqual(['action-expanding', 'action-entering']);
    await vi.advanceTimersByTimeAsync(400);
    await expect(add).resolves.toBe(true);
    expect(phases.at(-1)).toBe('action-visible');
  });
});
