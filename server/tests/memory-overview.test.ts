import { describe, expect, it, vi } from 'vitest';
import {
  getMemoryOverview,
  resolveMemoryPeriod,
  selectBalancedStickerRows,
  summarizeMemoryRecords,
  type MemoryRecordRow,
} from '../src/services/memory-overview';

describe('memory overview', () => {
  it('resolves calendar months and Monday-based weeks without future ranges', () => {
    expect(resolveMemoryPeriod('month', '2026-07', '2026-08-03')).toMatchObject({
      start: '2026-07-01',
      end: '2026-07-31',
      previousStart: '2026-06-01',
      isCurrent: false,
    });
    expect(resolveMemoryPeriod('week', '2026-08-03', '2026-08-03')).toMatchObject({
      start: '2026-08-03',
      end: '2026-08-03',
      previousStart: '2026-07-27',
      isCurrent: true,
    });
    expect(() => resolveMemoryPeriod('week', '2026-08-04', '2026-08-04')).toThrow('周起始日期必须是周一');
  });

  it('includes makeup records in activity but excludes them from earliest and latest times', () => {
    const rows = [
      { record_id: '1', module_id: '10', record_date: '2026-07-13', source: 'makeup', effective_time: '01:10' },
      { record_id: '2', module_id: '10', record_date: '2026-07-14', source: 'normal', effective_time: '06:42' },
      { record_id: '3', module_id: '11', record_date: '2026-07-15', source: 'normal', effective_time: '23:51' },
    ] as MemoryRecordRow[];

    expect(summarizeMemoryRecords(rows, '2026-07-13', '2026-07-20', '2026-07-19')).toMatchObject({
      momentCount: 3,
      recordedDays: 3,
      participatedModuleCount: 2,
      longestStreakDays: 3,
      earliestTime: '06:42',
      latestTime: '23:51',
    });
  });

  it('aggregates real records, partner snapshots and signed sticker media', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM module_member mine')) return [[
        { module_id: '10', name: '早睡', active_member_count: 2 },
        { module_id: '11', name: '喝水', active_member_count: 1 },
      ]];
      if (sql.includes('FROM life_record r') && sql.includes('TIME_FORMAT')) return [[
        { record_id: '1', module_id: '10', record_date: '2026-07-13', source: 'makeup', effective_time: '01:10' },
        { record_id: '2', module_id: '10', record_date: '2026-07-14', source: 'normal', effective_time: '06:42' },
        { record_id: '3', module_id: '11', record_date: '2026-07-15', source: 'normal', effective_time: '23:51' },
      ]];
      if (sql.includes('FROM daily_module_snapshot')) return [[
        { module_id: '10', record_date: '2026-07-14', required_member_count: 2, is_all_completed: 1 },
        { module_id: '11', record_date: '2026-07-15', required_member_count: 1, is_all_completed: 1 },
      ]];
      if (sql.includes('JOIN media_asset ma')) return [[
        { record_id: '8', module_id: '10', member_instance_id: '201', record_date: '2026-07-14', sticker_file_key: 'media/sticker.webp' },
      ]];
      if (sql.includes('FROM reaction re')) return [[{ reaction_count: 2, emoji_code: 'heart' }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const signedUrl = vi.fn(async (key: string) => `https://signed.example/${key}`);

    const result = await getMemoryOverview(
      { execute } as never,
      { signedUrl } as never,
      '99',
      { mode: 'week', period: '2026-07-13', today: '2026-07-19' },
    );

    expect(result.jointCompletedDays).toBe(1);
    expect(result.hasPartnerModules).toBe(true);
    expect(result.earliestTime).toBe('06:42');
    expect(result.latestTime).toBe('23:51');
    expect(result.latestStickerPath).toBe('https://signed.example/media/sticker.webp');
    expect(result.items[0]?.stickerPath).toBe('https://signed.example/media/sticker.webp');
    expect(result.footprint.find((item) => item.date === '2026-07-14')).toMatchObject({ level: 1 });
    const queries = execute.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(queries).not.toContain('.active = 1');
    expect(queries).not.toContain('WITH ranked_memories');
    expect(queries).not.toContain('ROW_NUMBER()');
    expect(queries).toContain('ORDER BY r.first_effective_at DESC, r.record_id DESC');
  });

  it('represents each member before filling remaining collage slots', () => {
    const rows = [
      { record_id: '1', module_id: '10', member_instance_id: 'a', record_date: '2026-08-01', sticker_file_key: '1.webp' },
      { record_id: '2', module_id: '10', member_instance_id: 'a', record_date: '2026-08-02', sticker_file_key: '2.webp' },
      { record_id: '3', module_id: '10', member_instance_id: 'b', record_date: '2026-08-03', sticker_file_key: '3.webp' },
    ] as never[];
    expect(selectBalancedStickerRows(rows, 3).map((row) => row.record_id)).toEqual(['1', '3', '2']);
  });
});
