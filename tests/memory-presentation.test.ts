import { describe, expect, it } from 'vitest';
import type { MemoryView } from '../src/services/api';
import { buildMemoryPresentation } from '../src/utils/memory-presentation';

const baseView = (): MemoryView => ({
  reportMode: 'month',
  periodKey: '2026-07',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  isCurrentPeriod: false,
  momentCount: 8,
  previousMomentCount: 5,
  recordedDays: 6,
  previousRecordedDays: 4,
  participatedModuleCount: 2,
  jointCompletedDays: 3,
  previousJointCompletedDays: 1,
  hasPartnerModules: true,
  longestStreakDays: 4,
  previousLongestStreakDays: 2,
  currentStreakDays: 4,
  currentStreakOngoing: false,
  earliestTime: '06:42',
  latestTime: '23:51',
  receivedReactionCount: 2,
  weeklyRecordCount: 8,
  moduleId: '',
  moduleName: '',
  month: '2026-07',
  modules: [{ moduleId: 'm_1', name: '早睡' }],
  items: [{ recordId: 'r_1', moduleId: 'm_1', recordDate: '2026-07-13', stickerPath: '/sticker.png', displayOrder: 0 }],
  footprint: [{ date: '2026-07-13', recordCount: 3, level: 3, stickerPath: '/sticker.png' }],
  monthlyJointCompletedDays: 3,
  monthlyReceivedReactionCount: 2,
  mostUsedEmoji: '❤️',
  latestStickerPath: '/latest.png',
});

describe('memory presentation', () => {
  it('builds the monthly Figma sections from real overview values', () => {
    const presentation = buildMemoryPresentation(baseView(), '2026-08-03');

    expect(presentation.periodLabel).toBe('2026年7月');
    expect(presentation.summaryTitle).toBe('这个月，你生产了 8 张贴纸！');
    expect(presentation.latestStickerPath).toBe('/latest.png');
    expect(presentation.metrics.map((item) => item.label)).toEqual(['记录天数', '连续天数', '共同完成']);
    expect(presentation.metrics.every((item) => !('note' in item))).toBe(true);
    expect(presentation.calendarCells.find((item) => item.date === '2026-07-13')).toMatchObject({
      level: 3,
      stickerPath: '/sticker.png',
    });
    expect(presentation.calendarCells[0].date).toBe('2026-06-28');
    expect(presentation.calendarCells[3].date).toBe('2026-07-01');
  });

  it('hides partner copy for a solo module and builds seven weekly cells', () => {
    const view: MemoryView = {
      ...baseView(),
      reportMode: 'week',
      periodKey: '2026-07-13',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-19',
      moduleId: 'm_1',
      moduleName: '早睡',
      hasPartnerModules: false,
    };
    const presentation = buildMemoryPresentation(view, '2026-08-03');

    expect(presentation.metrics[2]).toMatchObject({ label: '记录次数', value: 8, unit: '次' });
    expect(presentation.summaryTitle).toBe('这一周，你生产了 8 张贴纸！');
    expect(presentation.weekCells).toHaveLength(7);
    expect(presentation.timeSummary).toBe('最早 06:42 · 最晚 23:51');
  });
});
