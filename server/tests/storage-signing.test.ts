import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { StorageService } from '../src/services/storage';
import { productionEnvironment } from './fixtures/production-config';

describe('COS signed URL freshness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('signs every URL from the current time while reusing temporary credentials', async () => {
    const initialTime = new Date('2026-07-24T12:00:00.000Z');
    let currentTime = initialTime.getTime();
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    const initialSeconds = Math.floor(initialTime.getTime() / 1000);
    const fetchCredentials = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      TmpSecretId: 'temporary-secret-id',
      TmpSecretKey: 'temporary-secret-key',
      SecurityToken: 'temporary-security-token',
      StartTime: initialSeconds - 600,
      ExpiredTime: initialSeconds + 7_200,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchCredentials);
    const storage = new StorageService(loadConfig({
      ...productionEnvironment,
    }));

    const firstUrl = await storage.signedUrl('media/1/38/sticker-thumb.webp');
    currentTime += 20 * 60 * 1000;
    const secondUrl = await storage.signedUrl('media/1/38/sticker-thumb.webp');

    const firstWindow = signatureWindow(firstUrl);
    const secondWindow = signatureWindow(secondUrl);
    expect(secondWindow.start - firstWindow.start).toBe(20 * 60);
    expect(secondWindow.end - secondWindow.start).toBe(900);
    expect(fetchCredentials).toHaveBeenCalledTimes(1);
  });
});

function signatureWindow(url: string): { start: number; end: number } {
  const value = new URL(url).searchParams.get('q-sign-time');
  if (!value) throw new Error('signed URL is missing q-sign-time');
  const [start, end] = value.split(';').map(Number);
  return { start, end };
}
