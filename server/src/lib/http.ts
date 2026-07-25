import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { AppError } from './errors';
import { isoWithShanghaiOffset } from './time';

export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
  requestId: string;
  serverTime: string;
}

export function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = {
    code: 'OK',
    message: 'success',
    data,
    requestId: res.req.requestId,
    serverTime: isoWithShanghaiOffset(new Date()),
  };
  res.status(status).json(body);
}

export function parseBody<T>(schema: ZodType<T>, request: Request): T {
  try {
    return schema.parse(request.body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError('VALIDATION_ERROR', '请求参数不正确', 422, {
        fields: error.issues.map((issue) => issue.path.join('.')),
      });
    }
    throw error;
  }
}

export function parseQuery<T>(schema: ZodType<T>, request: Request): T {
  try {
    return schema.parse(request.query);
  } catch (error) {
    if (error instanceof ZodError) throw new AppError('VALIDATION_ERROR', '查询参数不正确', 422);
    throw error;
  }
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    handler(request, response, next).catch(next);
  };
}
