export const STICKER_MOTION = {
  pageSettledDelay: 80,
  intervalMin: 70,
  intervalMax: 120,
  duration: 400,
  totalDuration: 900,
  initialScale: 0.06,
  overshootScale: 1.025,
  settleScale: 0.99,
  finalScale: 1,
  oldPageFadeDuration: 150,
  cellRevealDuration: 320,
  cellOvershootScale: 1.015,
} as const;

const randomBetween = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

export const shuffle = <T>(items: T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

export const createStickerDelays = (stickerIds: string[]) => {
  const shuffledIds = shuffle(stickerIds);
  const rawDelays = [0];
  for (let index = 1; index < shuffledIds.length; index += 1) {
    rawDelays.push(rawDelays[index - 1] + randomBetween(STICKER_MOTION.intervalMin, STICKER_MOTION.intervalMax));
  }
  const rawFinalDelay = rawDelays[rawDelays.length - 1] ?? 0;
  const maximumFinalDelay = STICKER_MOTION.totalDuration - STICKER_MOTION.duration;
  const compressionRatio = rawFinalDelay > maximumFinalDelay ? maximumFinalDelay / rawFinalDelay : 1;
  const delays = new Map<string, number>();
  shuffledIds.forEach((stickerId, index) => {
    delays.set(stickerId, Math.round(rawDelays[index] * compressionRatio));
  });
  return { delays, finalDelay: Math.round(rawFinalDelay * compressionRatio) };
};

export const waitForAppRouteDone = (fallbackMilliseconds = 450): Promise<void> => new Promise((resolve) => {
  let settled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    wx.offAppRouteDone?.(finish);
    resolve();
  };
  if (!wx.onAppRouteDone) {
    resolve();
    return;
  }
  wx.onAppRouteDone(finish);
  fallbackTimer = setTimeout(finish, fallbackMilliseconds);
});
