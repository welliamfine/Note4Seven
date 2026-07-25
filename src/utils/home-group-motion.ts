export const HOME_GROUP_MOTION = {
  totalDuration: 500,
  openingStartDelay: 16,
  openingStaggerStep: 10,
  openingMaxStaggerSteps: 6,
} as const;

export const HOME_GROUP_OPENING_DURATION =
  HOME_GROUP_MOTION.totalDuration - HOME_GROUP_MOTION.openingStartDelay;

export const HOME_GROUP_CARD_OPENING_DURATION =
  HOME_GROUP_OPENING_DURATION
  - HOME_GROUP_MOTION.openingStaggerStep * HOME_GROUP_MOTION.openingMaxStaggerSteps;
