import { describe, expect, it } from 'vitest';
import {
  createHomeModuleLayoutPlan,
  createHomePinLayoutPlan,
  HOME_PIN_MOTION,
} from '../src/utils/home-pin-motion';
import { STICKER_MOTION } from '../src/utils/sticker-motion';

describe('home pin motion', () => {
  it('keeps the source gap before moving the remaining cards into final positions', () => {
    const plan = createHomePinLayoutPlan({
      movingModuleId: 'drink',
      pinnedBefore: ['56454', 'discipline'],
      normalBefore: ['drink', 'outfit', 'repair'],
      pinnedAfter: ['56454', 'drink', 'discipline'],
      normalAfter: ['outfit', 'repair'],
    });

    expect(plan).toEqual({
      moduleOffsetsRpx: {
        discipline: -254,
        outfit: 254,
        repair: 254,
      },
      normalGroupOffsetRpx: -254,
    });
  });

  it('uses the symmetric offsets when cancelling a pin', () => {
    const plan = createHomePinLayoutPlan({
      movingModuleId: 'drink',
      pinnedBefore: ['56454', 'drink', 'discipline'],
      normalBefore: ['outfit', 'repair'],
      pinnedAfter: ['56454', 'discipline'],
      normalAfter: ['drink', 'outfit', 'repair'],
    });

    expect(plan).toEqual({
      moduleOffsetsRpx: {
        discipline: 254,
        outfit: -254,
        repair: -254,
      },
      normalGroupOffsetRpx: 254,
    });
  });

  it('uses the sticker pop duration in both directions', () => {
    expect(HOME_PIN_MOTION.leaveDuration).toBe(STICKER_MOTION.duration);
    expect(HOME_PIN_MOTION.enterDuration).toBe(STICKER_MOTION.duration);
    expect(HOME_PIN_MOTION.layoutDuration).toBe(360);
  });

  it('accounts for the group heading when the pinned group appears or disappears', () => {
    const pinPlan = createHomePinLayoutPlan({
      movingModuleId: 'drink',
      pinnedBefore: [],
      normalBefore: ['drink', 'outfit'],
      pinnedAfter: ['drink'],
      normalAfter: ['outfit'],
    });
    const unpinPlan = createHomePinLayoutPlan({
      movingModuleId: 'drink',
      pinnedBefore: ['drink'],
      normalBefore: ['outfit'],
      pinnedAfter: [],
      normalAfter: ['drink', 'outfit'],
    });

    expect(pinPlan.normalGroupOffsetRpx).toBe(-HOME_PIN_MOTION.firstPinnedGroupSpanRpx);
    expect(unpinPlan.normalGroupOffsetRpx).toBe(HOME_PIN_MOTION.firstPinnedGroupSpanRpx);
  });

  it('plans multiple removals in both groups as one layout transition', () => {
    const plan = createHomeModuleLayoutPlan({
      pinnedBefore: ['pinned-a', 'pinned-b', 'pinned-c'],
      normalBefore: ['normal-a', 'normal-b', 'normal-c'],
      pinnedAfter: ['pinned-c'],
      normalAfter: ['normal-a', 'normal-c'],
    });

    expect(plan.moduleOffsetsRpx).toEqual({
      'pinned-c': 508,
      'normal-c': 254,
    });
    expect(plan.normalGroupOffsetRpx).toBe(508);
  });

  it('opens a slot before an inserted normal module appears', () => {
    const plan = createHomeModuleLayoutPlan({
      pinnedBefore: ['pinned'],
      normalBefore: ['older-a', 'older-b'],
      pinnedAfter: ['pinned'],
      normalAfter: ['created', 'older-a', 'older-b'],
    });

    expect(plan.moduleOffsetsRpx).toEqual({ 'older-a': -254, 'older-b': -254 });
    expect(plan.normalGroupOffsetRpx).toBe(0);
  });
});
