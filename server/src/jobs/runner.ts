import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import { inTransaction } from '../db/pool';
import { shanghaiDate } from '../lib/time';
import type { StorageService } from '../services/storage';
import type { WechatService } from '../services/wechat';
import { syncRecordForMedia } from '../services/media-state';
import { invalidateMonthlyMemoryCards, recalculateDailySnapshot } from '../services/record-projections';
import type { MetricsRegistry } from '../observability/metrics';
import { analyticsUserHash } from '../lib/analytics';

interface RunnerDependencies {
  pool: Pool;
  storage: StorageService;
  wechat: WechatService;
  config: AppConfig;
  logger: Logger;
  instanceId: string;
  scheduleMediaWake?: (delayMs: number) => void;
  metrics?: MetricsRegistry;
}

interface OutboxRow extends RowDataPacket {
  event_id: string;
  aggregate_id: string;
  event_type: string;
  payload: string | Record<string, unknown>;
  retry_count: number;
  created_at: Date;
}

interface MediaJobRow extends RowDataPacket {
  media_id: string;
  owner_user_id: string;
  open_id: string;
  original_file_key: string;
  status: string;
  cutout_status: string;
  content_check_status: string;
  content_check_trace_id: string | null;
  processing_attempts: number;
  purpose: string;
}

type MediaFailureStage = 'cutout' | 'content_check';

class MediaProcessingError extends Error {
  constructor(readonly stages: MediaFailureStage[], errors: unknown[]) {
    super(errors.map(safeError).join('; ') || 'media processing failed');
    this.name = 'MediaProcessingError';
  }
}

export interface JobRunnerController {
  stop: (timeoutMs?: number) => Promise<void>;
  wake: () => void;
}

export function startJobRunner(dependencies: RunnerDependencies): JobRunnerController {
  let running = false;
  let stopped = false;
  let wakeRequested = false;
  let activeCycle: Promise<void> | null = null;
  const delayedWakes = new Set<ReturnType<typeof setTimeout>>();
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      wakeRequested = true;
      return activeCycle ?? Promise.resolve();
    }
    running = true;
    activeCycle = (async () => {
      try {
        await runCycle(dependencies);
      } catch (error) {
        dependencies.logger.error({ err: error }, 'job cycle failed');
      } finally {
        running = false;
        activeCycle = null;
        if (wakeRequested && !stopped) {
          wakeRequested = false;
          queueMicrotask(() => void tick());
        }
      }
    })();
    await activeCycle;
  };
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  dependencies.scheduleMediaWake = (delayMs) => {
    const delayed = setTimeout(() => {
      delayedWakes.delete(delayed);
      void tick();
    }, delayMs);
    delayed.unref();
    delayedWakes.add(delayed);
  };
  void tick();
  return {
    wake: () => void tick(),
    stop: async (timeoutMs = 8_000) => {
      stopped = true;
      wakeRequested = false;
      clearInterval(timer);
      delayedWakes.forEach((delayed) => clearTimeout(delayed));
      delayedWakes.clear();
      const draining = activeCycle;
      if (!draining) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          draining,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`Job runner drain timed out after ${timeoutMs}ms`)), timeoutMs);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

async function runCycle(deps: RunnerDependencies): Promise<void> {
  await processMediaEvents(deps);
  await processStorageDeleteEvents(deps);
  await processInviteCodeEvents(deps);
  await processMemoryExportEvents(deps);
  await publishPassiveEvents(deps.pool);

  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16);
  await runScheduled(deps, 'expire_state', minuteKey, () => expireState(deps.pool));
  if (deps.config.capabilities.subscriptions) {
    await runScheduled(deps, 'reminders', minuteKey, () => sendReminders(deps));
  }

  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hourKey = shanghaiNow.toISOString().slice(0, 13);
  await runScheduled(deps, 'cleanup', hourKey, () => cleanupExpiredRows(deps.pool));
  await runScheduled(deps, 'recycle_purge', hourKey, () => purgeExpiredModules(deps.pool));
  await runScheduled(deps, 'account_deletion', hourKey, () => finalizeAccountDeletions(deps));

  if (shanghaiNow.getUTCMinutes() >= 5 && shanghaiNow.getUTCMinutes() < 10) {
    const yesterday = new Date(shanghaiNow);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const date = yesterday.toISOString().slice(0, 10);
    await runScheduled(deps, 'daily_snapshot', date, () => createDailySnapshots(deps.pool, date));
  }
  await collectQueueMetrics(deps);
}

