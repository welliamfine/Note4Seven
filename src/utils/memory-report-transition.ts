import type { MemoryReportMode, MemoryView } from '../services/api';
import {
  fetchMemoryView,
  peekMemoryView,
  type MemoryViewQuery,
} from './memory-view-cache';

export type MemoryReportMotionPhase = 'exit' | 'enter' | 'restore' | 'abort' | 'visible';

export interface MemoryReportMotionState {
  tabMode?: MemoryReportMode;
  transitioning?: boolean;
  boardPhase: string;
  heatmapPhase: string;
  summaryStickerPhase: string;
}

export type MemoryCollageActionPhase =
  | 'action-visible'
  | 'action-leaving'
  | 'action-collapsing'
  | 'action-hidden'
  | 'action-expanding'
  | 'action-entering';

export function changedMemoryTextClass(changed: boolean): string {
  return changed ? 'memory-text-exit-up' : 'memory-text-visible';
}

export function swapMemoryTextClass(currentClass: string): string {
  return currentClass === 'memory-text-exit-up' ? 'memory-text-hidden' : 'memory-text-visible';
}

export function advanceMemoryTextClass(currentClass: string, phase: MemoryReportMotionPhase): string {
  if (phase === 'enter') {
    return currentClass === 'memory-text-hidden' ? 'memory-text-enter-up' : 'memory-text-visible';
  }
  if (phase === 'restore') {
    return currentClass === 'memory-text-exit-up' ? 'memory-text-enter-up' : 'memory-text-visible';
  }
  return phase === 'exit' ? currentClass : 'memory-text-visible';
}

export function memoryReportMotionState(
  phase: MemoryReportMotionPhase,
  targetMode: MemoryReportMode,
  previousMode: MemoryReportMode,
): MemoryReportMotionState {
  if (phase === 'exit') return {
    boardPhase: 'memory-surface-leaving',
    heatmapPhase: 'memory-surface-leaving',
    summaryStickerPhase: 'sticker-leaving',
  };
  if (phase === 'restore') return {
    tabMode: previousMode,
    boardPhase: 'memory-surface-entering',
    heatmapPhase: 'memory-surface-entering',
    summaryStickerPhase: 'sticker-entering',
  };
  if (phase === 'enter') return {
    boardPhase: 'memory-surface-entering',
    heatmapPhase: 'memory-surface-entering',
    summaryStickerPhase: 'sticker-entering',
  };
  return {
    ...(phase === 'abort' ? { tabMode: previousMode } : {}),
    transitioning: false,
    boardPhase: 'memory-surface-visible',
    heatmapPhase: 'memory-surface-visible',
    summaryStickerPhase: 'sticker-visible',
  };
}

interface MemoryReportTransitionCallbacks {
  isActive: () => boolean;
  preload: (view: MemoryView) => Promise<void>;
  prepareView: (view: MemoryView) => Promise<boolean>;
  applyView: (view: MemoryView, background: boolean, transitionApply: boolean) => Promise<boolean>;
  onStart: (cacheHit: boolean) => void;
  onReady: (view: MemoryView) => void;
  onPhase: (phase: MemoryReportMotionPhase) => void;
  onError: () => void;
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runMemoryReportTransition(
  query: MemoryViewQuery,
  callbacks: MemoryReportTransitionCallbacks,
): Promise<void> {
  const cached = peekMemoryView(query);
  const freshView = fetchMemoryView(query).catch(() => undefined);
  callbacks.onStart(Boolean(cached));
  const view = cached ?? await freshView;
  if (!view) {
    callbacks.onPhase('abort');
    callbacks.onError();
    return;
  }

  callbacks.onReady(view);
  callbacks.onPhase('exit');
  void callbacks.preload(view).catch(() => undefined);
  void callbacks.prepareView(view).catch(() => false);
  await wait(180);
  if (!callbacks.isActive()) return;
  const loaded = await callbacks.applyView(view, false, true);
  if (!callbacks.isActive()) return;
  if (!loaded) {
    callbacks.onPhase('restore');
    await wait(400);
    if (!callbacks.isActive()) return;
    callbacks.onPhase('visible');
    callbacks.onError();
    return;
  }
  callbacks.onPhase('enter');
  await wait(400);
  if (!callbacks.isActive()) return;
  callbacks.onPhase('visible');
}

export async function runMemoryCollageActionTransition(
  currentVisible: boolean,
  targetVisible: boolean,
  isActive: () => boolean,
  onPhase: (phase: MemoryCollageActionPhase) => void,
): Promise<boolean> {
  if (currentVisible === targetVisible) {
    onPhase(targetVisible ? 'action-visible' : 'action-hidden');
    return true;
  }
  if (currentVisible) {
    onPhase('action-leaving');
    await wait(150);
    if (!isActive()) return false;
    onPhase('action-collapsing');
    await wait(220);
    if (!isActive()) return false;
    onPhase('action-hidden');
    return true;
  }
  onPhase('action-expanding');
  await wait(220);
  if (!isActive()) return false;
  onPhase('action-entering');
  void wait(400).then(() => {
    if (isActive()) onPhase('action-visible');
  });
  return true;
}

export function prewarmMemoryReport(
  query: MemoryViewQuery,
  preload: (view: MemoryView) => Promise<void>,
): void {
  if (peekMemoryView(query)) return;
  void fetchMemoryView(query).then(preload).catch(() => undefined);
}
