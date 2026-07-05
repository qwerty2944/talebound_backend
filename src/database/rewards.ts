import { NotFoundException } from "@nestjs/common";
import { pool } from "./pool.js";
import { applyLevelUps } from "../game-data/leveling.js";

export interface GrantRewardResult {
  newLevel: number;
  newExp: number;
  levelsGained: number;
  totalGold: number;
}

/**
 * 보상(gold/exp)을 lost-update 없이 지급한다.
 *
 * 기존 패턴(SELECT gold → JS 합산 → 절대값 UPDATE)은 동시 보상 정산 시 한쪽이
 * 유실됐다. 여기서는 `gold = gold + $delta`, `experience = experience + $delta`로
 * 원자적 상대 증분을 하고, 증분 결과(RETURNING)를 기준으로 레벨업을 정규화한다.
 *
 * experience 컬럼은 "현재 레벨 내 누적치"(레벨업 시 threshold 차감) 방식이라
 * 증분 직후 값이 threshold를 넘을 수 있다. RETURNING된 level/exp로 applyLevelUps를
 * 돌려 정규화 후 조건부(WHERE level/exp 일치)로만 기록해, 동시 정산이 끼어들면
 * 정규화를 건너뛴다(다음 정산에서 자가 치유). gold/experience 총량은 증분이라 유실 없음.
 */
export async function grantExpGold(
  userId: string,
  expDelta: number,
  goldDelta: number,
  extra: { currentHp?: number; currentMp?: number } = {}
): Promise<GrantRewardResult> {
  const sets = ["gold = gold + $2", "experience = experience + $3"];
  const values: unknown[] = [userId, Math.max(0, Math.round(goldDelta)), Math.max(0, Math.round(expDelta))];
  let idx = 4;
  if (extra.currentHp !== undefined) {
    sets.push(`current_hp = $${idx++}`);
    values.push(extra.currentHp);
  }
  if (extra.currentMp !== undefined) {
    sets.push(`current_mp = $${idx++}`);
    values.push(extra.currentMp);
  }

  const { rows } = await pool.query(
    `update characters set ${sets.join(", ")} where user_id = $1 returning level, experience, gold`,
    values
  );
  const row = rows[0];
  if (!row) throw new NotFoundException({ error: "캐릭터가 없습니다" });

  const returnedLevel = Number(row.level) || 1;
  const returnedExp = Number(row.experience) || 0;
  const totalGold = Number(row.gold) || 0;

  const { newLevel, newExp, levelsGained } = applyLevelUps(returnedLevel, returnedExp, 0);

  if (newLevel !== returnedLevel || newExp !== returnedExp) {
    // 정규화된 level/exp 기록. 그 사이 다른 정산이 experience를 또 올렸다면
    // 조건 불일치로 0행 → 정규화 스킵(총량은 이미 반영됨, 다음 정산에서 정규화).
    await pool.query(
      `update characters set level = $2, experience = $3
       where user_id = $1 and level = $4 and experience = $5`,
      [userId, newLevel, newExp, returnedLevel, returnedExp]
    );
  }

  return { newLevel, newExp, levelsGained, totalGold };
}
