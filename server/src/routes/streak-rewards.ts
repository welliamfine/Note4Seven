import { randomInt } from 'node:crypto';
import { Router } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { asyncRoute, ok, parseBody } from '../lib/http';
import { parsePublicId, publicId } from '../lib/ids';
import { addDays, isoWithShanghaiOffset, shanghaiDate } from '../lib/time';
import { authUser } from '../middleware/auth';
import { requireMember } from '../services/access';
import { idempotent } from '../services/idempotency';
import type { StorageService } from '../services/storage';
import { rewardProgressDays, type RewardRuleRow } from '../services/streak-rewards';
import type { WechatService } from '../services/wechat';

const saveBody = z.object({
  targetType: z.enum(['all', 'member']),
  targetMemberInstanceId: z.string().optional(),
  streakDays: z.number().int().min(1).max(100).default(7),
  prizeTitle: z.string().trim().min(1).max(20),
  prizeDescription: z.string().trim().max(80).default(''),
  coverMediaId: z.string().optional(),
  winProbability: z.union([z.literal(20), z.literal(50), z.literal(80), z.literal(100)]),
  termsAccepted: z.literal(true),
  clientRequestId: z.string().min(8).max(64),
});
const simpleWriteBody = z.object({ clientRequestId: z.string().min(8).max(64) });

interface TargetRow extends RowDataPacket {
  member_instance_id: string;
  nickname_snapshot: string;
}

interface DrawRow extends RowDataPacket {
  reward_draw_id: string;
  reward_event_id: string;
  module_id: string;
  recipient_user_id: string;
  recipient_member_instance_id: string;
  result_type: 'gift' | 'sticker';
  status: 'sealed' | 'revealed';
  sticker_file_key: string | null;
  cover_sticker_file_key: string | null;
  sticker_record_date: Date | string | null;
  sticker_remark: string | null;
  sticker_member_name: string | null;
  sponsor_user_id: string;
  sponsor_name_snapshot: string;
  target_type: 'all' | 'member';
  streak_days: number;
  prize_title_snapshot: string;
  prize_description_snapshot: string | null;
  window_start: Date | string;
  window_end: Date | string;
  recipient_name: string;
  created_at: Date;
  revealed_at: Date | null;
}

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dbId(value: string | string[] | undefined, prefix: string): string {
  try {
    return parsePublicId(String(value ?? ''), prefix);
  } catch {
    throw new AppError('VALIDATION_ERROR', '资源编号格式不正确', 422);
  }
}

function serializeRule(row: RewardRuleRow) {
  return {
    rewardRuleId: publicId('rr', row.reward_rule_id),
    moduleId: publicId('m', row.module_id),
    sponsorUserId: publicId('u', row.sponsor_user_id),
    sponsorMemberInstanceId: publicId('mi', row.sponsor_member_instance_id),
    targetType: row.target_type,
    targetMemberInstanceId: row.target_member_instance_id ? publicId('mi', row.target_member_instance_id) : null,
    coverMediaId: row.cover_media_id ? publicId('media', row.cover_media_id) : null,
    prizeTitle: row.prize_title,
    prizeDescription: row.prize_description ?? '',
    winProbability: row.win_probability_bps / 100,
    streakDays: Number(row.streak_days),
    status: row.status,
    expiresAt: isoWithShanghaiOffset(row.expires_at),
    triggeredAt: row.triggered_at ? isoWithShanghaiOffset(row.triggered_at) : null,
    cancelledAt: row.cancelled_at ? isoWithShanghaiOffset(row.cancelled_at) : null,
    createdAt: isoWithShanghaiOffset(row.created_at),
    updatedAt: isoWithShanghaiOffset(row.updated_at),
  };
}

interface RewardRuleListRow extends RewardRuleRow {
  target_member_name: string | null;
  cover_sticker_file_key: string | null;
}