async function runScheduled(
  deps: RunnerDependencies,
  jobName: string,
  runKey: string,
  work: () => Promise<void>,
): Promise<void> {
  const claimed = await claimScheduled(deps.pool, jobName, runKey, deps.instanceId);
  if (!claimed) return;
  const startedAt = Date.now();
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewScheduledLease(deps.pool, jobName, runKey, deps.instanceId)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch((error: unknown) => {
        leaseLost = true;
        deps.logger.error({ err: error, jobName, runKey }, 'scheduled job lease renewal failed');
      });
  }, 60_000);
  heartbeat.unref();
  try {
    await work();
    if (leaseLost) throw new Error(`Scheduled job lease was lost: ${jobName}/${runKey}`);
    await deps.pool.execute(
      `UPDATE scheduled_job_run SET status = 'completed', completed_at = UTC_TIMESTAMP(3),
         locked_by = NULL, lock_expires_at = NULL, last_error = NULL
        WHERE job_name = ? AND run_key = ? AND locked_by = ?`,
      [jobName, runKey, deps.instanceId],
    );
    deps.metrics?.increment('scheduled_job_total', { job_name: jobName, result: 'completed' });
  } catch (error) {
    await deps.pool.execute(
      `UPDATE scheduled_job_run SET status = 'failed', last_error = ?, locked_by = NULL, lock_expires_at = NULL
        WHERE job_name = ? AND run_key = ? AND locked_by = ?`,
      [safeError(error), jobName, runKey, deps.instanceId],
    );
    deps.logger.error({ err: error, jobName, runKey }, 'scheduled job failed');
    deps.metrics?.increment('scheduled_job_total', { job_name: jobName, result: 'failed' });
  } finally {
    clearInterval(heartbeat);
    deps.metrics?.observe('scheduled_job_duration_seconds', (Date.now() - startedAt) / 1000, { job_name: jobName });
  }
}

async function renewScheduledLease(pool: Pool, jobName: string, runKey: string, instanceId: string): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE scheduled_job_run
        SET lock_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)
      WHERE job_name = ? AND run_key = ? AND status = 'running' AND locked_by = ?`,
    [jobName, runKey, instanceId],
  );
  return result.affectedRows === 1;
}

async function claimScheduled(pool: Pool, jobName: string, runKey: string, instanceId: string): Promise<boolean> {
  return inTransaction(pool, async (connection) => {
    const [insert] = await connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO scheduled_job_run
         (job_name, run_key, status, locked_by, lock_expires_at, attempt_count, started_at)
       VALUES (?, ?, 'running', ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE), 1, UTC_TIMESTAMP(3))`,
      [jobName, runKey, instanceId],
    );
    if (insert.affectedRows === 1) return true;

    const [update] = await connection.execute<ResultSetHeader>(
      `UPDATE scheduled_job_run
          SET status = 'running', locked_by = ?,
              lock_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE),
              attempt_count = attempt_count + 1, started_at = UTC_TIMESTAMP(3),
              completed_at = NULL, last_error = NULL
        WHERE job_name = ? AND run_key = ?
          AND (status = 'failed' OR (status = 'running' AND lock_expires_at < UTC_TIMESTAMP(3)))`,
      [instanceId, jobName, runKey],
    );
    return update.affectedRows === 1;
  });
}

async function processMediaEvents(deps: RunnerDependencies): Promise<void> {
  const events = await claimOutbox(deps.pool, 'media.processing_requested', 2);
  await Promise.all(events.map(async (event) => {
    try {
      deps.logger.info({
        mediaId: event.aggregate_id,
        queueDelayMs: Math.max(0, Date.now() - new Date(event.created_at).getTime()),
      }, 'media processing started');
      deps.metrics?.observe('media_queue_seconds', Math.max(0, Date.now() - new Date(event.created_at).getTime()) / 1000);
      await processOneMedia(deps, event.aggregate_id);
      await publishEvent(deps.pool, event.event_id);
    } catch (error) {
      const retryDelay = await retryEvent(deps.pool, event, error);
      if (retryDelay > 0) deps.scheduleMediaWake?.(retryDelay * 1000);
      deps.logger.error({ err: error, mediaId: event.aggregate_id }, 'media processing failed');
      deps.metrics?.increment('media_processing_total', { result: 'failed' });
    }
  }));
}

