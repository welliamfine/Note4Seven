export const SHEET_MOTION_DURATION = 500;

export const waitForSheetMotion = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, SHEET_MOTION_DURATION);
});
