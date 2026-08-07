import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { inTransaction } from '../db/pool';
import { queueCheckinNotifications } from './checkin-notifications';
import { refreshRecordProjections } from './record-projections';
import { evaluateStreakRewardsSafely } from './streak-rewards';

interface MediaIdRow extends RowDataPacket {
  media_id: string;
}

export async function syncRecordForMedia(executor: Pool, mediaId: string): Promise<void> {
  const synchronize = async (database: Pick<Pool, 'execute'>): Promise<string | null> => {
    const [update] = await database.execute<ResultSetHeader>(
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
                THEN COALESCE(r.first_effective_at, CURRENT_TIMESTAMP(3))
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
    const [records] = await database.execute<RowDataPacket[]>(
      `SELECT record_id, module_id, user_id, record_date, status FROM life_record WHERE media_id = ? LIMIT 1`,
      [mediaId],
    );
    const record = records[0];
    if (record?.status !== 'active') return null;
    const recordDate = record.record_date instanceof Date
      ? record.record_date.toISOString().slice(0, 10)
      : String(record.record_date).slice(0, 10);
    if (update.affectedRows === 1) {
      await refreshRecordProjections(database, String(record.module_id), recordDate);
      await queueCheckinNotifications(
        database,
        String(record.record_id),
        String(record.module_id),
        String(record.user_id),
      );
    }
    return String(record.record_id);
  };
  const activeRecordId = typeof executor.getConnection === 'function'
    ? await inTransaction(executor, synchronize)
    : await synchronize(executor);
  if (activeRecordId) await evaluateStreakRewardsSafely(executor, activeRecordId);
}

export async function syncRecordsForTraceId(executor: Pool, traceId: string): Promise<void> {
  const [rows] = await executor.execute<MediaIdRow[]>(
    'SELECT media_id FROM media_asset WHERE content_check_trace_id = ? LIMIT 1',
    [traceId],
  );
  if (rows[0]) await syncRecordForMedia(executor, String(rows[0].media_id));
}