async function processOneMedia(deps: RunnerDependencies, mediaId: string): Promise<void> {
  const startedAt = Date.now();
  const [rows] = await deps.pool.execute<MediaJobRow[]>(
    `SELECT ma.media_id, ma.owner_user_id, u.open_id, ma.original_file_key, ma.status, ma.purpose,
            ma.cutout_status, ma.content_check_status, ma.content_check_trace_id, ma.processing_attempts
       FROM media_asset ma JOIN user_account u ON u.user_id = ma.owner_user_id
      WHERE ma.media_id = ? LIMIT 1`,
    [mediaId],
  );
  const media = rows[0];
  if (!media || media.status === 'ready' || media.status === 'failed'
    || media.status === 'abandoned' || media.content_check_status === 'rejected') return;
  const needsMatting = media.cutout_status === 'queued';
  const needsReview = media.content_check_status === 'queued';
  if (!needsMatting && !needsReview) return;
  const [update] = await deps.pool.execute<import('mysql2/promise').ResultSetHeader>(
    `UPDATE media_asset
       SET cutout_status = IF(cutout_status = 'queued', 'processing', cutout_status),
       content_check_status = IF(content_check_status = 'queued', 'processing', content_check_status),
       failure_code = NULL, failure_message = NULL,
       processing_attempts = processing_attempts + 1, version = version + 1
     WHERE media_id = ? AND status = 'processing'
       AND (cutout_status = 'queued' OR content_check_status = 'queued')`,
    [mediaId],
  );
  if (update.affectedRows !== 1) return;

  const base = `media/${media.owner_user_id}/${mediaId}`;
  const keys = {
    original: media.original_file_key,
    detailThumbnail: `${base}/detail.webp`,
    sticker: `${base}/sticker.png`,
    stickerThumbnail: `${base}/sticker-thumb.webp`,
  };
  if (deps.config.nodeEnv !== 'production') {
    await deps.pool.execute(
      `UPDATE media_asset SET thumbnail_file_key = ?, sticker_file_key = ?, sticker_thumbnail_file_key = ?,
         cutout_status = 'succeeded', content_check_status = 'passed', status = 'ready',
         failure_code = NULL, failure_message = NULL, ready_at = UTC_TIMESTAMP(3)
      WHERE media_id = ?`,
      [keys.original, keys.original, keys.original, mediaId],
    );
    await syncRecordForMedia(deps.pool, mediaId);
    return;
  }

  const submitReview = async (): Promise<void> => {
    const reviewStartedAt = Date.now();
    const mediaUrl = await deps.storage.signedUrl(keys.original, 900);
    const submittedTraceId = await deps.wechat.beginMediaCheck(
      media.open_id,
      mediaUrl,
      media.purpose === 'avatar' ? 1 : 4,
    );
    await deps.pool.execute(
      'UPDATE media_asset SET content_check_trace_id = ?, version = version + 1 WHERE media_id = ?',
      [submittedTraceId, mediaId],
    );
    deps.logger.info({ mediaId, durationMs: Date.now() - reviewStartedAt }, 'media review submitted');
  };

  const tasks: Array<{ stage: MediaFailureStage; promise: Promise<void> }> = [];
  if (needsMatting) {
    tasks.push({
      stage: 'cutout',
      promise: (async () => {
        const mattingStartedAt = Date.now();
        if (media.purpose === 'avatar') {
          await deps.pool.execute(
            `UPDATE media_asset
                SET thumbnail_file_key = original_file_key, sticker_file_key = original_file_key,
                    sticker_thumbnail_file_key = original_file_key, cutout_status = 'succeeded', version = version + 1
              WHERE media_id = ? AND status <> 'abandoned'`,
            [mediaId],
          );
        } else {
          await deps.storage.processImage(keys);
          await deps.pool.execute(
            `UPDATE media_asset
                SET thumbnail_file_key = ?, sticker_file_key = ?, sticker_thumbnail_file_key = ?,
                    cutout_status = 'succeeded', version = version + 1
              WHERE media_id = ? AND status <> 'abandoned'`,
            [keys.stickerThumbnail, keys.sticker, keys.stickerThumbnail, mediaId],
          );
        }
        deps.logger.info({ mediaId, durationMs: Date.now() - mattingStartedAt }, 'media matting completed');
      })(),
    });
  }
  if (needsReview) tasks.push({ stage: 'content_check', promise: submitReview() });

  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const failures = settled
    .map((result, index) => result.status === 'rejected'
      ? { stage: tasks[index].stage, error: result.reason as unknown }
      : null)
    .filter((result): result is { stage: MediaFailureStage; error: unknown } => Boolean(result));
  if (failures.length > 0) {
    throw new MediaProcessingError(failures.map((failure) => failure.stage), failures.map((failure) => failure.error));
  }

  await deps.pool.execute(
    `UPDATE media_asset
        SET failure_code = IF(content_check_status = 'rejected', 'IMAGE_CONTENT_REJECTED', NULL),
            failure_message = IF(content_check_status = 'rejected', '图片内容未通过安全检查', NULL),
            status = CASE
              WHEN content_check_status = 'rejected' THEN 'failed'
              WHEN content_check_status = 'passed' AND cutout_status = 'succeeded' THEN 'ready'
              ELSE 'processing'
            END,
            ready_at = IF(content_check_status = 'passed' AND cutout_status = 'succeeded', UTC_TIMESTAMP(3), ready_at),
            version = version + 1
      WHERE media_id = ? AND status <> 'abandoned'`,
    [mediaId],
  );
  await syncRecordForMedia(deps.pool, mediaId);
  deps.logger.info({ mediaId, purpose: media.purpose, durationMs: Date.now() - startedAt }, 'media processing stage completed');
}

