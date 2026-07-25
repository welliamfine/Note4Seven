import { createHmac } from 'node:crypto';

export function analyticsUserHash(userId: string, salt: string): string {
  return createHmac('sha256', salt).update(`analytics-user:${userId}`).digest('hex');
}
