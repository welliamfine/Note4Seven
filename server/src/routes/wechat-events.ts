import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Router, type Request } from 'express';
import { XMLParser } from 'fast-xml-parser';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import { asyncRoute } from '../lib/http';
import { syncRecordForMedia } from '../services/media-state';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

export type MediaCheckOutcome = 'passed' | 'rejected' | 'retry';

export interface MediaCheckDecision {
  traceId: string;
  outcome: MediaCheckOutcome;
  suggest: 'pass' | 'review' | 'risky' | null;
  label: string | number | null;
  statusCode: number;
  reason: 'result' | 'detail' | 'legacy' | 'service_error' | 'missing_verdict';
}

interface MediaCallbackRow extends RowDataPacket {
  media_id: string;
  processing_attempts: number;
}

export function wechatEventRoutes(pool: Pool, config: AppConfig, onMediaQueued?: () => void): Router {
  const router = Router();

  router.get('/wechat/events', (request, response, next) => {
    try {
      verifySignature(request, config);
      const echo = query(request, 'echostr');
      if (!echo) throw new AppError('VALIDATION_ERROR', '缺少 echostr', 422);
      response.type('text/plain').send(echo);
    } catch (error) {
      next(error);
    }
  });

  router.post('/wechat/events', asyncRoute(async (request, response) => {
    const event = parseEventBody(request.body);
    if (isContainerPathCheck(event)) {
      response.type('text/plain').send('success');
      return;
    }
    if (!isCloudHostingMessagePush(request.headers, config)) verifySignature(request, config);
    const decision = mediaCheckDecision(event);
    if (decision) {
      const eventAppId = String(event.appid ?? event.AppId ?? '');
      if (eventAppId && eventAppId !== config.appId) {
        throw new AppError('INVALID_CALLBACK_APP', '回调来源不正确', 401);
      }
      const requestLogger = (request as Request & {
        log?: { info: (details: Record<string, unknown>, message: string) => void };
      }).log;
      requestLogger?.info({
        traceId: decision.traceId,
        outcome: decision.outcome,
        suggest: decision.suggest,
        label: decision.label,
        statusCode: decision.statusCode,
        reason: decision.reason,
      }, 'media review callback received');
      if (decision.traceId) {
        const queued = await applyMediaCheckDecision(pool, decision);
        if (queued) onMediaQueued?.();
      }
    }
    response.type('text/plain').send('success');
  }));

  return router;
}