async function listRules(pool: Pool, moduleId: string, sponsorMemberInstanceId: string): Promise<RewardRuleListRow[]> {
  await pool.execute(
    `UPDATE streak_reward_rule
        SET status = 'expired', updated_at = CURRENT_TIMESTAMP(3), version = version + 1
      WHERE module_id = ? AND sponsor_member_instance_id = ?
        AND status = 'active' AND expires_at <= CURRENT_TIMESTAMP(3)`,
    [moduleId, sponsorMemberInstanceId],
  );
  const [rows] = await pool.execute<RewardRuleListRow[]>(
    `SELECT rr.*, mm.nickname_snapshot AS sponsor_name_snapshot,
            tm.nickname_snapshot AS target_member_name,
            cm.sticker_thumbnail_file_key AS cover_sticker_file_key
       FROM streak_reward_rule rr
       JOIN module_member mm ON mm.member_instance_id = rr.sponsor_member_instance_id
       LEFT JOIN module_member tm ON tm.member_instance_id = rr.target_member_instance_id
       LEFT JOIN media_asset cm ON cm.media_id = rr.cover_media_id
      WHERE rr.module_id = ? AND rr.sponsor_member_instance_id = ?
      ORDER BY rr.reward_rule_id DESC`,
    [moduleId, sponsorMemberInstanceId],
  );
  return rows;
}

