export function hasOpenBottomSheet(...openStates: boolean[]): boolean {
  return openStates.some(Boolean);
}