async function processStorageDeleteEvents(deps: RunnerDependencies): Promise<void> {
  const events = await claimOutbox(deps.pool, 'storage.delete_requested', 3);
  for (const event of events) {
    try {
      const payload = parsePayload(event.payload);
      const keys = Array.isArray(payload.keys) ? payload.keys.map(String).filter(Boolean) : [];
      await deps.storage.deleteObjects(keys);
      await publishEvent(deps.pool, event.event_id);
    } catch (error) {
      await retryEvent(deps.pool, event, error);
    }
  }
}

async function processInviteCodeEvents(deps: RunnerDependencies): Promise<void> {
  const events = await claimOutbox(deps.pool, 'invite.code_requested', 3);
  for (const event of events) {
    try {
      const payload = parsePayload(event.payload);
      const publicInviteId = String(payload.publicInviteId ?? '');
      const secret = /^inv_\d+_([a-zA-Z0-9_-]{20,64})$/.exec(publicInviteId)?.[1];
      if (!secret) throw new Error('invalid invite payload');
      const objectKey = `invites/${event.aggregate_id}/code.png`;
      const code = await deps.wechat.getUnlimitedCode(secret.slice(0, 32), 'subpackages/invite-intro/index');
      await deps.storage.putGeneratedObject(objectKey, code, 'image/png');
      await deps.pool.execute(
        `UPDATE invite_token SET mini_program_code_file_key = ? WHERE invite_token_id = ?`,
        [objectKey, event.aggregate_id],
      );
      await publishEvent(deps.pool, event.event_id);
    } catch (error) {
      await retryEvent(deps.pool, event, error);
      deps.logger.error({ err: error, inviteId: event.aggregate_id }, 'invite code generation failed');
    }
  }
}

async function processMemoryExportEvents(deps: RunnerDependencies): Promise<void> {
  const events = await claimOutbox(deps.pool, 'memory.export_requested', 2);
  for (const event of events) {
    try {
      const [rows] = await deps.pool.execute<RowDataPacket[]>(
        `SELECT mc.memory_card_id, mc.month_key, m.name AS module_name
           FROM monthly_memory_card mc JOIN life_module m ON m.module_id = mc.module_id
          WHERE mc.memory_card_id = ? LIMIT 1`,
        [event.aggregate_id],
      );
      if (!rows[0]) throw new Error('memory card not found');
      const [items] = await deps.pool.execute<RowDataPacket[]>(
        `SELECT ma.sticker_file_key, ma.sticker_thumbnail_file_key
           FROM monthly_memory_card_item mci
           JOIN life_record r ON r.record_id = mci.record_id
           JOIN media_asset ma ON ma.media_id = r.media_id
          WHERE mci.memory_card_id = ? ORDER BY mci.display_order LIMIT 8`,
        [event.aggregate_id],
      );
      const sourceKeys = items.map((item) => String(item.sticker_file_key ?? item.sticker_thumbnail_file_key)).filter(Boolean);
      const objectKey = `memory-cards/${event.aggregate_id}/v${Date.now()}.webp`;
      await deps.storage.createMemoryCardExport({
        objectKey,
        moduleName: String(rows[0].module_name),
        month: String(rows[0].month_key),
        sourceKeys,
      });
      await deps.pool.execute(
        `UPDATE monthly_memory_card SET status = 'ready', generated_image_file_key = ? WHERE memory_card_id = ?`,
        [objectKey, event.aggregate_id],
      );
      await publishEvent(deps.pool, event.event_id);
    } catch (error) {
      await deps.pool.execute(`UPDATE monthly_memory_card SET status = 'failed' WHERE memory_card_id = ?`, [event.aggregate_id]);
      await retryEvent(deps.pool, event, error);
      deps.logger.error({ err: error, memoryCardId: event.aggregate_id }, 'memory card export failed');
    }
  }
}

async function publishPassiveEvents(pool: Pool): Promise<void> {
  await pool.execute(
    `UPDATE outbox_event SET status = 'audited', published_at = UTC_TIMESTAMP(3)
      WHERE status IN ('pending', 'failed')
        AND event_type NOT IN ('media.processing_requested', 'storage.delete_requested',
          'invite.code_requested', 'memory.export_requested')
        AND (next_retry_at IS NULL OR next_retry_at <= UTC_TIMESTAMP(3))
      ORDER BY event_id LIMIT 100`,
  );
}

async function claimOutbox(pool: Pool, eventType: string, limit: number): Promise<OutboxRow[]> {
  return inTransaction(pool, async (connection) => {
    // Cloud Hosting currently provides MySQL 5.7, which does not support SKIP LOCKED.
    // The transaction still keeps selecting and marking each batch atomic.
    const [rows] = await connection.query<OutboxRow[]>(
      `SELECT event_id, aggregate_id, event_type, payload, retry_count, created_at
         FROM outbox_event
        WHERE event_type = ? AND status IN ('pending', 'failed')
          AND (next_retry_at IS NULL OR next_retry_at <= UTC_TIMESTAMP(3))
        ORDER BY event_id LIMIT ? FOR UPDATE`,
      [eventType, limit],
    );
    if (!rows.length) return [];
    await connection.query(
      `UPDATE outbox_event SET status = 'publishing' WHERE event_id IN (${rows.map(() => '?').join(',')})`,
      rows.map((row) => row.event_id),
    );
    return rows;
  });
}

