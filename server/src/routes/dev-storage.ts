import express, { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseQuery } from '../lib/http';
import { authUser } from '../middleware/auth';
import type { LocalStorageService } from '../services/local-storage';

const objectQuery = z.object({ key: z.string().min(1).max(1024) });

export function devStorageRoutes(storage: LocalStorageService): Router {
  const router = Router();

  router.put(
    '/dev-storage/upload',
    express.raw({ type: 'application/octet-stream', limit: '11mb' }),
    asyncRoute(async (request, response) => {
      const user = authUser(request);
      const { key } = parseQuery(objectQuery, request);
      if (!key.startsWith(`media/${user.userId}/`)) {
        throw new AppError('FORBIDDEN', 'Local upload path does not belong to the current user', 403);
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        throw new AppError('VALIDATION_ERROR', 'Local upload body is empty', 422);
      }
      await storage.writeUpload(key, request.body);
      ok(response, { fileId: `local://${key}`, size: request.body.length });
    }),
  );

  router.get('/dev-storage/file', asyncRoute(async (request, response) => {
    const { key } = parseQuery(objectQuery, request);
    try {
      const object = await storage.readObject(key);
      response.setHeader('cache-control', 'no-store');
      response.type(object.contentType).send(object.body);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('NOT_FOUND', 'Local file does not exist', 404);
    }
  }));

  return router;
}
