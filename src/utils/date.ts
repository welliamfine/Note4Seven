const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDate(now = new Date()): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiNowIso(now = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
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

export function buildMonthGrid(month: string): Array<{ date: string; day: number; inMonth: boolean }> {
  const [year, value] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, value - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const daysInMonth = new Date(Date.UTC(year, value, 0)).getUTCDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;

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
