import { randomInt } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { inTransaction } from '../db/pool';
import { shanghaiDate } from '../lib/time';

type Queryable = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

interface TriggerRow extends RowDataPacket {
  record_id: string;
  module_id: string;
  member_instance_id: string;
  record_date: Date | string;
  source: string;
  status: string;
  record_policy: string;
  first_effective_at: Date | string | null;
}

export interface RewardRuleRow extends RowDataPacket {
  reward_rule_id: string;
  module_id: string;
  sponsor_user_id: string;
  sponsor_member_instance_id: string;
  sponsor_name_snapshot: string;
  target_type: 'all' | 'member';
  target_member_instance_id: string | null;
  cover_media_id: string | null;
  prize_title: string;
  prize_description: string | null;
  win_probability_bps: number;
  streak_days: number;
  status: 'active' | 'triggered' | 'cancelled' | 'expired';
  expires_at: Date;
  triggered_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date | string;
  updated_at: Date;
}

interface MemberRow extends RowDataPacket {
  member_instance_id: string;
  user_id: string;
  join_sequence: number;
}

interface CompletionRow extends RowDataPacket {
  record_id: string;
  member_instance_id: string;
  record_date: Date | string;
}

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function timestampValue(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function addDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateWindow(endDate: string, streakDays: number): string[] {
  return Array.from({ length: streakDays }, (_, index) => addDate(endDate, index - streakDays + 1));
}

async function membersOnDate(executor: Queryable, moduleId: string, date: string): Promise<MemberRow[]> {
  const [rows] = await executor.execute<MemberRow[]>(
    `SELECT member_instance_id, user_id, join_sequence
       FROM module_member
      WHERE module_id = ?
        AND DATE(DATE_ADD(joined_at, INTERVAL 8 HOUR)) <= ?
        AND (left_at IS NULL OR DATE(DATE_ADD(left_at, INTERVAL 8 HOUR)) > ?)
      ORDER BY join_sequence`,
    [moduleId, date, date],
  );
  return rows;
}

function sameIds(left: MemberRow[], right: MemberRow[]): boolean {
  return left.length === right.length
    && left.every((member, index) => String(member.member_instance_id) === String(right[index]?.member_instance_id));
}

async function completions(
  executor: Queryable,
  moduleId: string,
  dates: string[],
  memberIds: string[],
): Promise<Map<string, CompletionRow>> {
  if (!dates.length || !memberIds.length) return new Map();
  const datePlaceholders = dates.map(() => '?').join(',');
  const memberPlaceholders = memberIds.map(() => '?').join(',');
  const [rows] = await executor.execute<CompletionRow[]>(
    `SELECT record_id, member_instance_id, record_date
       FROM life_record
      WHERE module_id = ? AND record_date IN (${datePlaceholders})
        AND member_instance_id IN (${memberPlaceholders})
        AND source = 'normal' AND status IN ('active', 'locked')`,
    [moduleId, ...dates, ...memberIds],
  );
  return new Map(rows.map((row) => [`${dateValue(row.record_date)}:${row.member_instance_id}`, row]));
}

async function qualifyRule(
  executor: Queryable,
  rule: RewardRuleRow,
  endDate: string,
  triggerMemberInstanceId: string,
): Promise<{ members: MemberRow[]; dates: string[] } | undefined> {
  const dates = dateWindow(endDate, Number(rule.streak_days));
  const rosters = await Promise.all(dates.map((date) => membersOnDate(executor, rule.module_id, date)));
  if (rule.target_type === 'member') {
    const targetId = String(rule.target_member_instance_id ?? '');
    if (!targetId || triggerMemberInstanceId !== targetId) return undefined;
    if (rosters.some((roster) => !roster.some((member) => String(member.member_instance_id) === targetId))) return undefined;
    const target = rosters[rosters.length - 1].find((member) => String(member.member_instance_id) === targetId);
    if (!target) return undefined;
    const completed = await completions(executor, rule.module_id, dates, [targetId]);
    if (dates.some((date) => !completed.has(`${date}:${targetId}`))) return undefined;
    return { members: [target], dates };
  }

  const baseline = rosters[0];
  if (baseline.length < 2 || rosters.some((roster) => !sameIds(baseline, roster))) return undefined;
  const memberIds = baseline.map((member) => String(member.member_instance_id));
  const completed = await completions(executor, rule.module_id, dates, memberIds);
  if (dates.some((date) => memberIds.some((memberId) => !completed.has(`${date}:${memberId}`)))) return undefined;
  return { members: baseline, dates };
}

export async function evaluateStreakRewards(pool: Pool, triggerRecordId: string): Promise<number> {
  return inTransaction(pool, async (connection) => {
    const [triggers] = await connection.execute<TriggerRow[]>(
      `SELECT r.record_id, r.module_id, r.member_instance_id, r.record_date, r.source, r.status, r.first_effective_at,
              m.record_policy
         FROM life_record r
         JOIN life_module m ON m.module_id = r.module_id
        WHERE r.record_id = ?
        FOR UPDATE`,
      [triggerRecordId],
    );
    const trigger = triggers[0];
    const endDate = trigger ? dateValue(trigger.record_date) : '';
    if (!trigger || trigger.record_policy !== 'strict' || trigger.source !== 'normal'
      || !['active', 'locked'].includes(trigger.status) || endDate !== shanghaiDate()) return 0;

    await connection.execute(
      `UPDATE streak_reward_rule
          SET status = 'expired', updated_at = CURRENT_TIMESTAMP(3), version = version + 1
        WHERE module_id = ? AND status = 'active' AND expires_at <= CURRENT_TIMESTAMP(3)`,
      [trigger.module_id],
    );
    const [rules] = await connection.execute<RewardRuleRow[]>(
      `SELECT rr.*, mm.nickname_snapshot AS sponsor_name_snapshot
         FROM streak_reward_rule rr
         JOIN module_member mm ON mm.member_instance_id = rr.sponsor_member_instance_id
        WHERE rr.module_id = ? AND rr.status = 'active' AND rr.expires_at > CURRENT_TIMESTAMP(3)
        ORDER BY rr.reward_rule_id
        FOR UPDATE`,
      [trigger.module_id],
    );

    let triggered = 0;
    for (const rule of rules) {
      if (!trigger.first_effective_at || timestampValue(rule.created_at) > timestampValue(trigger.first_effective_at)) continue;
      const qualification = await qualifyRule(connection, rule, endDate, String(trigger.member_instance_id));
      if (!qualification) continue;
      const [eventInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO streak_reward_event
           (reward_rule_id, module_id, trigger_record_id, sponsor_name_snapshot, target_type,
            cover_media_id_snapshot, prize_title_snapshot, prize_description_snapshot, win_probability_bps,
            window_start, window_end, qualification_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [rule.reward_rule_id, rule.module_id, trigger.record_id, rule.sponsor_name_snapshot, rule.target_type,
          rule.cover_media_id, rule.prize_title, rule.prize_description, rule.win_probability_bps,
          qualification.dates[0], endDate,
          JSON.stringify({ memberInstanceIds: qualification.members.map((member) => String(member.member_instance_id)) })],
      );
      const eventId = String(eventInsert.insertId);
      for (const member of qualification.members) {
        const [stickerRows] = await connection.execute<CompletionRow[]>(
          `SELECT r.record_id, r.member_instance_id, r.record_date
             FROM life_record r
            WHERE r.module_id = ? AND r.member_instance_id = ?
              AND r.record_date BETWEEN ? AND ? AND r.source = 'normal'
              AND r.status IN ('active', 'locked')
            ORDER BY r.record_date DESC LIMIT 1`,
          [rule.module_id, member.member_instance_id, qualification.dates[0], endDate],
        );
        await connection.execute(
          `INSERT INTO streak_reward_draw
             (reward_event_id, module_id, recipient_user_id, recipient_member_instance_id,
              result_type, sticker_record_id, status)
           VALUES (?, ?, ?, ?, ?, ?, 'sealed')`,
          [eventId, rule.module_id, member.user_id, member.member_instance_id,
            randomInt(10_000) < rule.win_probability_bps ? 'gift' : 'sticker', stickerRows[0]?.record_id ?? null],
        );
      }
      await connection.execute(
        `UPDATE streak_reward_rule
            SET status = 'triggered', triggered_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE reward_rule_id = ? AND status = 'active'`,
        [rule.reward_rule_id],
      );
      triggered += 1;
    }
    return triggered;
  });
}

export async function evaluateStreakRewardsSafely(pool: Pool, triggerRecordId: string): Promise<number> {
  try {
    return await evaluateStreakRewards(pool, triggerRecordId);
  } catch (error) {
    console.error('[streak-reward] evaluation failed after record activation', { triggerRecordId, error });
    return 0;
  }
}

export async function rewardProgressDays(
  executor: Queryable,
  moduleId: string,
  targetType: 'all' | 'member',
  targetMemberInstanceId: string | null,
  streakDays: number,
): Promise<number> {
  let cursor = shanghaiDate();
  const complete = async (date: string, baseline?: MemberRow[]): Promise<{ done: boolean; roster: MemberRow[] }> => {
    const roster = await membersOnDate(executor, moduleId, date);
    const members = targetType === 'member'
      ? roster.filter((member) => String(member.member_instance_id) === String(targetMemberInstanceId))
      : roster;
    if ((targetType === 'all' && members.length < 2) || (targetType === 'member' && members.length !== 1)) {
      return { done: false, roster };
    }
    if (baseline && targetType === 'all' && !sameIds(baseline, roster)) return { done: false, roster };
    const done = (await completions(executor, moduleId, [date], members.map((member) => String(member.member_instance_id)))).size === members.length;
    return { done, roster };
  };
  let current = await complete(cursor);
  if (!current.done) {
    cursor = addDate(cursor, -1);
    current = await complete(cursor);
  }
  if (!current.done) return 0;
  const baseline = current.roster;
  let days = 0;
  while (days < streakDays) {
    const state = await complete(cursor, baseline);
    if (!state.done) break;
    days += 1;
    cursor = addDate(cursor, -1);
  }
  return days;
}
