import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarCell } from '../src/types/domain';
import {
  createCalendarStickerPlan,
  prepareCalendarForExit,
  showCalendarStickers,
} from '../src/subpackages/module-detail/calendar-controller';

const calendar = [{
  date: '2026-07-25',
  day: 25,
  inMonth: true,
  isToday: true,
  isFuture: false,
  hasRecords: true,
  records: [
    { recordId: 'rec_1' },
    { recordId: 'rec_2' },
  ],
}] as unknown as CalendarCell[];

describe('module detail calendar sticker controller', () => {
  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.999));
  afterEach(() => vi.restoreAllMocks());

  it('creates stable entry delays including the gallery preview', () => {
    const plan = createCalendarStickerPlan(calendar, true);
    expect(plan.calendar[0].records.map((record) => record.popDelay)).toEqual([0, 120]);
    expect(plan.galleryDelay).toBe(240);
    expect(plan.finalDelay).toBe(plan.galleryDelay);
    expect(plan.calendar[0].records.every((record) => !record.exitVisible)).toBe(true);
  });

  it('preserves only stickers already visible when an entry animation exits', () => {
    const plan = createCalendarStickerPlan(calendar, false);
    const exiting = prepareCalendarForExit(plan.calendar, 'sticker-entering', 50);
    expect(exiting[0].records.map((record) => record.exitVisible)).toEqual([true, false]);
    expect(showCalendarStickers(calendar)[0].records.every((record) => record.exitVisible)).toBe(true);
  });
});
