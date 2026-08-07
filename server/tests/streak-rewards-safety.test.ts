import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { evaluateStreakRewardsSafely } from '../src/services/streak-rewards';

describe('streak reward evaluation isolation', () => {
  it('does not turn a saved record into an API failure when reward evaluation fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = {
      getConnection: vi.fn().mockRejectedValue(new Error('reward database unavailable')),
    } as unknown as Pool;

    await expect(evaluateStreakRewardsSafely(pool, '42')).resolves.toBe(0);
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
