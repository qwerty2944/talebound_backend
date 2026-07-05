import crypto from "crypto";
import { Injectable, Inject, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { env } from "../config/env.js";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import { consumeJti } from "../database/jti.js";
import { grantExpGold } from "../database/rewards.js";
import { getDungeon, getItemType } from "../game-data/game-data.js";
import { BattleService } from "../battle/battle.service.js";

/**
 * 서버 상태/테이블 없는 던전 런.
 * HMAC runToken 체인 {userId, dungeonId, wave, runJti, iat}로 웨이브 진행을 통제한다.
 * - start: 레벨 검증 + 피로도 1회 소모 + wave0 battleToken/runToken 발급
 * - advance: runToken 검증 → battle.service.complete로 웨이브 정산 → 다음 웨이브 토큰 or 클리어 보상
 * 서버가 다음 battleToken을 발급하므로 웨이브 스킵이 불가능하다.
 */

interface RunTokenPayload {
  userId: string;
  dungeonId: string;
  wave: number; // 다음에 진행할(방금 발급된 battleToken이 가리키는) 웨이브 인덱스
  runJti: string; // 런 식별자 (클리어 보상 중복 방지)
  iat: number;
}

const RUN_TTL_MS = 60 * 60 * 1000; // 1시간

@Injectable()
export class DungeonService {
  constructor(@Inject(BattleService) private readonly battle: BattleService) {}

  /** 클리어 보상 중복 방지 (단일 인스턴스 기준, 소모된 runJti) */
  private clearedRunJti = new Map<string, number>();

  private sign(payload: RunTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  private verify(token: string): RunTokenPayload {
    const [body, sig] = token.split(".");
    if (!body || !sig) throw new BadRequestException({ error: "잘못된 던전 토큰" });
    const expected = crypto.createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new BadRequestException({ error: "던전 토큰 서명 불일치" });
    }
    return JSON.parse(Buffer.from(body, "base64url").toString()) as RunTokenPayload;
  }

  private pruneRunJti(now: number): void {
    for (const [jti, iat] of this.clearedRunJti) {
      if (now - iat > RUN_TTL_MS) this.clearedRunJti.delete(jti);
    }
  }

  async start(userId: string, dungeonId: string): Promise<{
    dungeonId: string;
    wave: number;
    totalWaves: number;
    monster: { id: string; level: number };
    battleToken: string;
    runToken: string;
  }> {
    const dungeon = getDungeon(dungeonId);
    if (!dungeon) throw new NotFoundException({ error: `알 수 없는 던전: ${dungeonId}` });

    const { rows } = await pool.query<{ level: number }>(
      `select level from characters where user_id = $1`,
      [userId]
    );
    const level = Number(rows[0]?.level) || 1;
    if (level < dungeon.minLevel) {
      throw new BadRequestException({
        error: `레벨이 부족합니다 (필요 Lv.${dungeon.minLevel})`,
        code: "LEVEL_TOO_LOW",
      });
    }

    // 던전 입장 = 피로도 1회 소모
    const fatigue = (await callDbFunction(
      "consume_fatigue",
      { p_user_id: userId, p_amount: dungeon.fatigueCost },
      "scalar"
    )) as { success?: boolean; message?: string } | null;
    if (fatigue && fatigue.success === false) {
      throw new ConflictException({ error: fatigue.message ?? "피로도가 부족합니다", code: "NOT_ENOUGH_FATIGUE" });
    }

    const firstMonsterId = dungeon.waves[0];
    // 웨이브 battleToken은 battle.service가 발급 (피로도는 위에서 이미 소모 → skipFatigue)
    const { battleToken, monster } = await this.battle.start(userId, firstMonsterId, { skipFatigue: true });

    const runToken = this.sign({
      userId,
      dungeonId,
      wave: 0,
      runJti: crypto.randomUUID(),
      iat: Date.now(),
    });

    return {
      dungeonId,
      wave: 0,
      totalWaves: dungeon.waves.length,
      monster,
      battleToken,
      runToken,
    };
  }

  async advance(
    userId: string,
    runToken: string,
    battleToken: string,
    currentHp: number,
    currentMp: number
  ): Promise<
    | {
        cleared: false;
        wave: number;
        totalWaves: number;
        monster: { id: string; level: number };
        battleToken: string;
        runToken: string;
        waveReward: { exp: number; gold: number; drops: { itemId: string; quantity: number }[] };
      }
    | {
        cleared: true;
        totalWaves: number;
        waveReward: { exp: number; gold: number; drops: { itemId: string; quantity: number }[] };
        clearReward: { exp: number; gold: number; items: { itemId: string; quantity: number }[] };
        levelUp: { leveledUp: boolean; newLevel: number; levelsGained: number };
      }
  > {
    const payload = this.verify(runToken);
    const now = Date.now();
    if (payload.userId !== userId) throw new BadRequestException({ error: "본인 던전이 아닙니다" });
    if (now - payload.iat > RUN_TTL_MS) throw new BadRequestException({ error: "던전 토큰이 만료되었습니다" });

    const dungeon = getDungeon(payload.dungeonId);
    if (!dungeon) throw new NotFoundException({ error: "알 수 없는 던전" });

    if (payload.wave < 0 || payload.wave >= dungeon.waves.length) {
      throw new BadRequestException({ error: "잘못된 웨이브" });
    }

    // 현재 웨이브 전투를 정산 (개별 exp/gold/드랍 정상 지급, battleToken jti 소모)
    const settled = await this.battle.complete(userId, battleToken, "victory", currentHp, currentMp);
    const waveReward = { exp: settled.exp, gold: settled.gold, drops: settled.drops };

    const nextWave = payload.wave + 1;

    if (nextWave < dungeon.waves.length) {
      // 다음 웨이브 토큰 발급 (HP 유지 = 회복 없음, 피로도 미소모)
      const nextMonsterId = dungeon.waves[nextWave];
      const { battleToken: nextBattleToken, monster } = await this.battle.start(userId, nextMonsterId, {
        skipFatigue: true,
      });
      const nextRunToken = this.sign({
        userId,
        dungeonId: payload.dungeonId,
        wave: nextWave,
        runJti: payload.runJti, // 같은 런 유지
        iat: payload.iat,
      });
      return {
        cleared: false,
        wave: nextWave,
        totalWaves: dungeon.waves.length,
        monster,
        battleToken: nextBattleToken,
        runToken: nextRunToken,
        waveReward,
      };
    }

    // ---- 던전 클리어 ----
    if (this.clearedRunJti.has(payload.runJti)) {
      throw new ConflictException({ error: "이미 클리어 보상을 받은 던전입니다", code: "ALREADY_CLEARED" });
    }
    // 정산 멱등성: DB 유니크 소비 판정(다중 인스턴스/재시작 대응). Map은 1차 캐시.
    const fresh = await consumeJti(payload.runJti, RUN_TTL_MS);
    if (!fresh) {
      this.clearedRunJti.set(payload.runJti, now);
      throw new ConflictException({ error: "이미 클리어 보상을 받은 던전입니다", code: "ALREADY_CLEARED" });
    }
    this.pruneRunJti(now);
    this.clearedRunJti.set(payload.runJti, now);

    const bonusExp = dungeon.clearRewards.exp ?? 0;
    const bonusGold = dungeon.clearRewards.gold ?? 0;

    // 보상은 상대 증분으로 지급 → 동시 정산 lost-update 방지.
    const { newLevel, newExp, levelsGained, totalGold } = await grantExpGold(userId, bonusExp, bonusGold);

    const items = dungeon.clearRewards.items ?? [];
    for (const item of items) {
      try {
        await callDbFunction(
          "inventory_add_item",
          {
            p_user_id: userId,
            p_inventory_type: "personal",
            p_item_id: item.itemId,
            p_item_type: getItemType(item.itemId),
            p_quantity: item.quantity,
          },
          "scalar"
        );
      } catch (e) {
        console.error(`[dungeon] 클리어 보상 지급 실패 (${item.itemId}):`, e instanceof Error ? e.message : e);
      }
    }

    return {
      cleared: true,
      totalWaves: dungeon.waves.length,
      waveReward,
      clearReward: { exp: bonusExp, gold: bonusGold, items },
      levelUp: { leveledUp: levelsGained > 0, newLevel, levelsGained },
    };
  }
}
