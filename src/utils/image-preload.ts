const preloadedImageSources = new Set<string>();
const pendingImageSources = new Map<string, Promise<void>>();

const preloadImageSource = (src: string, timeoutMilliseconds: number): Promise<void> => {
  if (preloadedImageSources.has(src)) return Promise.resolve();
  const existing = pendingImageSources.get(src);
  if (existing) return existing;

  const request = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      preloadedImageSources.add(src);
      resolve();
    };
    const fallbackTimer = setTimeout(finish, timeoutMilliseconds);
    try {
      wx.getImageInfo({ src, success: finish, fail: finish });
    } catch {
      finish();
    }
  }).finally(() => pendingImageSources.delete(src));
  pendingImageSources.set(src, request);
  return request;
};

export async function preloadImageSources(sources: string[], timeoutMilliseconds = 1_500): Promise<void> {
  if (!wx.getImageInfo) return;
  const uniqueSources = [...new Set(sources.filter(Boolean))];
  await Promise.all(uniqueSources.map((src) => preloadImageSource(src, timeoutMilliseconds)));
}

export function imageSourceIdentity(source: string): string {
  return source.split(/[?#]/, 1)[0];
}
