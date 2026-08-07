import { getMemoryView, type MemoryReportMode, type MemoryView } from '../services/api';

export interface MemoryViewQuery {
  moduleId?: string;
  periodKey: string;
  reportMode: MemoryReportMode;
  allModules: boolean;
  forceChange?: boolean;
}

const MAX_MEMORY_VIEW_CACHE_ENTRIES = 12;
const MEMORY_COLLAGE_BOARD_SOURCE = '/assets/ui/memory-collage-board.webp';
const MEMORY_DEFAULT_STICKER_SOURCE = '/assets/ui/memory-default-sticker.png';
const memoryViewCache = new Map<string, MemoryView>();
const memoryViewRequests = new Map<string, Promise<MemoryView>>();

const cacheKey = ({ moduleId, periodKey, reportMode, allModules }: MemoryViewQuery): string => (
  `${reportMode}:${periodKey}:${allModules ? 'all' : moduleId || 'recent'}`
);

const remember = (key: string, view: MemoryView): MemoryView => {
  memoryViewCache.delete(key);
  memoryViewCache.set(key, view);
  while (memoryViewCache.size > MAX_MEMORY_VIEW_CACHE_ENTRIES) {
    const oldestKey = memoryViewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    memoryViewCache.delete(oldestKey);
  }
  return view;
};

export function peekMemoryView(query: MemoryViewQuery): MemoryView | undefined {
  const key = cacheKey(query);
  const cached = memoryViewCache.get(key);
  if (cached) remember(key, cached);
  return cached;
}

export function fetchMemoryView(query: MemoryViewQuery): Promise<MemoryView> {
  const key = cacheKey(query);
  if (!query.forceChange) {
    const pending = memoryViewRequests.get(key);
    if (pending) return pending;
  }

  const request = getMemoryView(
    query.moduleId,
    query.periodKey,
    Boolean(query.forceChange),
    query.reportMode,
    query.allModules,
  ).then((view) => remember(key, view)).finally(() => {
    if (memoryViewRequests.get(key) === request) memoryViewRequests.delete(key);
  });

  if (!query.forceChange) memoryViewRequests.set(key, request);
  return request;
}

export function memoryViewImageSources(view: MemoryView): string[] {
  return [
    MEMORY_COLLAGE_BOARD_SOURCE,
    MEMORY_DEFAULT_STICKER_SOURCE,
    view.latestStickerPath ?? '',
    ...view.items.map((item) => item.stickerPath),
    view.collage?.board?.imagePath ?? '',
    ...(view.collage?.items ?? []).map((item) => item.imagePath),
  ].filter(Boolean);
}

export function clearMemoryViewCache(): void {
  memoryViewCache.clear();
  memoryViewRequests.clear();
}
