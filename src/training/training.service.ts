import { Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { pool } from "../database/pool.js";

/**
 * 서버 권위 수련.
 * - 비용 = 50 + floor(현재숙련도^1.35) 골드 (숙련도 높을수록 비쌈)
 * - 1회 +2 숙련도(상한 100). 골드 차감과 숙련도 상승을 원자적으로 처리.
 */

// 무기 12종 + 마법 8속성 = 20종 (tables.controller의 PROFICIENCY_KEYS와 동일)
const PROFICIENCY_KEYS = new Set([
  "light_sword", "medium_sword", "great_sword", "axe", "mace", "dagger",
  "spear", "bow", "crossbow", "staff", "fist", "shield",
  "fire", "ice", "lightning", "earth", "holy", "dark", "poison", "arcane",
]);

const GAIN_PER_TRAIN = 2;
const MAX_PROFICIENCY = 100;

export interface TrainResult {
  gold: number;
  type: string;
  value: number;
  cost: number;
  nextCost: number;
}

function trainCost(value: number): number {
  return 50 + Math.floor(Math.pow(value, 1.35));
}

@Injectable()
export class TrainingService {
  async train(userId: string, proficiencyType: string): Promise<TrainResult> {
    if (!PROFICIENCY_KEYS.has(proficiencyType)) {
      throw new BadRequestException({ error: `알 수 없는 숙련 타입: ${proficiencyType}`, code: "INVALID_TYPE" });
    }

    // 현재 숙련도 조회
    const { rows: pr } = await pool.query<{ v: string | null }>(
      `select (values->>$2) as v from proficiencies where user_id = $1`,
      [userId, proficiencyType]
    );
    const current = Number(pr[0]?.v ?? 0);
    if (current >= MAX_PROFICIENCY) {
      throw new BadRequestException({ error: "이미 최대 숙련도입니다", code: "MAXED" });
    }

    const cost = trainCost(current);

    // 원자적 골드 차감 (음수 불가)
    const { rows: gr, rowCount } = await pool.query<{ gold: number }>(
      `update characters set gold = gold - $2
       where user_id = $1 and gold >= $2
       returning gold`,
      [userId, cost]
    );
    if (rowCount === 0) {
      const { rows: cr } = await pool.query(`select 1 from characters where user_id = $1`, [userId]);
      if (cr.length === 0) throw new NotFoundException({ error: "캐릭터가 없습니다" });
      throw new BadRequestException({ error: "골드가 부족합니다", code: "NOT_ENOUGH_GOLD" });
    }
    const gold = Number(gr[0].gold);

    // 숙련도 상승 (상한 100). 기존 gain 로직과 동일한 upsert.
    const { rows: ur } = await pool.query<{ new_value: string }>(
      `insert into proficiencies (user_id, values)
       values ($1, jsonb_build_object($2::text, least(${MAX_PROFICIENCY}, $3::numeric)))
       on conflict (user_id) do update set
         values = proficiencies.values || jsonb_build_object(
           $2::text,
           least(${MAX_PROFICIENCY}, coalesce((proficiencies.values->>$2)::numeric, 0) + $3::numeric)
         ),
         updated_at = now()
       returning (values->>$2)::numeric as new_value`,
      [userId, proficiencyType, GAIN_PER_TRAIN]
    );
    const value = Number(ur[0]?.new_value ?? current + GAIN_PER_TRAIN);
    const nextCost = value >= MAX_PROFICIENCY ? 0 : trainCost(value);

    return { gold, type: proficiencyType, value, cost, nextCost };
  }
}
