import crypto from "crypto";
import { Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { env } from "../config/env.js";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import { getMonster, getItemType, type GameMonster } from "../game-data/game-data.js";

/**
 * 서버 권위 전투 보상.
 * - start: HMAC 서명 전투 토큰 발급 + 피로도 소모
 * - complete: 토큰 검증 후 exp/gold/드랍/카르마를 서버가 계산·지급
 * 전투 진행(턴/데미지)은 클라이언트 로직 유지 — 보상 지급만 서버가 통제한다.
 */

interface BattleTokenPayload {
  userId: string;
  monsterId: string;
  iat: number; // ms
  jti: string;
}

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30분
/** 최소 전투 시간: 몬스터 레벨×1초, 최소 3초 */
const minBattleMs = (level: number) => Math.max(3, level) * 1000;

export interface BattleCompleteResult {
  result: "victory" | "defeat" | "fled";
  exp: number;
  gold: number;
  drops: { itemId: string; quantity: number }[];
  karmaChange: number;
  levelUp: { leveledUp: boolean; newLevel: number; levelsGained: number };
  totalGold: number;
  totalExp: number;
}

@Injectable()
export class BattleService {
  /** 재사용 방지 (단일 인스턴스 기준) */
  private usedJti = new Map<string, number>();

  private sign(payload: BattleTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  private verify(token: string): BattleTokenPayload {
    const [body, sig] = token.split(".");
    if (!body || !sig) throw new BadRequestException({ error: "잘못된 전투 토큰" });
    const expected = crypto.createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new BadRequestException({ error: "전투 토큰 서명 불일치" });
    }
    return JSON.parse(Buffer.from(body, "base64url").toString()) as BattleTokenPayload;
  }

  private pruneJti(now: number): void {
    for (const [jti, iat] of this.usedJti) {
      if (now - iat > TOKEN_TTL_MS) this.usedJti.delete(jti);
    }
  }

  async start(userId: string, monsterId: string): Promise<{ battleToken: string; monster: { id: string; level: number } }> {
    const monster = getMonster(monsterId);
    if (!monster) throw new NotFoundException({ error: `알 수 없는 몬스터: ${monsterId}` });

    // 전투 시작 = 피로도 소모 (기존 DB 함수)
    const fatigue = (await callDbFunction(
      "consume_fatigue",
      { p_user_id: userId, p_amount: 3 },
      "scalar"
    )) as { success?: boolean; message?: string } | null;
    if (fatigue && fatigue.success === false) {
      throw new ConflictException({ error: fatigue.message ?? "피로도가 부족합니다", code: "NOT_ENOUGH_FATIGUE" });
    }

    const payload: BattleTokenPayload = {
      userId,
      monsterId,
      iat: Date.now(),
      jti: crypto.randomUUID(),
    };
    return { battleToken: this.sign(payload), monster: { id: monster.id, level: monster.level } };
  }

  async complete(
    userId: string,
    battleToken: string,
    result: "victory" | "defeat" | "fled",
    currentHp: number,
    currentMp: number
  ): Promise<BattleCompleteResult> {
    const payload = this.verify(battleToken);
    const now = Date.now();

    if (payload.userId !== userId) throw new BadRequestException({ error: "본인 전투가 아닙니다" });
    if (now - payload.iat > TOKEN_TTL_MS) throw new BadRequestException({ error: "전투 토큰 만료" });
    if (this.usedJti.has(payload.jti)) throw new ConflictException({ error: "이미 정산된 전투입니다" });

    const monster = getMonster(payload.monsterId);
    if (!monster) throw new NotFoundException({ error: "알 수 없는 몬스터" });

    if (result === "victory" && now - payload.iat < minBattleMs(monster.level)) {
      throw new BadRequestException({ error: "전투 시간이 비정상적으로 짧습니다" });
    }

    this.pruneJti(now);
    this.usedJti.set(payload.jti, payload.iat);

    const hp = Number.isFinite(currentHp) ? Math.max(0, Math.round(currentHp)) : 1;
    const mp = Number.isFinite(currentMp) ? Math.max(0, Math.round(currentMp)) : 0;

    if (result !== "victory") {
      // 패배/도주: HP/MP만 저장, 보상 없음
      await pool.query(
        `update characters set current_hp = $2, current_mp = $3 where user_id = $1`,
        [userId, result === "defeat" ? 1 : hp, mp]
      );
      return {
        result, exp: 0, gold: 0, drops: [], karmaChange: 0,
        levelUp: { leveledUp: false, newLevel: 0, levelsGained: 0 },
        totalGold: 0, totalExp: 0,
      };
    }

    // ---- 승리 정산 ----
    const { rows } = await pool.query(
      `select level, experience, gold from characters where user_id = $1`,
      [userId]
    );
    const char = rows[0];
    if (!char) throw new NotFoundException({ error: "캐릭터가 없습니다" });

    const playerLevel = Number(char.level) || 1;
    const exp = this.calculateExpBonus(monster, playerLevel);
    const gold = monster.rewards.gold ?? 0;

    // 레벨업 (필요 exp = level × 100)
    let newLevel = playerLevel;
    let newExp = Number(char.experience || 0) + exp;
    let levelsGained = 0;
    while (newExp >= newLevel * 100) {
      newExp -= newLevel * 100;
      newLevel++;
      levelsGained++;
    }

    const totalGold = Number(char.gold || 0) + gold;

    await pool.query(
      `update characters
       set level = $2, experience = $3, gold = $4, current_hp = $5, current_mp = $6
       where user_id = $1`,
      [userId, newLevel, newExp, totalGold, Math.max(1, hp), mp]
    );

    // 드랍 롤 (서버) + 인벤토리 지급
    const drops = this.rollDrops(monster);
    for (const drop of drops) {
      try {
        await callDbFunction(
          "inventory_add_item",
          {
            p_user_id: userId,
            p_inventory_type: "personal",
            p_item_id: drop.itemId,
            p_item_type: drop.itemType,
            p_quantity: drop.quantity,
          },
          "scalar"
        );
      } catch (e) {
        console.error(`[battle] 드랍 지급 실패 (${drop.itemId}):`, e instanceof Error ? e.message : e);
      }
    }

    // 카르마 (몬스터 성향 기반)
    const karmaChange = this.calculateKarmaChange(monster);
    if (karmaChange !== 0) {
      try {
        await callDbFunction(
          "update_karma",
          { p_user_id: userId, p_change: karmaChange, p_reason: `${monster.nameKo} 처치` },
          "set"
        );
      } catch (e) {
        console.error("[battle] 카르마 갱신 실패:", e instanceof Error ? e.message : e);
      }
    }

    return {
      result,
      exp,
      gold,
      drops: drops.map(({ itemId, quantity }) => ({ itemId, quantity })),
      karmaChange,
      levelUp: { leveledUp: levelsGained > 0, newLevel, levelsGained },
      totalGold,
      totalExp: newExp,
    };
  }

  /** 프론트 calculateExpBonus와 동일 공식 (레벨차 보정) */
  private calculateExpBonus(monster: GameMonster, playerLevel: number): number {
    const levelDiff = monster.level - playerLevel;
    if (levelDiff > 0) return Math.round(monster.rewards.exp * (1 + levelDiff * 0.1));
    if (levelDiff < -5) return Math.round(monster.rewards.exp * 0.5);
    return monster.rewards.exp;
  }

  /** 프론트 rollDrops와 동일 공식 */
  private rollDrops(monster: GameMonster): { itemId: string; itemType: string; quantity: number }[] {
    const out: { itemId: string; itemType: string; quantity: number }[] = [];
    for (const drop of monster.drops ?? []) {
      if (Math.random() >= (drop.chance ?? 0)) continue;
      const [min, max] = drop.quantity ?? [1, 1];
      const quantity = min + Math.floor(Math.random() * (max - min + 1));
      out.push({ itemId: drop.itemId, itemType: getItemType(drop.itemId), quantity });
    }
    return out;
  }

  /** 프론트 calculateKarmaChange와 동일 공식 (good -10 / neutral 0 / evil +5, 레벨 보정 1+(lv-1)*0.1) */
  private calculateKarmaChange(monster: GameMonster): number {
    const base = monster.alignment === "good" ? -10 : monster.alignment === "evil" ? 5 : 0;
    if (base === 0) return 0;
    return Math.round(base * (1 + (monster.level - 1) * 0.1));
  }
}
