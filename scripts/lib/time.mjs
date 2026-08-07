const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

process.env.TZ = 'Asia/Shanghai';

export function beijingIso(now = new Date()) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

export function beijingDate(now = new Date()) {
  return beijingIso(now).slice(0, 10);
}
