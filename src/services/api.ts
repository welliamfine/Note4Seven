export * from './local-api';
// Discovery intentionally uses the production transport even in local builds so it never shows mock community data.
export * from './discovery-api';

import { bootstrapDatabase } from './database';
import { initializeTracking } from './tracker';

export function initializeApi(): void {
  bootstrapDatabase();
  initializeTracking();
}
