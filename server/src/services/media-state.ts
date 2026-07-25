import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

type Executor = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

interface MediaIdRow extends RowDataPacket {
  media_id: string;
}

export async function syncRecordForMedia(executor: Executor, mediaId: string): Promise<void> {
  await executor.execute(
    `UPDATE life_record r
       JOIN media_asset ma ON ma.media_id = r.media_id
        SET r.status = CASE
              WHEN ma.content_check_status = 'rejected' THEN 'rejected'
              WHEN ma.status = 'abandoned' THEN 'cancelled'
              WHEN ma.status = 'ready'
               AND ma.content_check_status = 'passed'
               AND ma.cutout_status = 'succeeded'
               AND ma.sticker_file_key IS NOT NULL THEN 'active'
              ELSE r.status
            END,
            r.first_effective_at = CASE
              WHEN ma.status = 'ready'
               AND ma.content_check_status = 'passed'
               AND ma.cutout_status = 'succeeded'
               AND ma.sticker_file_key IS NOT NULL
                THEN COALESCE(r.first_effective_at, UTC_TIMESTAMP(3))
              ELSE r.first_effective_at
            END,
            r.version = CASE
              WHEN ma.content_check_status = 'rejected'
                OR ma.status = 'abandoned'
                OR (ma.status = 'ready'
                  AND ma.content_check_status = 'passed'
                  AND ma.cutout_status = 'succeeded'
                  AND ma.sticker_file_key IS NOT NULL)
                THEN r.version + 1
              ELSE r.version
            END
      WHERE r.media_id = ? AND r.source = 'normal' AND r.status = 'pending'`,
    [mediaId],
  );
}

export async function syncRecordsForTraceId(executor: Executor, traceId: string): Promise<void> {
  const [rows] = await executor.execute<MediaIdRow[]>(
    'SELECT media_id FROM media_asset WHERE content_check_trace_id = ? LIMIT 1',
    [traceId],
  );
  if (rows[0]) await syncRecordForMedia(executor, String(rows[0].media_id));
}