async function publishEvent(pool: Pool, eventId: string): Promise<void> {
  await pool.execute(
    `UPDATE outbox_event SET status = 'published', published_at = UTC_TIMESTAMP(3), next_retry_at = NULL WHERE event_id = ?`,
    [eventId],
  );
}

async function retryEvent(pool: Pool, event: OutboxRow, error: unknown): Promise<number> {
  const retry = event.retry_count + 1;
  const deadLetter = retry >= 8;
  const retryDelay = event.event_type === 'media.processing_requested'
    ? (retry === 1 ? 2 : 5)
    : Math.min(3600, 15 * 2 ** Math.min(retry, 8));
  await pool.execute(
    `UPDATE outbox_event SET status = ?, retry_count = ?,
       next_retry_at = IF(? = 1, NULL, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)),
       payload = JSON_SET(payload, '$.lastError', ?)
     WHERE event_id = ?`,
    [deadLetter ? 'dead_letter' : 'failed', retry, deadLetter ? 1 : 0, retryDelay, safeError(error), event.event_id],
  );
  if (event.event_type === 'media.processing_requested') {
    const stages = error instanceof MediaProcessingError ? error.stages : ['cutout'] as MediaFailureStage[];
    const failedCutout = stages.includes('cutout');
    const failedReview = stages.includes('content_check');
    const failureCode = failedCutout && failedReview
      ? 'MEDIA_PROCESSING_FAILED'
      : failedReview ? 'MEDIA_CONTENT_CHECK_FAILED' : 'CUTOUT_PROCESS_FAILED';
    await pool.execute(
      `UPDATE media_asset
          SET status = IF(processing_attempts >= 3, 'failed', 'processing'),
              cutout_status = CASE
                WHEN ? = 0 THEN cutout_status
                WHEN processing_attempts >= 3 THEN 'failed'
                ELSE 'queued'
              END,
              content_check_status = CASE
                WHEN ? = 0 THEN content_check_status
                WHEN processing_attempts >= 3 THEN 'failed'
                ELSE 'queued'
              END,
              failure_code = ?, failure_message = ?, version = version + 1
        WHERE media_id = ?`,
      [failedCutout ? 1 : 0, failedReview ? 1 : 0, failureCode, safeError(error), event.aggregate_id],
    );
  }
  return deadLetter ? 0 : retryDelay;
}

async function collectQueueMetrics(deps: RunnerDependencies): Promise<void> {
  if (!deps.metrics) return;
  const [rows] = await deps.pool.query<RowDataPacket[]>(
    `SELECT event_type, status, COUNT(*) AS total,
            COALESCE(TIMESTAMPDIFF(SECOND, MIN(created_at), UTC_TIMESTAMP(3)), 0) AS oldest_seconds
       FROM outbox_event
      WHERE status IN ('pending', 'failed', 'publishing')
      GROUP BY event_type, status`,
  );
  for (const row of rows) {
    const labels = { event_type: String(row.event_type), status: String(row.status) };
    deps.metrics.setGauge('outbox_pending_total', Number(row.total), labels);
    deps.metrics.setGauge('outbox_oldest_age_seconds', Number(row.oldest_seconds), labels);
  }
}

async function expireState(pool: Pool): Promise<void> {
  await inTransaction(pool, async (connection) => {
    await connection.execute(`UPDATE invite_token SET status = 'expired' WHERE status = 'active' AND expire_at <= UTC_TIMESTAMP(3)`);
    await connection.execute(
      `UPDATE life_record r JOIN makeup_approval a ON a.record_id = r.record_id
          SET r.status = 'expired', r.version = r.version + 1
        WHERE a.status = 'pending' AND a.expire_at <= UTC_TIMESTAMP(3) AND r.status = 'pending'`,
    );
    await connection.execute(
      `UPDATE makeup_approval SET status = 'expired', resolution_reason = 'timeout', version = version + 1
        WHERE status = 'pending' AND expire_at <= UTC_TIMESTAMP(3)`,
    );
    await connection.execute(
      `UPDATE join_application SET status = 'expired', resolution_reason = 'timeout', version = version + 1
        WHERE status = 'pending' AND expire_at <= UTC_TIMESTAMP(3)`,
    );
    await connection.execute(
      `UPDATE module_inbox_item SET status = 'expired' WHERE status IN ('unread', 'read') AND expire_at <= UTC_TIMESTAMP(3)`,
    );
    await connection.execute(
      `UPDATE notification SET action_status = 'expired'
        WHERE action_status = 'actionable' AND expired_at <= UTC_TIMESTAMP(3)`,
    );
  });
}