export function streakRewardRoutes(pool: Pool, storage: StorageService, wechat: WechatService): Router {
  const router = Router();

  router.get('/modules/:moduleId/streak-rewards', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const access = await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const rules = await listRules(pool, moduleId, access.member_instance_id);
    ok(response, { rules: await Promise.all(rules.map(async (rule) => ({
      rule: serializeRule(rule),
      progressDays: rule.status === 'active'
        ? await rewardProgressDays(pool, moduleId, rule.target_type, rule.target_member_instance_id, Number(rule.streak_days))
        : 0,
      targetMemberName: rule.target_member_name,
    }))) });
  }));

  router.post('/modules/:moduleId/streak-rewards', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const body = parseBody(saveBody, request);
    await wechat.assertTextAllowed(user.openId, `${body.prizeTitle}\n${body.prizeDescription}`);
    const targetMemberId = body.targetType === 'member'
      ? dbId(body.targetMemberInstanceId, 'mi')
      : null;
    const coverMediaId = body.coverMediaId ? dbId(body.coverMediaId, 'media') : null;
    const result = await idempotent(pool, user.userId, 'streak_reward_save', body.clientRequestId, body, async (connection) => {
      const access = await requireMember(connection, moduleId, user.userId, { lock: true });
      if (access.module_record_policy !== 'strict') throw new AppError('REWARD_STRICT_ONLY', '仅打卡模式可设置奖励', 422);
      if (body.targetType === 'all' && access.active_member_count < 2) {
        throw new AppError('REWARD_ALL_NEEDS_GROUP', '全员奖励至少需要2位成员', 422);
      }
      if (targetMemberId) {
        const [targets] = await connection.execute<TargetRow[]>(
          `SELECT member_instance_id, nickname_snapshot FROM module_member
            WHERE module_id = ? AND member_instance_id = ? AND status = 'active' LIMIT 1`,
          [moduleId, targetMemberId],
        );
        if (!targets[0]) throw new AppError('REWARD_TARGET_INVALID', '奖励成员已不在模块中', 422);
      }
      if (coverMediaId) {
        const [covers] = await connection.execute<RowDataPacket[]>(
          `SELECT media_id FROM media_asset
            WHERE media_id = ? AND module_id = ? AND owner_user_id = ?
              AND purpose = 'record_photo' AND status = 'ready'
              AND sticker_thumbnail_file_key IS NOT NULL LIMIT 1`,
          [coverMediaId, moduleId, user.userId],
        );
        if (!covers[0]) throw new AppError('REWARD_COVER_INVALID', '奖励封面尚未处理完成', 422);
      }
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO streak_reward_rule
           (module_id, sponsor_user_id, sponsor_member_instance_id, target_type,
            target_member_instance_id, cover_media_id, prize_title, prize_description, win_probability_bps,
            streak_days, status, terms_version, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '2026-08', ?)`,
        [moduleId, user.userId, access.member_instance_id, body.targetType, targetMemberId, coverMediaId,
          body.prizeTitle, body.prizeDescription || null, body.winProbability * 100, body.streakDays, addDays(new Date(), 90)],
      );
      return { rewardRuleId: publicId('rr', insert.insertId), status: 'active' };
    });
    ok(response, result);
  }));

  router.delete('/modules/:moduleId/streak-rewards/:rewardRuleId', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const rewardRuleId = dbId(request.params.rewardRuleId, 'rr');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, `streak_reward_cancel_${rewardRuleId}`, body.clientRequestId, body, async (connection) => {
      const access = await requireMember(connection, moduleId, user.userId, { lock: true });
      await connection.execute(
        `UPDATE streak_reward_rule
            SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE reward_rule_id = ? AND module_id = ? AND sponsor_member_instance_id = ? AND status = 'active'`,
        [rewardRuleId, moduleId, access.member_instance_id],
      );
      return { status: 'cancelled' };
    });
    ok(response, result);
  }));

  router.get('/modules/:moduleId/streak-rewards/pending', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    await requireMember(pool, moduleId, user.userId);
    const [rows] = await pool.execute<DrawRow[]>(
      `SELECT d.*, e.sponsor_name_snapshot, e.target_type, e.prize_title_snapshot,
              e.prize_description_snapshot, e.window_start, e.window_end,
              rr.sponsor_user_id, rr.streak_days, mm.nickname_snapshot AS recipient_name,
              ma.sticker_thumbnail_file_key AS sticker_file_key,
              cm.sticker_thumbnail_file_key AS cover_sticker_file_key,
              sr.record_date AS sticker_record_date, sr.remark AS sticker_remark,
              sr.display_name_snapshot AS sticker_member_name
         FROM streak_reward_draw d
         JOIN streak_reward_event e ON e.reward_event_id = d.reward_event_id
         JOIN streak_reward_rule rr ON rr.reward_rule_id = e.reward_rule_id
         JOIN module_member mm ON mm.member_instance_id = d.recipient_member_instance_id
         LEFT JOIN life_record sr ON sr.record_id = d.sticker_record_id
         LEFT JOIN media_asset ma ON ma.media_id = sr.media_id
         LEFT JOIN media_asset cm ON cm.media_id = e.cover_media_id_snapshot
        WHERE d.module_id = ? AND d.recipient_user_id = ? AND d.status = 'sealed'
        ORDER BY d.created_at, d.reward_draw_id LIMIT 20`,
      [moduleId, user.userId],
    );
    const draws = rows.map((draw) => ({
      rewardDrawId: publicId('rd', draw.reward_draw_id),
      moduleId: publicId('m', draw.module_id),
      sponsorName: draw.sponsor_name_snapshot,
      targetType: draw.target_type,
      streakDays: Number(draw.streak_days),
      windowStart: dateValue(draw.window_start),
      windowEnd: dateValue(draw.window_end),
    }));
    ok(response, { draw: draws[0] ?? null, draws, pendingCount: draws.length });
  }));

  router.post('/modules/:moduleId/streak-rewards/:rewardRuleId/preview', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    const rewardRuleId = dbId(request.params.rewardRuleId, 'rr');
    const body = parseBody(simpleWriteBody, request);
    const access = await requireMember(pool, moduleId, user.userId);
    if (access.module_record_policy !== 'strict') {
      throw new AppError('REWARD_STRICT_ONLY', '仅打卡模式可预览奖励', 422);
    }
    const rules = await listRules(pool, moduleId, access.member_instance_id);
    const rule = rules.find((item) => String(item.reward_rule_id) === rewardRuleId);
    if (!rule || rule.status !== 'active') {
      throw new AppError('REWARD_RULE_NOT_ACTIVE', '请先保存一份有效的奖励设置', 409);
    }

    const resultType = randomInt(10_000) < rule.win_probability_bps ? 'gift' : 'sticker';
    const windowEnd = shanghaiDate();
    const windowStart = shanghaiDate(addDays(new Date(), 1 - Number(rule.streak_days)));
    const rewardDrawId = `preview_${body.clientRequestId}`;

    const coverUrl = rule.cover_sticker_file_key
      ? await storage.signedUrl(String(rule.cover_sticker_file_key))
      : null;
    ok(response, {
      pending: {
        rewardDrawId,
        moduleId: publicId('m', moduleId),
        sponsorName: rule.sponsor_name_snapshot,
        targetType: rule.target_type,
        streakDays: Number(rule.streak_days),
        windowStart,
        windowEnd,
      },
      revealed: {
        rewardDrawId,
        moduleId: publicId('m', moduleId),
        sponsorName: rule.sponsor_name_snapshot,
        targetType: rule.target_type,
        streakDays: Number(rule.streak_days),
        windowStart,
        windowEnd,
        resultType,
        prizeTitle: resultType === 'gift' ? rule.prize_title : `${rule.streak_days}日纪念贴`,
        prizeDescription: resultType === 'gift' ? (rule.prize_description ?? '') : `把这${rule.streak_days}天收进口袋`,
        stickerUrl: null,
        coverUrl: resultType === 'gift' ? coverUrl : null,
      },
    });
  }));

  router.get('/modules/:moduleId/streak-rewards/received', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const moduleId = dbId(request.params.moduleId, 'm');
    await requireMember(pool, moduleId, user.userId, { allowPendingDelete: true });
    const [rows] = await pool.execute<DrawRow[]>(
      `SELECT d.*, e.sponsor_name_snapshot, e.target_type, e.prize_title_snapshot,
              e.prize_description_snapshot, e.window_start, e.window_end,
              rr.sponsor_user_id, rr.streak_days, mm.nickname_snapshot AS recipient_name,
              ma.sticker_thumbnail_file_key AS sticker_file_key,
              cm.sticker_thumbnail_file_key AS cover_sticker_file_key,
              sr.record_date AS sticker_record_date, sr.remark AS sticker_remark,
              sr.display_name_snapshot AS sticker_member_name
         FROM streak_reward_draw d
         JOIN streak_reward_event e ON e.reward_event_id = d.reward_event_id
         JOIN streak_reward_rule rr ON rr.reward_rule_id = e.reward_rule_id
         JOIN module_member mm ON mm.member_instance_id = d.recipient_member_instance_id
         LEFT JOIN life_record sr ON sr.record_id = d.sticker_record_id
         LEFT JOIN media_asset ma ON ma.media_id = sr.media_id
         LEFT JOIN media_asset cm ON cm.media_id = e.cover_media_id_snapshot
        WHERE d.module_id = ? AND d.recipient_user_id = ? AND d.status = 'revealed'
        ORDER BY d.revealed_at DESC, d.reward_draw_id DESC LIMIT 100`,
      [moduleId, user.userId],
    );
    const items = await Promise.all(rows.map(async (draw) => ({
      rewardDrawId: publicId('rd', draw.reward_draw_id),
      moduleId: publicId('m', draw.module_id),
      sponsorName: draw.sponsor_name_snapshot,
      targetType: draw.target_type,
      streakDays: Number(draw.streak_days),
      windowStart: dateValue(draw.window_start),
      windowEnd: dateValue(draw.window_end),
      resultType: draw.result_type,
      prizeTitle: draw.result_type === 'gift' ? draw.prize_title_snapshot : `${draw.streak_days}日纪念贴`,
      prizeDescription: draw.result_type === 'gift' ? (draw.prize_description_snapshot ?? '') : `把这${draw.streak_days}天收进口袋`,
      stickerUrl: draw.result_type === 'sticker' && draw.sticker_file_key
        ? await storage.signedUrl(String(draw.sticker_file_key)) : null,
      coverUrl: draw.result_type === 'gift' && draw.cover_sticker_file_key
        ? await storage.signedUrl(String(draw.cover_sticker_file_key)) : null,
      stickerRecordDate: draw.sticker_record_date ? dateValue(draw.sticker_record_date) : null,
      stickerRemark: draw.sticker_remark ?? '',
      stickerMemberName: draw.sticker_member_name ?? '',
      revealedAt: draw.revealed_at ? isoWithShanghaiOffset(draw.revealed_at) : null,
    })));
    ok(response, {
      items,
      counts: {
        all: items.length,
        gift: items.filter((item) => item.resultType === 'gift').length,
        sticker: items.filter((item) => item.resultType === 'sticker').length,
      },
    });
  }));

  router.post('/streak-reward-draws/:drawId/reveal', asyncRoute(async (request, response) => {
    const user = authUser(request);
    const drawId = dbId(request.params.drawId, 'rd');
    const body = parseBody(simpleWriteBody, request);
    const result = await idempotent(pool, user.userId, 'streak_reward_reveal', body.clientRequestId, body, async (connection) => {
      const [rows] = await connection.execute<DrawRow[]>(
        `SELECT d.*, e.sponsor_name_snapshot, e.target_type, e.prize_title_snapshot,
                e.prize_description_snapshot, e.window_start, e.window_end,
                rr.sponsor_user_id, rr.streak_days, mm.nickname_snapshot AS recipient_name,
                ma.sticker_thumbnail_file_key AS sticker_file_key,
                cm.sticker_thumbnail_file_key AS cover_sticker_file_key,
                sr.record_date AS sticker_record_date, sr.remark AS sticker_remark,
                sr.display_name_snapshot AS sticker_member_name
           FROM streak_reward_draw d
           JOIN streak_reward_event e ON e.reward_event_id = d.reward_event_id
           JOIN streak_reward_rule rr ON rr.reward_rule_id = e.reward_rule_id
           JOIN module_member mm ON mm.member_instance_id = d.recipient_member_instance_id
           LEFT JOIN life_record sr ON sr.record_id = d.sticker_record_id
           LEFT JOIN media_asset ma ON ma.media_id = sr.media_id
           LEFT JOIN media_asset cm ON cm.media_id = e.cover_media_id_snapshot
          WHERE d.reward_draw_id = ? AND d.recipient_user_id = ?
          FOR UPDATE`,
        [drawId, user.userId],
      );
      const draw = rows[0];
      if (!draw) throw new AppError('REWARD_DRAW_NOT_FOUND', '这份奖励不存在', 404);
      if (draw.status === 'sealed') {
        await connection.execute(
          `UPDATE streak_reward_draw SET status = 'revealed', revealed_at = CURRENT_TIMESTAMP(3)
            WHERE reward_draw_id = ? AND status = 'sealed'`,
          [drawId],
        );
        await connection.execute(
          `INSERT INTO notification
             (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status)
           VALUES (?, 'reward_result', ?, ?, ?, 'reward_draw', ?, 'none', 'none')`,
          [user.userId, draw.result_type === 'gift' ? '连续打卡惊喜' : `${draw.streak_days}日纪念贴`,
            draw.result_type === 'gift' ? `你获得了「${draw.prize_title_snapshot}」` : `你收下了一张${draw.streak_days}日纪念贴`,
            draw.module_id, drawId],
        );
        if (draw.result_type === 'gift' && String(draw.sponsor_user_id) !== String(user.userId)) {
          await connection.execute(
            `INSERT INTO notification
               (user_id, type, title, content, module_id, target_type, target_id, action_type, action_status)
             VALUES (?, 'reward_result', '礼物待兑现', ?, ?, 'reward_draw', ?, 'none', 'none')`,
            [draw.sponsor_user_id, `${draw.recipient_name}抽中了「${draw.prize_title_snapshot}」`, draw.module_id, drawId],
          );
        }
      }
      return {
        moduleId: publicId('m', draw.module_id),
        sponsorName: draw.sponsor_name_snapshot,
        targetType: draw.target_type,
        streakDays: Number(draw.streak_days),
        windowStart: dateValue(draw.window_start),
        windowEnd: dateValue(draw.window_end),
        resultType: draw.result_type,
        prizeTitle: draw.result_type === 'gift' ? draw.prize_title_snapshot : `${draw.streak_days}日纪念贴`,
        prizeDescription: draw.result_type === 'gift' ? (draw.prize_description_snapshot ?? '') : `把这${draw.streak_days}天收进口袋`,
        stickerFileKey: draw.result_type === 'sticker' ? draw.sticker_file_key : null,
        coverFileKey: draw.result_type === 'gift' ? draw.cover_sticker_file_key : null,
        stickerRecordDate: draw.sticker_record_date ? dateValue(draw.sticker_record_date) : null,
        stickerRemark: draw.sticker_remark ?? '',
        stickerMemberName: draw.sticker_member_name ?? '',
      };
    });
    const { stickerFileKey, coverFileKey, ...payload } = result;
    ok(response, {
      ...payload,
      stickerUrl: stickerFileKey ? await storage.signedUrl(String(stickerFileKey)) : null,
      coverUrl: coverFileKey ? await storage.signedUrl(String(coverFileKey)) : null,
    });
  }));

  return router;
}
