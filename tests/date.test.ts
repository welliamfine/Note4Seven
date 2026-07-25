import { describe, expect, it } from 'vitest';
import { addDays, buildMonthGrid, differenceInDays, monthLabel, shanghaiDate } from '../src/utils/date';

describe('business date utilities', () => {
  it('uses Asia/Shanghai rather than the device day', () => {
    expect(shanghaiDate(new Date('2026-07-15T17:00:00Z'))).toBe('2026-07-16');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('builds only the Monday-first rows needed by each month', () => {
    const fourRows = buildMonthGrid('2027-02');
    expect(fourRows).toHaveLength(28);
    expect(fourRows[0].date).toBe('2027-02-01');
    expect(fourRows[27].date).toBe('2027-02-28');

    const fiveRows = buildMonthGrid('2026-07');
    expect(fiveRows).toHaveLength(35);
    expect(fiveRows[0].date).toBe('2026-06-29');
    expect(fiveRows[34].date).toBe('2026-08-02');

    const sixRows = buildMonthGrid('2026-08');
    expect(sixRows).toHaveLength(42);
    expect(sixRows[0].date).toBe('2026-07-27');
    expect(sixRows[41].date).toBe('2026-09-06');
  });

  it('compares business dates and formats month labels', () => {
    expect(differenceInDays('2026-07-18', '2026-07-15')).toBe(3);
    expect(monthLabel('2026-07')).toBe('2026年7月');
  });
});
