import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { shanghaiDate } from '../lib/time';

type Executor = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

export async function refreshRecordProjections(
  executor: Executor,
  moduleId: string,
  recordDate: string,
): Promise<void> {
  if (recordDate < shanghaiDate()) await recalculateDailySnapshot(executor, moduleId, recordDate);
  await invalidateMonthlyMemoryCards(executor, moduleId, recordDate.slice(0, 7));
}

export async function recalculateDailySnapshot(
  executor: Executor,
  moduleId: string,
  recordDate: string,
): Promise<void> {
  const [snapshots] = await executor.execute<RowDataPacket[]>(
    'SELECT snapshot_id FROM daily_module_snapshot WHERE module_id = ? AND record_date = ? FOR UPDATE',
    [moduleId, recordDate],
  );
  const existingSnapshotId = snapshots[0] ? String(snapshots[0].snapshot_id) : null;
  let members: RowDataPacket[];
  if (existingSnapshotId) {
    [members] = await executor.execute<RowDataPacket[]>(
      `SELECT member_instance_id, join_sequence_snapshot AS join_sequence
         FROM daily_module_snapshot_member WHERE snapshot_id = ? ORDER BY join_sequence_snapshot`,
      [existingSnapshotId],
    );
  } else {
    const dayEnd = new Date(`${recordDate}T23:59:59.999+08:00`);
    [members] = await executor.execute<RowDataPacket[]>(
      `SELECT member_instance_id, join_sequence FROM module_member
        WHERE module_id = ? AND joined_at <= ? AND (left_at IS NULL OR left_at > ?)
        ORDER BY join_sequence FOR UPDATE`,
      [moduleId, dayEnd, dayEnd],
    );
  }

  const [records] = await executor.execute<RowDataPacket[]>(
    `SELECT record_id, member_instance_id FROM life_record
      WHERE module_id = ? AND record_date = ? AND status IN ('active', 'locked')`,
    [moduleId, recordDate],
  );
  const recordByMember = new Map(records.map((row) => [String(row.member_instance_id), String(row.record_id)]));
  const completed = members.filter((member) => recordByMember.has(String(member.member_instance_id))).length;
  const allCompleted = members.length > 0 && completed === members.length;

  await executor.execute(
    `INSERT INTO daily_module_snapshot
       (module_id, record_date, required_member_count, completed_member_count, is_all_completed,
        calculation_version, calculated_at)
     VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE completed_member_count = VALUES(completed_member_count),
       is_all_completed = VALUES(is_all_completed), calculation_version = calculation_version + 1,
       calculated_at = UTC_TIMESTAMP(3)`,
    [moduleId, recordDate, members.length, completed, allCompleted],
  );
  const [currentSnapshots] = await executor.execute<RowDataPacket[]>(
    'SELECT snapshot_id FROM daily_module_snapshot WHERE module_id = ? AND record_date = ? FOR UPDATE',
    [moduleId, recordDate],
  );
  const snapshotId = String(currentSnapshots[0].snapshot_id);
  for (const member of members) {
    const recordId = recordByMember.get(String(member.member_instance_id)) ?? null;
    await executor.execute(
      `INSERT INTO daily_module_snapshot_member
         (snapshot_id, member_instance_id, join_sequence_snapshot, has_effective_record, record_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE has_effective_record = VALUES(has_effective_record), record_id = VALUES(record_id)`,
      [snapshotId, member.member_instance_id, member.join_sequence, Boolean(recordId), recordId],
    );
  }
}

export async function invalidateMonthlyMemoryCards(
  executor: Executor,
  moduleId: string,
  month: string,
): Promise<void> {
  const [cards] = await executor.execute<RowDataPacket[]>(
    `SELECT memory_card_id, generated_image_file_key FROM monthly_memory_card
      WHERE module_id = ? AND month_key = ? FOR UPDATE`,
    [moduleId, month],
  );
  if (!cards.length) return;
  const cardIds = cards.map((card) => String(card.memory_card_id));
  const placeholders = cardIds.map(() => '?').join(',');
  await executor.execute(`DELETE FROM monthly_memory_card_item WHERE memory_card_id IN (${placeholders})`, cardIds);
  await executor.execute(
    `UPDATE monthly_memory_card SET data_version = UUID(), generation_version = generation_version + 1,
       status = 'ready', generated_image_file_key = NULL WHERE memory_card_id IN (${placeholders})`,
    cardIds,
  );
  for (const card of cards) {
    if (!card.generated_image_file_key) continue;
    await executor.execute(
      `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('memory_card', ?, 'storage.delete_requested', ?)`,
      [card.memory_card_id, JSON.stringify({ keys: [String(card.generated_image_file_key)] })],
    );
  }
}
