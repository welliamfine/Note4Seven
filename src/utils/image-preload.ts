export async function preloadImageSources(sources: string[], timeoutMilliseconds = 1_500): Promise<void> {
  if (!wx.getImageInfo) return;
  const uniqueSources = [...new Set(sources.filter(Boolean))];
  await Promise.all(uniqueSources.map((src) => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      resolve();
    };
    const fallbackTimer = setTimeout(finish, timeoutMilliseconds);
    try {
      wx.getImageInfo({ src, success: finish, fail: finish });
    } catch {
      finish();
    }
  })));
}

export function imageSourceIdentity(source: string): string {
  return source.split(/[?#]/, 1)[0];
}
