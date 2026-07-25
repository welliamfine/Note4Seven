import type { AuthenticatedUser } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthenticatedUser;
    }
  }
}

export {};
