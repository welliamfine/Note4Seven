const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const BEIJING_TIME_ZONE = 'Asia/Shanghai';
export const BEIJING_UTC_OFFSET = '+08:00';

export function shanghaiDate(now = new Date()): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiNowIso(now = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return shifted.toISOString().replace('Z', BEIJING_UTC_OFFSET);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

export function differenceInDays(date: string, reference = shanghaiDate()): number {
  const left = Date.parse(`${date}T00:00:00Z`);
  const right = Date.parse(`${reference}T00:00:00Z`);
  return Math.round((left - right) / 86_400_000);
}

export function monthLabel(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return `${year}年${value}月`;
}

export function dateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${parsed.getUTCMonth() + 1}月${parsed.getUTCDate()}日 · ${weekdays[parsed.getUTCDay()]}`;
}

export function buildMonthGrid(month: string, weekStartsOn: 0 | 1 = 1): Array<{ date: string; day: number; inMonth: boolean }> {
  const [year, value] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, value - 1, 1));
  const leadingDayCount = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - leadingDayCount);
  const daysInMonth = new Date(Date.UTC(year, value, 0)).getUTCDate();
  const cellCount = Math.ceil((leadingDayCount + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      day: date.getUTCDate(),
      inMonth: date.getUTCMonth() === value - 1,
    };
  });
}

export function previousMonth(month: string): string {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return date.toISOString().slice(0, 7);
}

export function nextMonth(month: string): string {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value, 1));
  return date.toISOString().slice(0, 7);
}

export function weekStartOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - weekday + 1);
  return parsed.toISOString().slice(0, 10);
}

export function previousWeek(weekStart: string): string {
  return addDays(weekStart, -7);
}

export function nextWeek(weekStart: string): string {
  return addDays(weekStart, 7);
}

export function weekRangeLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const [startYear, startMonth, startDay] = weekStart.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  if (startYear !== endYear) return `${startYear}年${startMonth}月${startDay}日–${endYear}年${endMonth}月${endDay}日`;
  if (startMonth !== endMonth) return `${startMonth}月${startDay}日–${endMonth}月${endDay}日`;
  return `${startMonth}月${startDay}日–${endDay}日`;
}
