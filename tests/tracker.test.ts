import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, unknown>();

describe('privacy-safe analytics tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    storage.clear();
    Object.assign(globalThis, {
      wx: {
        getStorageSync: (key: string) => storage.get(key),
        setStorageSync: (key: string, value: unknown) => storage.set(key, value),
        removeStorageSync: (key: string) => storage.delete(key),
        getNetworkType: ({ success }: { success: (result: { networkType: string }) => void }) => success({ networkType: 'wifi' }),
        onNetworkStatusChange: () => undefined,
        getSystemInfoSync: () => ({ platform: 'ios' }),
      },
    });
  });

  afterEach(() => vi.useRealTimers());

  it('does not collect before consent and clears queued events when consent is withdrawn', async () => {
    const tracker = await import('../src/services/tracker');
    tracker.initializeTracking(vi.fn(async () => undefined));
    tracker.track('app_open', { source: 'direct' });
    expect(storage.get('notemylife.analytics.queue.v1')).toBeUndefined();

    tracker.setTrackingConsent(true);
    tracker.track('app_open', { source: 'direct' });
    expect(storage.get('notemylife.analytics.queue.v1')).toHaveLength(1);
    tracker.setTrackingConsent(false);
    expect(storage.get('notemylife.analytics.queue.v1')).toBeUndefined();
  });

  it('batches events and drops identifiers, URLs, tokens, and free-text fields', async () => {
    const upload = vi.fn(async (_events: unknown[]) => undefined);
    const tracker = await import('../src/services/tracker');
    tracker.initializeTracking(upload);
    tracker.setTrackingConsent(true);
    tracker.track('record_submit_success', {
      result: 'success',
      recordId: 'rec_123',
      note: 'private diary text',
      photoUrl: 'https://example.invalid/private.jpg',
      token: 'secret',
      durationMs: 120,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(upload).toHaveBeenCalledTimes(1);
    const batch = upload.mock.calls[0]?.[0] as Array<{ properties: Record<string, unknown> }>;
    expect(batch[0].properties).toEqual({ result: 'success', durationMs: 120 });
    expect(storage.get('notemylife.analytics.queue.v1')).toEqual([]);
  });
});
