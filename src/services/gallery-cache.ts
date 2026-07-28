import { getModuleGallery, type GalleryView } from './api';

const galleryRequests = new Map<string, Promise<GalleryView>>();

const galleryCacheKey = (moduleId: string, month: string) => `${moduleId}:${month}`;

export function loadModuleGalleryCached(moduleId: string, month: string): Promise<GalleryView> {
  const key = galleryCacheKey(moduleId, month);
  const cached = galleryRequests.get(key);
  if (cached) return cached;
  const request = getModuleGallery(moduleId, month).catch((error) => {
    galleryRequests.delete(key);
    throw error;
  });
  galleryRequests.set(key, request);
  return request;
}

export function prefetchModuleGallery(moduleId: string, month: string): void {
  void loadModuleGalleryCached(moduleId, month).catch(() => undefined);
}

export function invalidateModuleGallery(moduleId: string, month: string): void {
  galleryRequests.delete(galleryCacheKey(moduleId, month));
}