async function applyMediaCheckDecision(pool: Pool, decision: MediaCheckDecision): Promise<boolean> {
  const [mediaRows] = await pool.execute<MediaCallbackRow[]>(
    `SELECT media_id, processing_attempts
       FROM media_asset
      WHERE content_check_trace_id = ? AND status = 'processing'
      LIMIT 1`,
    [decision.traceId],
  );
  const media = mediaRows[0];
  if (!media) return false;

  if (decision.outcome === 'rejected') {
    await pool.execute(
      `UPDATE media_asset
          SET status = 'failed', content_check_status = 'rejected', failure_code = 'IMAGE_CONTENT_REJECTED',
              failure_message = '图片内容未通过安全检查', version = version + 1
        WHERE media_id = ? AND content_check_trace_id = ? AND status = 'processing'
          AND content_check_status NOT IN ('passed', 'rejected')`,
      [media.media_id, decision.traceId],
    );
  } else if (decision.outcome === 'passed') {
    await pool.execute(
      `UPDATE media_asset
          SET content_check_status = 'passed', failure_code = NULL, failure_message = NULL,
              status = IF(cutout_status = 'succeeded', 'ready', status),
              ready_at = IF(cutout_status = 'succeeded', UTC_TIMESTAMP(3), ready_at),
              version = version + 1
        WHERE media_id = ? AND content_check_trace_id = ? AND status = 'processing'
          AND content_check_status NOT IN ('passed', 'rejected')`,
      [media.media_id, decision.traceId],
    );
  } else if (media.processing_attempts >= 3) {
    await pool.execute(
      `UPDATE media_asset
          SET status = 'failed', content_check_status = 'failed',
              failure_code = 'MEDIA_CONTENT_CHECK_FAILED',
              failure_message = '图片安全检查服务暂时无法给出结果', version = version + 1
        WHERE media_id = ? AND content_check_trace_id = ? AND status = 'processing'
          AND content_check_status = 'processing'`,
      [media.media_id, decision.traceId],
    );
  } else {
    const [update] = await pool.execute<ResultSetHeader>(
      `UPDATE media_asset
          SET content_check_status = 'queued',
              failure_code = 'MEDIA_CONTENT_CHECK_RETRYING',
              failure_message = '图片安全检查正在重试', version = version + 1
        WHERE media_id = ? AND content_check_trace_id = ? AND status = 'processing'
          AND content_check_status = 'processing'`,
      [media.media_id, decision.traceId],
    );
    if (update.affectedRows === 1) {
      await pool.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'media.processing_requested', JSON_OBJECT('mediaId', ?, 'stage', 'content_check'))`,
        [media.media_id, media.media_id],
      );
      await syncRecordForMedia(pool, media.media_id);
      return true;
    }
  }

  await syncRecordForMedia(pool, media.media_id);
  return false;
}

export function isCloudHostingMessagePush(headers: Request['headers'], config: AppConfig): boolean {
  const context = parseCloudbaseContext(headers['x-cloudbase-context']);
  if (context) {
    return context.source === 'wx_wx_callback'
      && context.envId === config.cloudEnvId
      && context.serviceName === config.cloudService
      && headerValue(headers['x-wx-appid']) === config.appId
      && headerValue(headers['x-wx-env']) === config.cloudEnvId;
  }

  return Boolean(headerValue(headers['x-wx-sources']))
    && headerValue(headers['x-wx-appid']) === config.appId
    && headerValue(headers['x-wx-env']) === config.cloudEnvId;
}

export function isContainerPathCheck(event: Record<string, unknown>): boolean {
  return String(event.action ?? event.Action ?? '').toLowerCase() === 'checkcontainerpath';
}

export function parseEventBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== 'string' || !body.trim()) return {};
  const parsed = parser.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const envelope = parsed as Record<string, unknown>;
  const xml = envelope.xml;
  return xml && typeof xml === 'object' && !Array.isArray(xml)
    ? xml as Record<string, unknown>
    : envelope;
}

export function mediaCheckDecision(event: Record<string, unknown>): MediaCheckDecision | null {
  if (String(event.Event ?? event.event ?? '').toLowerCase() !== 'wxa_media_check') return null;
  const extra = safeJson(String(event.extra_info_json ?? event.ExtraInfoJson ?? '{}'));
  const traceId = String(event.trace_id ?? event.TraceId ?? extra.trace_id ?? '');
  const result = recordValue(event.result ?? event.Result);
  const resultSuggest = normalizeSuggest(result.suggest ?? result.Suggest);
  const resultLabel = scalar(result.label ?? result.Label);
  const statusCode = numericCode(event.status_code ?? event.StatusCode ?? event.errcode);
  if (statusCode !== 0) {
    return { traceId, outcome: 'retry', suggest: resultSuggest, label: resultLabel, statusCode, reason: 'service_error' };
  }
  if (resultSuggest) return decisionForSuggest(traceId, resultSuggest, resultLabel, statusCode, 'result');

  const details = recordList(event.detail ?? event.Detail ?? result.detail ?? result.Detail);
  const detailDecisions = details
    .filter((detail) => numericCode(detail.errcode ?? detail.ErrCode) === 0)
    .map((detail) => ({
      suggest: normalizeSuggest(detail.suggest ?? detail.Suggest),
      label: scalar(detail.label ?? detail.Label),
    }))
    .filter((detail): detail is { suggest: 'pass' | 'review' | 'risky'; label: string | number | null } => Boolean(detail.suggest));
  const risky = detailDecisions.find((detail) => detail.suggest === 'risky');
  if (risky) return decisionForSuggest(traceId, risky.suggest, risky.label, statusCode, 'detail');
  const detailError = details.find((detail) => numericCode(detail.errcode ?? detail.ErrCode) !== 0);
  if (detailError) {
    return {
      traceId,
      outcome: 'retry',
      suggest: null,
      label: scalar(detailError.label ?? detailError.Label),
      statusCode: numericCode(detailError.errcode ?? detailError.ErrCode),
      reason: 'service_error',
    };
  }
  const review = detailDecisions.find((detail) => detail.suggest === 'review');
  if (review) return decisionForSuggest(traceId, review.suggest, review.label, statusCode, 'detail');
  if (detailDecisions.length > 0 && detailDecisions.every((detail) => detail.suggest === 'pass')) {
    return decisionForSuggest(traceId, 'pass', detailDecisions[0].label, statusCode, 'detail');
  }

  const legacyRisk = event.isrisky ?? event.is_risky ?? event.IsRisky;
  if (legacyRisk !== undefined && legacyRisk !== null && String(legacyRisk) !== '') {
    return decisionForSuggest(traceId, String(legacyRisk) === '0' ? 'pass' : 'risky', null, statusCode, 'legacy');
  }
  return { traceId, outcome: 'retry', suggest: null, label: null, statusCode, reason: 'missing_verdict' };
}

function decisionForSuggest(
  traceId: string,
  suggest: 'pass' | 'review' | 'risky',
  label: string | number | null,
  statusCode: number,
  reason: 'result' | 'detail' | 'legacy',
): MediaCheckDecision {
  return {
    traceId,
    outcome: suggest === 'pass' ? 'passed' : suggest === 'risky' ? 'rejected' : 'retry',
    suggest,
    label,
    statusCode,
    reason,
  };
}

function normalizeSuggest(value: unknown): 'pass' | 'review' | 'risky' | null {
  const suggest = String(value ?? '').trim().toLowerCase();
  return suggest === 'pass' || suggest === 'review' || suggest === 'risky' ? suggest : null;
}

function numericCode(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const code = Number(value);
  return Number.isFinite(code) ? code : -1;
}

function scalar(value: unknown): string | number | null {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') return safeJson(value);
  return {};
}

function recordList(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; } catch { return []; }
  }
  if (Array.isArray(parsed)) return parsed.map(recordValue).filter((item) => Object.keys(item).length > 0);
  const record = recordValue(parsed);
  return Object.keys(record).length > 0 ? [record] : [];
}

function verifySignature(request: Request, config: AppConfig): void {
  const callbackTokens = [config.wechatCallbackToken, config.wechatCallbackTokenPrevious]
    .filter((value): value is string => Boolean(value));
  if (callbackTokens.length === 0) throw new AppError('CALLBACK_NOT_CONFIGURED', '微信回调尚未配置', 503);
  const timestamp = query(request, 'timestamp');
  const nonce = query(request, 'nonce');
  const signature = query(request, 'signature');
  if (!timestamp || !nonce || !signature) throw new AppError('INVALID_CALLBACK_SIGNATURE', '回调签名不正确', 401);
  const actualBuffer = createHash('sha256').update(signature).digest();
  const valid = callbackTokens.map((token) => {
    const expected = createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');
    return timingSafeEqual(actualBuffer, createHash('sha256').update(expected).digest());
  }).some(Boolean);
  if (!valid) {
    throw new AppError('INVALID_CALLBACK_SIGNATURE', '回调签名不正确', 401);
  }
}

function query(request: Request, name: string): string {
  const value = request.query[name];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(',') : value ?? '').trim();
}

function parseCloudbaseContext(value: string | string[] | undefined): {
  source?: string;
  envId?: string;
  serviceName?: string;
} | null {
  const encoded = headerValue(value);
  if (!encoded) return null;
  try {
    const json = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
    return JSON.parse(json) as { source?: string; envId?: string; serviceName?: string };
  } catch {
    return null;
  }
}
