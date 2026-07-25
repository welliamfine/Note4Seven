import type { CalendarCell } from '../../types/domain';
import { createStickerDelays } from '../../utils/sticker-motion';

export type AnimatedCalendarCell = Omit<CalendarCell, 'records'> & {
  records: Array<CalendarCell['records'][number] & { popDelay: number; exitVisible: boolean }>;
};

export function createCalendarStickerPlan(calendar: CalendarCell[], includeGallery: boolean) {
  const galleryId = '__gallery_preview__';
  const stickerIds = [
    ...calendar.flatMap((cell) => cell.records.map((record) => record.recordId)),
    ...(includeGallery ? [galleryId] : []),
  ];
  const { delays, finalDelay } = createStickerDelays(stickerIds);
  const animatedCalendar: AnimatedCalendarCell[] = calendar.map((cell) => ({
    ...cell,
    records: cell.records.map((record) => ({
      ...record,
      popDelay: delays.get(record.recordId) ?? 0,
      exitVisible: false,
    })),
  }));
  return {
    calendar: animatedCalendar,
    galleryDelay: delays.get(galleryId) ?? 0,
    finalDelay,
  };
}

export function showCalendarStickers(calendar: CalendarCell[]): AnimatedCalendarCell[] {
  return calendar.map((cell) => ({
    ...cell,
    records: cell.records.map((record) => ({ ...record, popDelay: 0, exitVisible: true })),
  }));
}

export function prepareCalendarForExit(
  calendar: AnimatedCalendarCell[],
  phase: string,
  elapsedMilliseconds: number,
): AnimatedCalendarCell[] {
  return calendar.map((cell) => ({
    ...cell,
    records: cell.records.map((record) => ({
      ...record,
      exitVisible: phase === 'sticker-visible'
        || (phase === 'sticker-entering' && elapsedMilliseconds >= record.popDelay),
    })),
  }));
}
