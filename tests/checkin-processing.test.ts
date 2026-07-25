import { describe, expect, it } from 'vitest';
import { pollIntervalForElapsed, waitingCopy } from '../src/utils/checkin-processing';

describe('check-in processing timing', () => {
  it('uses adaptive polling without turning long waits into failures', () => {
    expect(pollIntervalForElapsed(0)).toBe(1_000);
    expect(pollIntervalForElapsed(10_000)).toBe(2_000);
    expect(pollIntervalForElapsed(30_000)).toBe(5_000);
    expect(pollIntervalForElapsed(180_000)).toBe(5_000);
  });

  it('changes guidance after long waits while keeping the task processing', () => {
    expect(waitingCopy(29_999)).toContain('同时进行');
    expect(waitingCopy(30_000)).toContain('仍在生成');
    expect(waitingCopy(60_000)).toContain('可以先离开');
    expect(waitingCopy(120_000)).toContain('仍在处理中');
  });
});
