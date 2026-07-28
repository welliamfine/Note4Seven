import type { CalendarCell, ModuleMember } from '../../types/domain';
import { imageSourceIdentity } from '../../utils/image-preload';
import { createStickerDelays } from '../../utils/sticker-motion';

export type AnimatedCalendarCell = Omit<CalendarCell, 'records'> & {
  records: Array<CalendarCell['records'][number] & {
    popDelay: number;
    exitVisible: boolean;
    motionPhase?: '' | 'sticker-hidden' | 'sticker-entering' | 'sticker-visible';
  }>;
};

export interface CalendarStickerLocation {
  cellIndex: number;
  recordIndex: number;
  popDelay: number;
}

export interface CalendarSyncPlan {
  calendar: AnimatedCalendarCell[];
  changedCellIndexes: number[];
  animatedStickerLocations: CalendarStickerLocation[];
  animatedStickerSources: string[];
  finalDelay: number;
}

export interface MemberCalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  hasRecord: boolean;
  recordId: string;
  stickerPath: string;
}

export interface MemberCalendarPage {
  memberInstanceId: string;
  displayName: string;
  avatarText: string;
  avatarColor: string;
  avatarUrl?: string;
  rowCount: number;
  cells: MemberCalendarCell[];
}

export function buildMemberCalendarPages(
  calendar: CalendarCell[],
  members: ModuleMember[],
  currentUserId: string,
): MemberCalendarPage[] {
  const lastInMonthIndex = calendar.reduce(
    (lastIndex, cell, index) => (cell.inMonth ? index : lastIndex),
    -1,
  );
  const visibleCellCount = lastInMonthIndex < 0
    ? calendar.length
    : Math.ceil((lastInMonthIndex + 1) / 7) * 7;
  const visibleCalendar = calendar.slice(0, visibleCellCount);
  return members.map((member) => ({
    memberInstanceId: member.memberInstanceId,
    displayName: member.userId === currentUserId ? '我' : member.nickname,
    avatarText: member.avatarText,
    avatarColor: member.avatarColor,
    avatarUrl: member.avatarUrl,
    rowCount: Math.ceil(visibleCalendar.length / 7),
    cells: visibleCalendar.map((cell) => {
      const record = cell.records.find((item) => item.memberInstanceId === member.memberInstanceId);
      return {
        date: cell.date,
        day: cell.day,
        inMonth: cell.inMonth,
        isToday: cell.isToday,
        hasRecord: Boolean(record),
        recordId: record?.recordId ?? '',
        stickerPath: record?.stickerPath ?? '',
      };
    }),
  }));
}

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

export function mergeCalendarSnapshot(
  current: AnimatedCalendarCell[],
  incoming: CalendarCell[],
): CalendarSyncPlan {
  const currentByDate = new Map(current.map((cell) => [cell.date, cell]));
  const animatedRecordIds: string[] = [];
  incoming.forEach((cell) => {
    const previous = currentByDate.get(cell.date);
    cell.records.forEach((record) => {
      const existing = previous?.records.find((candidate) => candidate.recordId === record.recordId);
      if (!existing || imageSourceIdentity(existing.stickerPath) !== imageSourceIdentity(record.stickerPath)) {
        animatedRecordIds.push(record.recordId);
      }
    });
  });
  const stickerPlan = createStickerDelays(animatedRecordIds);
  const changedCellIndexes: number[] = [];
  const animatedStickerLocations: CalendarStickerLocation[] = [];
  const animatedStickerSources: string[] = [];
  const calendar = incoming.map<AnimatedCalendarCell>((cell, cellIndex) => {
    const previous = currentByDate.get(cell.date);
    const records = cell.records.map((record, recordIndex) => {
      const existing = previous?.records.find((candidate) => candidate.recordId === record.recordId);
      if (existing && imageSourceIdentity(existing.stickerPath) === imageSourceIdentity(record.stickerPath)) {
        return existing.slot === record.slot
          ? existing
          : { ...existing, slot: record.slot, member: record.member };
      }
      const popDelay = stickerPlan.delays.get(record.recordId) ?? 0;
      animatedStickerLocations.push({ cellIndex, recordIndex, popDelay });
      animatedStickerSources.push(record.stickerPath);
      return {
        ...record,
        popDelay,
        exitVisible: true,
        motionPhase: 'sticker-hidden' as const,
      };
    });
    const previousRecordIds = previous?.records.map((record) => record.recordId).join('|') ?? '';
    const nextRecordIds = records.map((record) => record.recordId).join('|');
    const scalarChanged = !previous
      || previous.hasRecords !== cell.hasRecords
      || previous.hasPendingMakeup !== cell.hasPendingMakeup
      || previous.processingCheckinId !== cell.processingCheckinId;
    if (scalarChanged || previousRecordIds !== nextRecordIds || records.some((record, index) => record !== previous?.records[index])) {
      changedCellIndexes.push(cellIndex);
    }
    return { ...cell, records };
  });
  return {
    calendar,
    changedCellIndexes,
    animatedStickerLocations,
    animatedStickerSources,
    finalDelay: stickerPlan.finalDelay,
  };
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
