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

describe('COS sticker processing', () => {
  it('keeps original-image display work out of the sticker generation request', async () => {
    const storage = new StorageService(loadConfig({ ...productionEnvironment }));
    const cos = (storage as unknown as {
      cos: {
        request: ReturnType<typeof vi.fn>;
        headObject: ReturnType<typeof vi.fn>;
      };
    }).cos;
    cos.request = vi.fn().mockResolvedValue({});
    cos.headObject = vi.fn().mockResolvedValue({
      headers: { 'content-length': '128', 'content-type': 'image/webp' },
    });

    await storage.processImage({
      original: 'media/1/154/original.jpg',
      detailThumbnail: 'media/1/154/detail.webp',
      sticker: 'media/1/154/sticker.png',
      stickerThumbnail: 'media/1/154/sticker-thumb.webp',
    });

    expect(cos.request).toHaveBeenCalledTimes(2);
    const firstRequest = cos.request.mock.calls[0][0] as { Headers: Record<string, string> };
    const firstOperations = JSON.parse(firstRequest.Headers['Pic-Operations']) as {
      rules: Array<{ fileid: string; rule: string }>;
    };
    expect(firstOperations.rules).toEqual([{
      fileid: '/media/1/154/sticker.png',
      rule: 'ci-process=AIPicMatting&center-layout=1&padding-layout=16x16',
    }]);
    expect(cos.headObject).toHaveBeenCalledTimes(1);
    expect(cos.headObject).toHaveBeenCalledWith(expect.objectContaining({
      Key: 'media/1/154/sticker-thumb.webp',
    }));
  });
});

function signatureWindow(url: string): { start: number; end: number } {
  const value = new URL(url).searchParams.get('q-sign-time');
  if (!value) throw new Error('signed URL is missing q-sign-time');
  const [start, end] = value.split(';').map(Number);
  return { start, end };
}