async function sendReminders(deps: RunnerDependencies): Promise<void> {
  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const time = shanghaiNow.toISOString().slice(11, 16);
  const today = shanghaiNow.toISOString().slice(0, 10);
  const [rows] = await deps.pool.execute<RowDataPacket[]>(
    `SELECT rs.reminder_id, rs.user_id, rs.module_id, u.open_id, m.name AS module_name
       FROM reminder_subscription rs
       JOIN user_account u ON u.user_id = rs.user_id
       JOIN life_module m ON m.module_id = rs.module_id
      WHERE rs.enabled = 1 AND rs.subscription_status = 'authorized'
        AND TIME_FORMAT(rs.reminder_time, '%H:%i') = ?
        AND (rs.last_sent_date IS NULL OR rs.last_sent_date <> ?)
        AND m.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM life_record r WHERE r.module_id = rs.module_id AND r.user_id = rs.user_id
            AND r.record_date = ? AND r.status IN ('active', 'locked')
        )
      LIMIT 100`,
    [time, today, today],
  );
  for (const row of rows) {
    try {
      await deps.wechat.sendSubscriptionMessage({
        touser: row.open_id,
        template_id: deps.config.subscribeTemplateId,
        page: `/pages/module-detail/index?moduleId=${publicModuleId(row.module_id)}`,
        miniprogram_state: 'formal',
        lang: 'zh_CN',
        data: {
          [deps.config.subscribeFields.thing]: { value: String(row.module_name).slice(0, 20) },
          [deps.config.subscribeFields.time]: { value: time },
          [deps.config.subscribeFields.note]: { value: '今天还没有记录，来留下一张照片吧' },
        },
      });
      await deps.pool.execute(
        `UPDATE reminder_subscription SET last_sent_date = ?, last_send_status = 'sent', last_failure_reason = NULL
          WHERE reminder_id = ? AND (last_sent_date IS NULL OR last_sent_date <> ?)`,
        [today, row.reminder_id, today],
      );
    } catch (error) {
      await deps.pool.execute(
        `UPDATE reminder_subscription SET last_send_status = 'failed', last_failure_reason = ? WHERE reminder_id = ?`,
        [safeError(error).slice(0, 64), row.reminder_id],
      );
    }
  }
}

async function createDailySnapshots(pool: Pool, recordDate: string): Promise<void> {
  const [modules] = await pool.execute<RowDataPacket[]>(
    `SELECT module_id FROM life_module WHERE status IN ('active', 'pending_delete')`,
  );
  for (const module of modules) {
    await inTransaction(pool, async (connection) => {
      await recalculateDailySnapshot(connection, String(module.module_id), recordDate);
      await invalidateMonthlyMemoryCards(connection, String(module.module_id), recordDate.slice(0, 7));
    });
  }
}

