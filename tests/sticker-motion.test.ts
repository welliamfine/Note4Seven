import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStickerDelays, STICKER_MOTION } from '../src/utils/sticker-motion';

describe('sticker motion sequencing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates one unique cumulative delay per sticker', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = createStickerDelays(['a', 'b', 'c', 'd']);
    const delays = [...result.delays.values()].sort((left, right) => left - right);

    expect(delays).toEqual([0, 70, 140, 210]);
    expect(result.finalDelay).toBe(210);
  });

  it('keeps the shared point-pop defaults stable', () => {
    expect(STICKER_MOTION).toMatchObject({
      pageSettledDelay: 80,
      intervalMin: 70,
      intervalMax: 120,
      duration: 400,
      totalDuration: 900,
      initialScale: 0.06,
    });
  });

  it('keeps the complete sticker sequence within 900ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const stickerIds = Array.from({ length: 40 }, (_, index) => `sticker-${index}`);
    const result = createStickerDelays(stickerIds);

    expect(result.finalDelay + STICKER_MOTION.duration).toBeLessThanOrEqual(STICKER_MOTION.totalDuration);
    expect(result.finalDelay + STICKER_MOTION.duration).toBe(STICKER_MOTION.totalDuration);
    expect(new Set(result.delays.values()).size).toBe(stickerIds.length);
  });
});
