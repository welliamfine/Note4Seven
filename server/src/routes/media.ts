import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { publicId } from '../lib/ids';
import { isoWithShanghaiOffset } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent } from '../services/idempotency';
import type { StorageService } from '../services/storage';

const sourceTypeValue = z.enum(['camera', 'gallery', 'album']).transform(normalizeMediaSourceType);

const createBody = z.object({
  moduleId: z.string().optional(),
  purpose: z.enum(['record_photo', 'avatar']).default('record_photo'),
  sourceType: sourceTypeValue,
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileSize: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().min(32).max(7680).optional(),
  height: z.number().int().min(32).max(4320).optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  clientRequestId: z.string().min(8).max(64),
});

const reservationBody = z.object({
  moduleId: z.string(),
  purpose: z.literal('record_photo').default('record_photo'),
  clientRequestId: z.string().min(8).max(64),
});

const uploadCompleteBody = z.object({
  etag: z.string().min(1).max(128),
  fileId: z.string().max(1024).optional(),
  sourceType: sourceTypeValue.optional(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  fileSize: z.number().int().positive().max(10 * 1024 * 1024).optional(),
  width: z.number().int().min(32).max(7680).optional(),
  height: z.number().int().min(32).max(4320).optional(),
  clientRequestId: z.string().min(8).max(64),
});

const simpleWriteBody = z.object({ clientRequestId: z.string().min(8).max(64) });

interface MediaRow extends RowDataPacket {
  media_id: string;
  owner_user_id: string;
  status: string;
  cutout_status: string;
  content_check_status: string;
  original_file_key: string | null;
  thumbnail_file_key: string | null;
  sticker_file_key: string | null;
  sticker_thumbnail_file_key: string | null;
  failure_code: string | null;
  failure_message: string | null;
  processing_attempts: number;
  file_size: string;
  purpose: string;
}

export function mediaRoutes(pool: Pool, storage: StorageService, onMediaQueued?: () => void): Router {
  const router = Router();

  router.post('/media/reservations', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(reservationBody, request);
    const moduleId = dbId(body.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId);
    const created = await idempotent(pool, user.userId, 'media_reserve', body.clientRequestId, body, async (connection) => {
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO media_asset
           (owner_user_id, module_id, member_instance_id, purpose, source_type, mime_type, file_size,
            status, cutout_status, content_check_status)
         VALUES (?, ?, ?, 'record_photo', 'gallery', 'image/jpeg', 0, 'created', 'not_started', 'not_started')`,
        [user.userId, moduleId, access.member_instance_id],
      );
      const mediaId = String(insert.insertId);
      const objectKey = `media/${user.userId}/${mediaId}/original.jpg`;
      await connection.execute('UPDATE media_asset SET original_file_key = ? WHERE media_id = ?', [objectKey, mediaId]);
      return { mediaId: publicId('media', mediaId), objectKey, status: 'created' };
    });
    const upload = await storage.createUpload(created.objectKey);
    ok(response, { mediaId: created.mediaId, status: created.status, upload }, 201);
  }));

  router.post('/media', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const body = parseBody(createBody, request);
    let moduleId: string | null = null;
    let memberInstanceId: string | null = null;
    if (body.purpose === 'record_photo') {
      if (!body.moduleId) throw new AppError('VALIDATION_ERROR', '记录图片必须指定模块', 422);
      moduleId = dbId(body.moduleId, 'm');
      const access = await requireMember(pool, moduleId, user.userId);
      memberInstanceId = String(access.member_instance_id);
    }

    const created = await idempotent(pool, user.userId, 'media_create', body.clientRequestId, body, async (connection) => {
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO media_asset
           (owner_user_id, module_id, member_instance_id, purpose, source_type, mime_type, file_size, width, height, sha256,
            status, cutout_status, content_check_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 'not_started', 'not_started')`,
        [user.userId, moduleId, memberInstanceId, body.purpose, body.sourceType, body.mimeType,
          body.fileSize, body.width ?? null, body.height ?? null, body.sha256 ?? null],
      );
      const mediaId = String(insert.insertId);
      const extension = extensionForMime(body.mimeType);
      const objectKey = `media/${user.userId}/${mediaId}/original.${extension}`;
      await connection.execute('UPDATE media_asset SET original_file_key = ? WHERE media_id = ?', [objectKey, mediaId]);
      return { mediaId: publicId('media', mediaId), objectKey, status: 'created' };
    });
    const upload = await storage.createUpload(created.objectKey);
    ok(response, { mediaId: created.mediaId, status: created.status, upload }, 201);
  }));

  router.post('/media/:mediaId/upload-complete', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mediaId = dbId(request.params.mediaId, 'media');
    const body = parseBody(uploadCompleteBody, request);
    const [uploadedRows] = await pool.execute<MediaRow[]>(
      'SELECT * FROM media_asset WHERE media_id = ? AND owner_user_id = ? LIMIT 1',
      [mediaId, user.userId],
    );
    const uploadedMedia = uploadedRows[0];
    if (!uploadedMedia?.original_file_key) throw new AppError('MEDIA_NOT_FOUND', '图片不存在', 404);
    const expectedSize = body.fileSize ?? Number(uploadedMedia.file_size);
    if (['created', 'uploading'].includes(uploadedMedia.status)) {
      if (expectedSize <= 0) throw new AppError('MEDIA_UPLOAD_INVALID', '缺少上传图片大小', 422);
      await storage.assertUploaded(uploadedMedia.original_file_key, expectedSize);
    }
    const result = await idempotent(pool, user.userId, 'media_upload_complete', body.clientRequestId, body, async (connection) => {
      const [rows] = await connection.execute<MediaRow[]>(
        'SELECT * FROM media_asset WHERE media_id = ? AND owner_user_id = ? FOR UPDATE',
        [mediaId, user.userId],
      );
      const media = rows[0];
      if (!media) throw new AppError('MEDIA_NOT_FOUND', '图片不存在', 404);
      if (media.status === 'abandoned') throw new AppError('MEDIA_NOT_FOUND', '图片已被放弃', 410);
      if (!['created', 'uploading'].includes(media.status)) {
        return { mediaId: publicId('media', mediaId), status: media.status };
      }
      await connection.execute(
        `UPDATE media_asset
            SET source_type = COALESCE(?, source_type), mime_type = COALESCE(?, mime_type), file_size = ?,
                width = COALESCE(?, width), height = COALESCE(?, height),
                status = 'processing', cutout_status = 'queued', content_check_status = 'queued',
                failure_code = NULL, failure_message = NULL, version = version + 1
          WHERE media_id = ?`,
        [body.sourceType ?? null, body.mimeType ?? null, expectedSize,
          body.width ?? null, body.height ?? null, mediaId],
      );
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'media.processing_requested', JSON_OBJECT('mediaId', ?))`,
        [mediaId, mediaId],
      );
      return { mediaId: publicId('media', mediaId), status: 'processing' };
    });
    if (result.status === 'processing') onMediaQueued?.();
    ok(response, result);
  }));

  router.get('/media/:mediaId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mediaId = dbId(request.params.mediaId, 'media');
    const requestedWait = Number(Array.isArray(request.query.waitMs) ? request.query.waitMs[0] : request.query.waitMs ?? 0);
    const waitMs = Number.isFinite(requestedWait) ? Math.max(0, Math.min(2_500, requestedWait)) : 0;
    const deadline = Date.now() + waitMs;
    let media: MediaRow | undefined;
    do {
      const [rows] = await pool.execute<MediaRow[]>(
        'SELECT * FROM media_asset WHERE media_id = ? AND owner_user_id = ? LIMIT 1',
        [mediaId, user.userId],
      );
      media = rows[0];
      if (!media || ['ready', 'failed', 'abandoned'].includes(media.status) || Date.now() >= deadline) break;
      await delay(150);
    } while (true);
    if (!media) throw new AppError('MEDIA_NOT_FOUND', '图片不存在', 404);
    const assets = media.status === 'ready' ? await mediaAssets(storage, media) : emptyAssets();
    ok(response, {
      mediaId: publicId('media', media.media_id),
      status: media.status,
      cutoutStatus: media.cutout_status,
      contentCheckStatus: media.content_check_status,
      progressStage: progressStage(media),
      failureCode: media.failure_code,
      failureMessage: media.failure_message,
      assets,
      availableActions: mediaActions(media),
    });
  }));

  router.post('/media/:mediaId/retry', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mediaId = dbId(request.params.mediaId, 'media');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'media_retry', body.clientRequestId, body, async (connection) => {
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE media_asset
            SET status = 'processing',
                cutout_status = IF(cutout_status = 'succeeded', 'succeeded', 'queued'),
                content_check_status = IF(content_check_status = 'passed', 'passed', 'queued'),
                failure_code = NULL, failure_message = NULL, version = version + 1
          WHERE media_id = ? AND owner_user_id = ? AND status = 'failed'
            AND content_check_status <> 'rejected' AND processing_attempts < 3`,
        [mediaId, user.userId],
      );
      if (update.affectedRows !== 1) throw new AppError('MEDIA_RETRY_NOT_ALLOWED', '该图片无法继续重试', 409);
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'media.processing_requested', JSON_OBJECT('mediaId', ?))`,
        [mediaId, mediaId],
      );
      return { mediaId: publicId('media', mediaId), status: 'processing' };
    });
    onMediaQueued?.();
    ok(response, result);
  }));

  router.post('/media/:mediaId/abandon', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const mediaId = dbId(request.params.mediaId, 'media');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'media_abandon', body.clientRequestId, body, async (connection) => {
      const [used] = await connection.execute<RowDataPacket[]>('SELECT record_id FROM life_record WHERE media_id = ? LIMIT 1', [mediaId]);
      if (used[0]) throw new AppError('MEDIA_IN_USE', '图片已被记录使用', 409);
      const [update] = await connection.execute<ResultSetHeader>(
        `UPDATE media_asset SET status = 'abandoned', abandoned_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE media_id = ? AND owner_user_id = ? AND status <> 'abandoned'`,
        [mediaId, user.userId],
      );
      if (update.affectedRows !== 1) throw new AppError('MEDIA_NOT_FOUND', '图片不存在', 404);
      return { mediaId: publicId('media', mediaId), status: 'abandoned' };
    });
    ok(response, result);
  }));

  return router;
}

async function mediaAssets(storage: StorageService, media: MediaRow) {
  const expireAt = isoWithShanghaiOffset(new Date(Date.now() + 10 * 60 * 1000));
  const [originalUrl, detailThumbnailUrl, stickerUrl, stickerThumbnailUrl] = await Promise.all([
    media.original_file_key ? storage.signedUrl(media.original_file_key) : null,
    media.thumbnail_file_key ? storage.signedUrl(media.thumbnail_file_key) : null,
    media.sticker_file_key ? storage.signedUrl(media.sticker_file_key) : null,
    media.sticker_thumbnail_file_key ? storage.signedUrl(media.sticker_thumbnail_file_key) : null,
  ]);
  return { originalUrl, detailThumbnailUrl, stickerUrl, stickerThumbnailUrl, urlExpireAt: expireAt };
}

function emptyAssets() {
  return { originalUrl: null, detailThumbnailUrl: null, stickerUrl: null, stickerThumbnailUrl: null, urlExpireAt: null };
}

function progressStage(media: MediaRow): string | null {
  if (media.status === 'ready' || media.status === 'failed' || media.status === 'abandoned') return null;
  if (media.content_check_status !== 'passed' && media.cutout_status !== 'succeeded') return 'content_check_and_cutout';
  if (media.content_check_status !== 'passed') return 'content_check';
  if (media.cutout_status !== 'succeeded') return 'cutout';
  return 'finalizing';
}

function mediaActions(media: MediaRow): string[] {
  if (media.status === 'processing') return ['poll', 'replace', 'cancel'];
  if (media.status === 'failed') {
    return media.content_check_status !== 'rejected' && media.processing_attempts < 3
      ? ['retry', 'replace']
      : ['replace'];
  }
  if (media.status === 'ready') return ['use', 'replace'];
  return [];
}

function extensionForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(candidate ?? '');
  if (!match) throw new AppError('VALIDATION_ERROR', '资源 ID 不正确', 422);
  return match[1];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeMediaSourceType(sourceType: 'camera' | 'gallery' | 'album'): 'camera' | 'gallery' {
  return sourceType === 'album' ? 'gallery' : sourceType;
}
