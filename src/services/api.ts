export * from './local-api';

import { bootstrapDatabase } from './database';

export function initializeApi(): void {
  bootstrapDatabase();
}
