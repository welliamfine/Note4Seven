import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHEET_MOTION_DURATION, waitForSheetMotion } from '../src/utils/sheet-motion';

describe('bottom sheet motion', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the same 500ms duration for opening and closing', () => {
    expect(SHEET_MOTION_DURATION).toBe(500);
  });

  it('keeps the sheet mounted until the closing motion finishes', async () => {
    vi.useFakeTimers();
    let finished = false;
    const closing = waitForSheetMotion().then(() => { finished = true; });

    await vi.advanceTimersByTimeAsync(SHEET_MOTION_DURATION - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(finished).toBe(true);
  });
});
