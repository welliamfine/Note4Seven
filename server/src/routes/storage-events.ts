import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { inTransaction } from '../db/pool';
import { AppError } from '../lib/errors';
import { asyncRoute, parseBody } from '../lib/http';
import type { StorageService } from '../services/storage';

const objectCreatedBody = z.object({
  bucket: z.string().min(1).max(128),
  objectKey: z.string().regex(/^media\/\d+\/\d+\/original\.jpg$/),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  eventName: z.string().startsWith('cos:ObjectCreated:'),
});

interface EventMediaRow extends RowDataPacket {
  media_id: string;
  status: string;
}

export function storageEventRoutes(
  pool: Pool,
  storage: StorageService,
  config: AppConfig,
  onMediaQueued?: () => void,
): Router {
  const router = Router();

  router.post('/internal/storage/object-created', asyncRoute(async (request, response) => {
    verifyEventToken(request.headers['x-storage-event-token'], config.storageEventToken);
    const body = parseBody(objectCreatedBody, request);
    if (body.bucket !== config.objectBucket) throw new AppError('INVALID_STORAGE_EVENT', '存储事件来源不正确', 401);

    const [rows] = await pool.execute<EventMediaRow[]>(
      'SELECT media_id, status FROM media_asset WHERE original_file_key = ? LIMIT 1',
      [body.objectKey],
    );
    const media = rows[0];
    if (!media) {
      response.json({ status: 'ignored', reason: 'media_not_found' });
      return;
    }
    if (!['created', 'uploading'].includes(media.status)) {
      response.json({ status: 'duplicate', mediaId: media.media_id });
      return;
    }

    await storage.assertUploaded(body.objectKey, body.size);
    const queued = await inTransaction(pool, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE media_asset
            SET file_size = ?, status = 'processing', cutout_status = 'queued', content_check_status = 'queued',
                failure_code = NULL, failure_message = NULL, version = version + 1
          WHERE media_id = ? AND original_file_key = ? AND status IN ('created', 'uploading')`,
        [body.size, media.media_id, body.objectKey],
      );
      if (update.affectedRows !== 1) return false;
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'media.processing_requested', JSON_OBJECT('mediaId', ?, 'source', 'cos_event'))`,
        [media.media_id, media.media_id],
      );
      return true;
    });
    if (queued) onMediaQueued?.();
    response.json({ status: queued ? 'queued' : 'duplicate', mediaId: media.media_id });
  }));

  return router;
}

function verifyEventToken(value: string | string[] | undefined, expected: string | null): void {
  if (!expected) throw new AppError('STORAGE_EVENT_NOT_CONFIGURED', '存储事件接收尚未配置', 503);
  const actual = Array.isArray(value) ? value[0] : value ?? '';
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AppError('INVALID_STORAGE_EVENT', '存储事件来源不正确', 401);
  }
}
