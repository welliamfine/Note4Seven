const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const BEIJING_TIME_ZONE = 'Asia/Shanghai';
export const BEIJING_UTC_OFFSET = '+08:00';

export function shanghaiDate(now = new Date()): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function isoWithShanghaiOffset(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().replace('Z', BEIJING_UTC_OFFSET);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function daysBetweenShanghai(target: string, now = new Date()): number {
  const today = new Date(`${shanghaiDate(now)}T00:00:00+08:00`).getTime();
  const targetTime = new Date(`${target}T00:00:00+08:00`).getTime();
  return Math.round((today - targetTime) / (24 * 60 * 60 * 1000));
}