async function cleanupExpiredRows(pool: Pool): Promise<void> {
  await pool.execute(`DELETE FROM auth_session WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) OR revoked_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)`);
  await pool.execute(`DELETE FROM idempotency_request WHERE expire_at < UTC_TIMESTAMP(3)`);
  await pool.execute(`DELETE FROM outbox_event WHERE status IN ('published', 'audited') AND published_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)`);
  await pool.execute(`DELETE FROM scheduled_job_run WHERE status = 'completed' AND completed_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)`);
  await pool.execute(`DELETE FROM analytics_event WHERE received_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 90 DAY)`);
  const [orphans] = await pool.execute<RowDataPacket[]>(
    `SELECT media_id, original_file_key, thumbnail_file_key, sticker_file_key, sticker_thumbnail_file_key
       FROM media_asset ma
      WHERE ma.updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
        AND ma.status IN ('created', 'uploading', 'uploaded', 'failed', 'abandoned')
        AND NOT EXISTS (SELECT 1 FROM life_record r WHERE r.media_id = ma.media_id)
      LIMIT 100`,
  );
  for (const media of orphans) {
    await inTransaction(pool, async (connection) => {
      const keys = [media.original_file_key, media.thumbnail_file_key, media.sticker_file_key, media.sticker_thumbnail_file_key].filter(Boolean);
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('media', ?, 'storage.delete_requested', ?)`,
        [media.media_id, JSON.stringify({ keys })],
      );
      await connection.execute('DELETE FROM media_asset WHERE media_id = ?', [media.media_id]);
    });
  }
}

async function purgeExpiredModules(pool: Pool): Promise<void> {
  const [modules] = await pool.execute<RowDataPacket[]>(
    `SELECT module_id FROM life_module
      WHERE status = 'pending_delete' AND recycle_expire_at <= UTC_TIMESTAMP(3) LIMIT 10`,
  );
  for (const module of modules) await purgeModule(pool, String(module.module_id));
}

async function purgeModule(pool: Pool, moduleId: string): Promise<void> {
  await inTransaction(pool, async (connection) => {
    const [media] = await connection.execute<RowDataPacket[]>(
      `SELECT media_id, original_file_key, thumbnail_file_key, sticker_file_key, sticker_thumbnail_file_key
         FROM media_asset WHERE module_id = ? FOR UPDATE`,
      [moduleId],
    );
    const keys = media.flatMap((item) => [item.original_file_key, item.thumbnail_file_key, item.sticker_file_key, item.sticker_thumbnail_file_key]).filter(Boolean);
    if (keys.length) {
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('module', ?, 'storage.delete_requested', ?)`,
        [moduleId, JSON.stringify({ keys })],
      );
    }
    await connection.execute(`DELETE aa FROM approval_action aa JOIN makeup_approval ma ON ma.approval_id = aa.approval_id WHERE ma.module_id = ?`, [moduleId]);
    await connection.execute('DELETE FROM module_inbox_item WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM notification WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM reaction WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM makeup_approval WHERE module_id = ?', [moduleId]);
    await connection.execute(`DELETE rr FROM record_revision rr JOIN life_record r ON r.record_id = rr.record_id WHERE r.module_id = ?`, [moduleId]);
    await connection.execute(`DELETE sm FROM daily_module_snapshot_member sm JOIN daily_module_snapshot s ON s.snapshot_id = sm.snapshot_id WHERE s.module_id = ?`, [moduleId]);
    await connection.execute('DELETE FROM daily_module_snapshot WHERE module_id = ?', [moduleId]);
    await connection.execute(`DELETE mci FROM monthly_memory_card_item mci JOIN monthly_memory_card mc ON mc.memory_card_id = mci.memory_card_id WHERE mc.module_id = ?`, [moduleId]);
    await connection.execute('DELETE FROM monthly_memory_card WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM life_record WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM media_asset WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM join_application WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM invite_token WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM reminder_subscription WHERE module_id = ?', [moduleId]);
    await connection.execute('DELETE FROM user_module_preference WHERE module_id = ?', [moduleId]);
    await connection.execute(
      `UPDATE module_member SET status = IF(status = 'active', 'removed', status), left_at = COALESCE(left_at, UTC_TIMESTAMP(3)),
         leave_reason = COALESCE(leave_reason, 'module_deleted'), nickname_snapshot = '已删除成员', avatar_file_key_snapshot = NULL
       WHERE module_id = ?`,
      [moduleId],
    );
    await connection.execute(
      `UPDATE life_module SET status = 'deleted', active_member_count = 0, deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP(3)),
         version = version + 1 WHERE module_id = ?`,
      [moduleId],
    );
  });
}

