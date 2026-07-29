import { describe, expect, it } from 'vitest';
import {
  assertNormalRecordDate,
  assertMakeupRecordDate,
  assertRecordDateInRange,
  canMutateRecord,
} from '../src/services/record-policy';
import { shanghaiDate } from '../src/lib/time';

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

describe('record policy', () => {
  it('keeps strict normal records and mutations limited to today', () => {
    expect(() => assertNormalRecordDate('strict', '2026-07-28', '2026-07-28')).not.toThrow();
    expect(() => assertNormalRecordDate('strict', '2026-07-27', '2026-07-28')).toThrow('严厉模式只能正常记录今天');
    expect(canMutateRecord('strict', '2026-07-28', '2026-07-28')).toBe(true);
    expect(canMutateRecord('strict', '2026-07-27', '2026-07-28')).toBe(false);
  });

  it('allows relaxed records and mutations throughout the supported range', () => {
    for (const recordDate of ['1900-01-01', '2026-07-28', '2099-12-31']) {
      expect(() => assertNormalRecordDate('relaxed', recordDate, '2026-07-28')).not.toThrow();
      expect(canMutateRecord('relaxed', recordDate, '2026-07-28')).toBe(true);
    }
  });

  it('keeps strict makeup at D-1 through D-3 and rejects it for relaxed modules', () => {
    const today = shanghaiDate();
    expect(() => assertMakeupRecordDate('strict', addUtcDays(today, -1))).not.toThrow();
    expect(() => assertMakeupRecordDate('strict', addUtcDays(today, -3))).not.toThrow();
    expect(() => assertMakeupRecordDate('strict', addUtcDays(today, -4))).toThrow('只能补记过去三天');
    expect(() => assertMakeupRecordDate('relaxed', addUtcDays(today, -1))).toThrow('轻松模式无需补卡');
  });

  it('rejects invalid and out-of-range calendar dates', () => {
    for (const recordDate of ['2026-02-29', '1899-12-31', '2100-01-01', 'not-a-date']) {
      expect(() => assertRecordDateInRange(recordDate)).toThrow('记录日期必须在');
    }
  });
});
