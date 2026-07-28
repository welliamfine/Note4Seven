import type { LifeRecord, ModuleMember, StickerPreview } from '../types/domain';
import { imageSourceIdentity, preloadImageSources } from '../utils/image-preload';

export interface AnimatedStickerPreview extends StickerPreview {
  motionPhase?: '' | 'sticker-hidden' | 'sticker-entering' | 'sticker-visible';
}

export interface HomePreviewSyncPlan {
  previews: AnimatedStickerPreview[];
  animatedIndexes: number[];
  animatedSources: string[];
  changed: boolean;
}

export type HomePreviewUpdate = {
  moduleId: string;
  recordId: string;
  memberInstanceId?: string;
  previousRecordId?: string;
} & (
  | { type: 'upsert'; stickerPath: string }
  | { type: 'remove' }
);

interface PendingHomePreviewUpdate {
  update: HomePreviewUpdate;
  ready: Promise<void>;
}

const pendingUpdates: PendingHomePreviewUpdate[] = [];

export function queueHomePreviewUpdate(update: HomePreviewUpdate): Promise<void> {
  const ready = update.type === 'upsert'
    ? preloadImageSources([update.stickerPath])
    : Promise.resolve();
  pendingUpdates.push({ update, ready });
  return ready;
}

export async function consumeHomePreviewUpdates(): Promise<HomePreviewUpdate[]> {
  const batch = pendingUpdates.splice(0, pendingUpdates.length);
  await Promise.all(batch.map(({ ready }) => ready));
  return batch.map(({ update }) => update);
}

export function applyHomePreviewUpdates(
  previews: StickerPreview[],
  updates: HomePreviewUpdate[],
): StickerPreview[] {
  return updates.reduce<StickerPreview[]>((current, update) => {
    const replacedIds = new Set([update.recordId, update.previousRecordId].filter(Boolean));
    const previous = current.find((preview) => replacedIds.has(preview.recordId));
    const remaining = current.filter((preview) => !replacedIds.has(preview.recordId));
    if (update.type === 'remove') {
      return remaining.map((preview, displayOrder) => ({ ...preview, displayOrder }));
    }
    const displayOrder = previous?.displayOrder
      ?? (remaining.length ? Math.max(...remaining.map((preview) => preview.displayOrder)) + 1 : 0);
    return [...remaining, {
      recordId: update.recordId,
      memberInstanceId: update.memberInstanceId ?? previous?.memberInstanceId,
      stickerPath: update.stickerPath,
      displayOrder,
    }]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((preview, index) => ({ ...preview, displayOrder: index }));
  }, previews);
}

export function needsHomePreviewVerification(
  current: StickerPreview[],
  incoming: StickerPreview[],
  activeMembers: ModuleMember[],
  verifyUnderfilled = false,
): boolean {
  const incomingIds = new Set(incoming.map((preview) => preview.recordId));
  const activeMemberIds = new Set(activeMembers.map((member) => member.memberInstanceId));
  return (verifyUnderfilled && incoming.length > 0 && incoming.length < activeMembers.length)
    || current.some((preview) => !incomingIds.has(preview.recordId)
      && (!preview.memberInstanceId || activeMemberIds.has(preview.memberInstanceId)));
}

export function homePreviewsFromRecords(records: LifeRecord[]): StickerPreview[] {
  return [...records]
    .sort((left, right) => left.firstEffectiveAt.localeCompare(right.firstEffectiveAt)
      || left.recordId.localeCompare(right.recordId))
    .slice(-4)
    .map((record, displayOrder) => ({
      recordId: record.recordId,
      memberInstanceId: record.memberInstanceId,
      stickerPath: record.stickerPath,
      displayOrder,
    }));
}

export function mergeHomePreviewSnapshot(
  current: AnimatedStickerPreview[],
  incoming: StickerPreview[],
): HomePreviewSyncPlan {
  const animatedIndexes: number[] = [];
  const animatedSources: string[] = [];
  const previews = incoming.map<AnimatedStickerPreview>((preview, index) => {
    const existing = current.find((candidate) => candidate.recordId === preview.recordId);
    if (existing && imageSourceIdentity(existing.stickerPath) === imageSourceIdentity(preview.stickerPath)) {
      return existing.displayOrder === preview.displayOrder
        && existing.memberInstanceId === preview.memberInstanceId
        ? existing
        : { ...existing, memberInstanceId: preview.memberInstanceId, displayOrder: preview.displayOrder };
    }
    animatedIndexes.push(index);
    animatedSources.push(preview.stickerPath);
    return { ...preview, motionPhase: 'sticker-hidden' };
  });
  return {
    previews,
    animatedIndexes,
    animatedSources,
    changed: previews.length !== current.length || previews.some((preview, index) => preview !== current[index]),
  };
}