async function finalizeAccountDeletions(deps: RunnerDependencies): Promise<void> {
  const { pool } = deps;
  const [users] = await pool.execute<RowDataPacket[]>(
    `SELECT deletion_request_id, user_id FROM account_deletion_request
      WHERE (status = 'cooling_off' AND execute_after <= UTC_TIMESTAMP(3)) OR status = 'processing'
      ORDER BY deletion_request_id LIMIT 10`,
  );
  for (const item of users) {
    await inTransaction(pool, async (connection) => {
      await connection.execute(
        `UPDATE account_deletion_request SET status = 'processing'
          WHERE deletion_request_id = ? AND status IN ('cooling_off', 'processing')`,
        [item.deletion_request_id],
      );
      await connection.execute('UPDATE auth_session SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [item.user_id]);
      const [members] = await connection.execute<RowDataPacket[]>(
        `SELECT member_instance_id, module_id FROM module_member
          WHERE user_id = ? AND status = 'active' AND role = 'member' FOR UPDATE`,
        [item.user_id],
      );
      for (const member of members) {
        await connection.execute(
          `UPDATE module_member SET status = 'exited', left_at = UTC_TIMESTAMP(3), leave_reason = 'account_deleted',
             nickname_snapshot = '已注销用户', avatar_file_key_snapshot = NULL
           WHERE member_instance_id = ?`,
          [member.member_instance_id],
        );
        await connection.execute(
          `UPDATE life_module SET active_member_count = GREATEST(active_member_count - 1, 0) WHERE module_id = ?`,
          [member.module_id],
        );
      }
    });

    const [ownedModules] = await pool.execute<RowDataPacket[]>(
      `SELECT module_id FROM life_module WHERE creator_user_id = ? AND status <> 'deleted'`,
      [item.user_id],
    );
    for (const module of ownedModules) await purgeModule(pool, String(module.module_id));

    await eraseUserData(pool, String(item.user_id), String(item.deletion_request_id), deps.config.analyticsHashSalt);
  }
}

async function eraseUserData(pool: Pool, userId: string, deletionRequestId: string, analyticsHashSalt: string | null): Promise<void> {
  await inTransaction(pool, async (connection) => {
    const [media] = await connection.execute<RowDataPacket[]>(
      `SELECT media_id, original_file_key, thumbnail_file_key, sticker_file_key, sticker_thumbnail_file_key
         FROM media_asset WHERE owner_user_id = ? FOR UPDATE`,
      [userId],
    );
    const keys = media.flatMap((row) => [
      row.original_file_key,
      row.thumbnail_file_key,
      row.sticker_file_key,
      row.sticker_thumbnail_file_key,
    ]).filter(Boolean);
    if (keys.length) {
      await connection.execute(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('user', ?, 'storage.delete_requested', ?)`,
        [userId, JSON.stringify({ keys })],
      );
    }

    await connection.execute(
      `DELETE n FROM notification n
        JOIN life_record r ON n.target_type = 'record' AND n.target_id = r.record_id
       WHERE r.user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE i FROM module_inbox_item i
        JOIN makeup_approval ma ON i.target_type = 'makeup_approval' AND i.target_id = ma.approval_id
       WHERE ma.applicant_user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE n FROM notification n
        JOIN join_application ja ON n.target_type = 'join_application' AND n.target_id = ja.application_id
       WHERE ja.applicant_user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE mci FROM monthly_memory_card_item mci
        JOIN life_record r ON r.record_id = mci.record_id WHERE r.user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE mci FROM monthly_memory_card_item mci
        JOIN monthly_memory_card mc ON mc.memory_card_id = mci.memory_card_id WHERE mc.user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE daily_module_snapshot_member sm
        JOIN life_record r ON r.record_id = sm.record_id
         SET sm.record_id = NULL, sm.has_effective_record = 0
       WHERE r.user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE aa FROM approval_action aa
        LEFT JOIN makeup_approval ma ON ma.approval_id = aa.approval_id
        LEFT JOIN life_record r ON r.record_id = ma.record_id
       WHERE aa.operator_user_id = ? OR r.user_id = ?`,
      [userId, userId],
    );
    await connection.execute(
      `DELETE re FROM reaction re
        LEFT JOIN life_record r ON r.record_id = re.record_id
       WHERE re.reactor_user_id = ? OR r.user_id = ?`,
      [userId, userId],
    );
    await connection.execute(
      `DELETE rr FROM record_revision rr JOIN life_record r ON r.record_id = rr.record_id WHERE r.user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE ma FROM makeup_approval ma JOIN life_record r ON r.record_id = ma.record_id WHERE r.user_id = ?`,
      [userId],
    );
    await connection.execute('DELETE FROM life_record WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM monthly_memory_card WHERE user_id = ?', [userId]);

    await connection.execute(
      `DELETE n FROM notification n
        JOIN join_application ja ON n.target_type = 'join_application' AND n.target_id = ja.application_id
        JOIN invite_token i ON i.invite_token_id = ja.invite_token_id
       WHERE i.created_by_user_id = ?`,
      [userId],
    );
    await connection.execute(
      `DELETE ja FROM join_application ja JOIN invite_token i ON i.invite_token_id = ja.invite_token_id
       WHERE i.created_by_user_id = ?`,
      [userId],
    );
    await connection.execute('DELETE FROM join_application WHERE applicant_user_id = ?', [userId]);
    await connection.execute('DELETE FROM invite_token WHERE created_by_user_id = ?', [userId]);
    await connection.execute('DELETE FROM media_asset WHERE owner_user_id = ?', [userId]);
    await connection.execute('DELETE FROM auth_session WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM privacy_consent WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM notification WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM module_inbox_item WHERE recipient_user_id = ?', [userId]);
    await connection.execute('DELETE FROM reminder_subscription WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM user_module_preference WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM idempotency_request WHERE user_id = ?', [userId]);
    if (analyticsHashSalt) {
      await connection.execute('DELETE FROM analytics_event WHERE user_hash = ?', [analyticsUserHash(userId, analyticsHashSalt)]);
    }
    await connection.execute(
      `UPDATE module_member SET status = IF(status = 'active', 'exited', status),
         left_at = COALESCE(left_at, UTC_TIMESTAMP(3)), leave_reason = COALESCE(leave_reason, 'account_deleted'),
         nickname_snapshot = '已注销用户', avatar_file_key_snapshot = NULL, version = version + 1
       WHERE user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE join_application SET applicant_name_snapshot = '已注销用户', applicant_avatar_file_key_snapshot = NULL
       WHERE applicant_user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE audit_log SET detail = NULL, ip_hash = NULL WHERE operator_user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE user_account SET open_id = CONCAT('deleted:', user_id, ':', UNIX_TIMESTAMP()), union_id = NULL,
         nickname = '已注销用户', avatar_file_key = NULL, status = 'deleted', version = version + 1
       WHERE user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE account_deletion_request SET status = 'completed', completed_at = UTC_TIMESTAMP(3)
       WHERE deletion_request_id = ? AND status = 'processing'`,
      [deletionRequestId],
    );
  });
}

function parsePayload(payload: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function publicModuleId(value: unknown): string {
  return `m_${String(value)}`;
}
