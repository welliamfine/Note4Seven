import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

interface CheckinSubscriptionRow extends RowDataPacket {
  reminder_id: string;
  user_id: string;
}

interface SqlExecutor {
  execute: Pool['execute'];
}

const MAX_TEMPLATE_VALUE_LENGTH = 20;
const CHECKIN_NOTE_SUFFIX = '刚刚发布了新内容，快来看看吧';

export async function queueCheckinNotifications(
  executor: SqlExecutor,
  recordId: string,
  moduleId: string,
  actorUserId: string,
): Promise<number> {
  const [subscriptions] = await executor.execute<CheckinSubscriptionRow[]>(
    `SELECT rs.reminder_id, rs.user_id
       FROM reminder_subscription rs
       JOIN module_member mm ON mm.member_instance_id = rs.member_instance_id
       JOIN life_module m ON m.module_id = rs.module_id
      WHERE rs.module_id = ? AND rs.user_id <> ?
        AND rs.checkin_notify_enabled = 1 AND rs.checkin_notify_credits > 0
        AND mm.status = 'active' AND m.status = 'active' AND m.mode = 'group'
      ORDER BY mm.join_sequence
      FOR UPDATE`,
    [moduleId, actorUserId],
  );

  let queued = 0;
  for (const subscription of subscriptions) {
    const [update] = await executor.execute<ResultSetHeader>(
      `UPDATE reminder_subscription
          SET checkin_notify_enabled = IF(checkin_notify_credits > 1, 1, 0),
              checkin_notify_status = IF(checkin_notify_credits > 1, 'authorized', 'exhausted'),
              checkin_notify_credits = checkin_notify_credits - 1,
              checkin_notify_last_send_status = 'queued',
              checkin_notify_last_failure_reason = NULL,
              version = version + 1
        WHERE reminder_id = ? AND checkin_notify_enabled = 1 AND checkin_notify_credits > 0`,
      [subscription.reminder_id],
    );
    if (update.affectedRows !== 1) continue;
    await executor.execute(
      `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('record', ?, 'checkin.notification_requested',
         JSON_OBJECT('subscriptionId', ?, 'recipientUserId', ?))`,
      [recordId, subscription.reminder_id, subscription.user_id],
    );
    queued += 1;
  }
  return queued;
}

export function checkinNotificationData(
  actorName: string,
  moduleName: string,
  time: string,
  fields: { thing: string; time: string; note: string },
): Record<string, { value: string }> {
  return {
    [fields.thing]: { value: truncateTemplateValue(moduleName) },
    [fields.time]: { value: time },
    [fields.note]: { value: `${truncateTemplateValue(actorName, MAX_TEMPLATE_VALUE_LENGTH - [...CHECKIN_NOTE_SUFFIX].length)}${CHECKIN_NOTE_SUFFIX}` },
  };
}

function truncateTemplateValue(value: string, maximum = MAX_TEMPLATE_VALUE_LENGTH): string {
  return [...value.trim()].slice(0, Math.max(0, maximum)).join('');
}
