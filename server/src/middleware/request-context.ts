import type { NextFunction, Request, Response } from 'express';
import { requestId } from '../lib/ids';

export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header('x-request-id');
  request.requestId = incoming && /^[a-zA-Z0-9_-]{8,96}$/.test(incoming) ? incoming : requestId();
  response.setHeader('x-request-id', request.requestId);
  next();
}
