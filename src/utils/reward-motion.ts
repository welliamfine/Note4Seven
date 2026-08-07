export const REWARD_MOTION = {
  entryDuration: 500,
  flipDuration: 780,
  advanceDuration: 360,
  closeDuration: 260,
  collectDuration: 980,
} as const;

export type RewardMotionPhase =
  | 'idle'
  | 'entering'
  | 'visible'
  | 'flipping'
  | 'advancing'
  | 'closing'
  | 'collecting';
