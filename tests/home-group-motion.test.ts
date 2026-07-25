import { describe, expect, it } from 'vitest';
import {
  HOME_GROUP_CARD_OPENING_DURATION,
  HOME_GROUP_MOTION,
  HOME_GROUP_OPENING_DURATION,
} from '../src/utils/home-group-motion';

describe('home group motion', () => {
  it('uses a 500ms total duration for opening and closing', () => {
    expect(HOME_GROUP_MOTION.totalDuration).toBe(500);
    expect(HOME_GROUP_MOTION.openingStartDelay + HOME_GROUP_OPENING_DURATION).toBe(500);
  });

  it('keeps the final staggered card within the 500ms opening duration', () => {
    const maximumStagger =
      HOME_GROUP_MOTION.openingStaggerStep * HOME_GROUP_MOTION.openingMaxStaggerSteps;

    expect(
      HOME_GROUP_MOTION.openingStartDelay + maximumStagger + HOME_GROUP_CARD_OPENING_DURATION,
    ).toBe(HOME_GROUP_MOTION.totalDuration);
  });
});
