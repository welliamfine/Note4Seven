import { describe, expect, it } from 'vitest';
import {
  BEIJING_TIME_ZONE,
  BEIJING_UTC_OFFSET,
  daysBetweenShanghai,
  isoWithShanghaiOffset,
  shanghaiDate,
} from '../src/lib/time';

describe('Shanghai business time', () => {
  it('moves to the next business day at Shanghai midnight', () => {
    expect(shanghaiDate(new Date('2026-07-21T15:59:59.999Z'))).toBe('2026-07-21');
    expect(shanghaiDate(new Date('2026-07-21T16:00:00.000Z'))).toBe('2026-07-22');
  });

  it('calculates makeup distance using the Shanghai date', () => {
    const now = new Date('2026-07-22T04:00:00.000Z');
    expect(daysBetweenShanghai('2026-07-21', now)).toBe(1);
    expect(daysBetweenShanghai('2026-07-19', now)).toBe(3);
  });

  it('formats response timestamps with +08:00', () => {
    expect(BEIJING_TIME_ZONE).toBe('Asia/Shanghai');
    expect(BEIJING_UTC_OFFSET).toBe('+08:00');
    expect(isoWithShanghaiOffset(new Date('2026-07-22T04:00:00.000Z'))).toBe('2026-07-22T12:00:00.000+08:00');
  });
});
