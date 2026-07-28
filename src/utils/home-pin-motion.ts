import { STICKER_MOTION } from './sticker-motion';

export const HOME_PIN_MOTION = {
  cardSlotRpx: 254,
  firstPinnedGroupSpanRpx: 342,
  leaveDuration: STICKER_MOTION.duration,
  layoutDuration: 360,
  layoutFrameDelay: 34,
  enterDuration: STICKER_MOTION.duration,
} as const;

interface HomePinLayoutInput {
  movingModuleId: string;
  pinnedBefore: string[];
  normalBefore: string[];
  pinnedAfter: string[];
  normalAfter: string[];
}

export interface HomeModuleLayoutInput {
  pinnedBefore: string[];
  normalBefore: string[];
  pinnedAfter: string[];
  normalAfter: string[];
}

export interface HomePinLayoutPlan {
  moduleOffsetsRpx: Record<string, number>;
  normalGroupOffsetRpx: number;
}

export function createHomePinLayoutPlan(input: HomePinLayoutInput): HomePinLayoutPlan {
  return createHomeModuleLayoutPlan(input);
}

export function createHomeModuleLayoutPlan(input: HomeModuleLayoutInput): HomePinLayoutPlan {
  const moduleOffsetsRpx: Record<string, number> = {};
  collectLocalOffsets(input.pinnedBefore, input.pinnedAfter, moduleOffsetsRpx);
  collectLocalOffsets(input.normalBefore, input.normalAfter, moduleOffsetsRpx);

  const pinnedSpanBefore = pinnedGroupSpan(input.pinnedBefore.length);
  const pinnedSpanAfter = pinnedGroupSpan(input.pinnedAfter.length);

  return {
    moduleOffsetsRpx,
    normalGroupOffsetRpx: pinnedSpanBefore - pinnedSpanAfter,
  };
}

function collectLocalOffsets(
  before: string[],
  after: string[],
  output: Record<string, number>,
): void {
  const beforeIndexes = new Map(before.map((moduleId, index) => [moduleId, index]));
  after.forEach((moduleId, newIndex) => {
    const oldIndex = beforeIndexes.get(moduleId);
    if (oldIndex === undefined || oldIndex === newIndex) return;
    output[moduleId] = (oldIndex - newIndex) * HOME_PIN_MOTION.cardSlotRpx;
  });
}

function pinnedGroupSpan(moduleCount: number): number {
  if (moduleCount <= 0) return 0;
  return HOME_PIN_MOTION.firstPinnedGroupSpanRpx
    + (moduleCount - 1) * HOME_PIN_MOTION.cardSlotRpx;
}
