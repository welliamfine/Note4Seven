export * from './local-api';

import { bootstrapDatabase } from './database';
import { initializeTracking } from './tracker';

export function initializeApi(): void {
  bootstrapDatabase();
  initializeTracking();
}
