export function pollIntervalForElapsed(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1_000;
  if (elapsedMs < 30_000) return 2_000;
  return 5_000;
}

export function waitingCopy(elapsedMs: number): string {
  if (elapsedMs >= 120_000) return '仍在处理中，可以先离开，稍后回来查看';
  if (elapsedMs >= 60_000) return '处理时间较长，可以先离开，稍后回来查看';
  if (elapsedMs >= 30_000) return '贴纸仍在生成，请稍候';
  return '审核与贴纸生成正在同时进行';
}
