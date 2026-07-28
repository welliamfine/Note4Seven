import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarCell } from '../src/types/domain';
import {
  buildMemberCalendarPages,
  createCalendarStickerPlan,
  mergeCalendarSnapshot,
  prepareCalendarForExit,
  showCalendarStickers,
} from '../src/subpackages/module-detail/calendar-controller';
import type { ModuleMember } from '../src/types/domain';

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

  it('builds one calendar per member with at most that member sticker in each date', () => {
    const members = [
      { memberInstanceId: 'member_1', userId: 'user_1', nickname: '小七', avatarText: '七', avatarColor: '#eee' },
      { memberInstanceId: 'member_2', userId: 'user_2', nickname: '阿木', avatarText: '木', avatarColor: '#ddd' },
    ] as ModuleMember[];
    const source = [{
      ...calendar[0],
      records: [
        { recordId: 'rec_1', memberInstanceId: 'member_1', stickerPath: '/one.png' },
        { recordId: 'rec_2', memberInstanceId: 'member_2', stickerPath: '/two.png' },
      ],
    }] as CalendarCell[];

    const pages = buildMemberCalendarPages(source, members, 'user_1');

    expect(pages.map((page) => page.displayName)).toEqual(['我', '阿木']);
    expect(pages[0].cells[0]).toMatchObject({ hasRecord: true, recordId: 'rec_1', stickerPath: '/one.png' });
    expect(pages[1].cells[0]).toMatchObject({ hasRecord: true, recordId: 'rec_2', stickerPath: '/two.png' });
  });

  it('removes a trailing week when every cell is outside the selected month', () => {
    const month = Array.from({ length: 42 }, (_, index) => ({
      ...calendar[0],
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      day: index + 1,
      inMonth: index < 35,
      records: [],
    })) as CalendarCell[];
    const members = [{
      memberInstanceId: 'member_1', userId: 'user_1', nickname: '小七', avatarText: '七', avatarColor: '#eee',
    }] as ModuleMember[];

    const [page] = buildMemberCalendarPages(month, members, 'user_1');

    expect(page.rowCount).toBe(5);
    expect(page.cells).toHaveLength(35);
  });

  it('keeps existing calendar stickers stable and marks only a remote addition for animation', () => {
    const existingRecord = {
      recordId: 'rec_1',
      stickerPath: 'https://media.test/one.png?signature=old',
      memberInstanceId: 'member_1',
    };
    const current = showCalendarStickers([{
      ...calendar[0],
      records: [existingRecord],
    }] as CalendarCell[]);
    const incoming = [{
      ...calendar[0],
      records: [
        { ...existingRecord, stickerPath: 'https://media.test/one.png?signature=new' },
        {
          recordId: 'rec_2',
          stickerPath: 'https://media.test/two.png?signature=new',
          memberInstanceId: 'member_2',
        },
      ],
    }] as CalendarCell[];

    const plan = mergeCalendarSnapshot(current, incoming);

    expect(plan.calendar[0].records[0]).toBe(current[0].records[0]);
    expect(plan.calendar[0].records[1]).toMatchObject({ recordId: 'rec_2', motionPhase: 'sticker-hidden' });
    expect(plan.animatedStickerLocations).toEqual([{ cellIndex: 0, recordIndex: 1, popDelay: 0 }]);
    expect(plan.changedCellIndexes).toEqual([0]);
  });
});
