import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import type { Request } from "express";
import { pool } from "../database/pool.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";

/**
 * 프론트가 supabase.from(...)으로 직접 조회/수정하던 테이블 접근을 대체하는 REST 라우트.
 * 응답은 기존 DB row 그대로(snake_case) 반환해 프론트 매핑 코드를 유지한다.
 */

// 업데이트 허용 컬럼 (본인 row 한정)
// level/experience/gold/gems는 서버 권위(battle/complete, npc/heal 등)로만 변경 가능.
// injuries도 서버 권위: 추가=add_injury RPC(패배), 치료=npc/heal RPC(골드 sink),
// 자연 치유=getProfile 시 서버가 naturalHealAt 기준으로 prune. 클라 PATCH 우회 차단.
const PROFILE_COLUMNS = new Set([
  "fatigue", "fatigue_updated_at",
  "current_hp", "current_mp", "current_map_id",
  "traits", "religion", "buffs",
  "character", "appearance", "equipment", "nickname",
  "whisper_charges", "crystal_tier",
]);

const JSONB_COLUMNS = new Set(["traits", "religion", "buffs", "character", "appearance", "equipment"]);

const PROFICIENCY_KEYS = new Set([
  "light_sword", "medium_sword", "great_sword", "axe", "mace", "dagger",
  "spear", "bow", "crossbow", "staff", "fist", "shield",
  "fire", "ice", "lightning", "earth", "holy", "dark", "poison", "arcane",
]);

@Controller("api")
@UseGuards(JwtAuthGuard)
export class TablesController {
  // ============ characters (프로필) ============

  @Get("profile")
  async getProfile(@Req() req: Request) {
    // 자연 치유: naturalHealAt이 지난 부상을 서버 권위로 제거 (클라 PATCH 우회 차단).
    // 치명상(naturalHealAt 없음)은 유지 → npc/heal 골드 sink로만 치료 가능.
    // WHERE 가드로 제거 대상이 있을 때만 UPDATE.
    await pool.query(
      `update characters
         set injuries = coalesce((
           select jsonb_agg(inj)
           from jsonb_array_elements(injuries) inj
           where inj->>'naturalHealAt' is null
              or (inj->>'naturalHealAt')::timestamptz > now()
         ), '[]'::jsonb)
       where user_id = $1
         and jsonb_typeof(injuries) = 'array'
         and exists (
           select 1 from jsonb_array_elements(injuries) inj
           where inj->>'naturalHealAt' is not null
             and (inj->>'naturalHealAt')::timestamptz <= now()
         )`,
      [req.userId]
    );

    const { rows } = await pool.query(`select * from characters where user_id = $1`, [req.userId]);
    if (!rows[0]) {
      throw new NotFoundException({ error: "프로필이 없습니다" });
    }
    return { data: rows[0] };
  }

  @Patch("profile")
  async patchProfile(@Req() req: Request, @Body() updates: Record<string, unknown>) {
    const keys = Object.keys(updates ?? {}).filter((k) => PROFILE_COLUMNS.has(k));
    if (keys.length === 0) {
      throw new BadRequestException({ error: "업데이트할 컬럼이 없습니다" });
    }

    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) =>
      JSONB_COLUMNS.has(k) && updates[k] !== null ? JSON.stringify(updates[k]) : updates[k]
    );

    await pool.query(`update characters set ${sets} where user_id = $1`, [req.userId, ...values]);
    return { data: null };
  }

  // ============ game_settings ============

  @Get("game-settings")
  async gameSettings() {
    const { rows } = await pool.query(`select * from game_settings limit 1`);
    return { data: rows[0] ?? null };
  }

  // ============ character_statistics ============

  @Get("statistics/:characterId")
  async statistics(@Param("characterId") characterId: string) {
    const { rows } = await pool.query(
      `select * from character_statistics where character_id = $1`,
      [characterId]
    );
    return { data: rows[0] ?? null };
  }

  // ============ abilities ============

  @Get("abilities/:userId")
  async abilities(@Param("userId") userId: string, @Req() req: Request) {
    // 본인 데이터만
    if (userId !== req.userId) {
      throw new ForbiddenException({ error: "본인 데이터만 조회할 수 있습니다" });
    }
    const { rows } = await pool.query(
      `select combat, magic, life from abilities where user_id = $1`,
      [req.userId]
    );
    return { data: rows[0] ?? null };
  }

  // ============ proficiencies (숙련도, 0-100) ============

  @Get("proficiencies")
  async proficiencies(@Req() req: Request) {
    const { rows } = await pool.query(
      `select values from proficiencies where user_id = $1`,
      [req.userId]
    );
    return { data: rows[0]?.values ?? {} };
  }

  @Post("proficiencies/gain")
  async gainProficiency(@Req() req: Request, @Body() body: { type?: unknown; amount?: unknown }) {
    const { type, amount } = body ?? {};
    if (typeof type !== "string" || !PROFICIENCY_KEYS.has(type) || typeof amount !== "number" || amount <= 0 || amount > 10) {
      throw new BadRequestException({ error: "잘못된 숙련도 증가 요청입니다" });
    }

    const { rows } = await pool.query(
      `insert into proficiencies (user_id, values)
       values ($1, jsonb_build_object($2::text, least(100, $3::numeric)))
       on conflict (user_id) do update set
         values = proficiencies.values || jsonb_build_object(
           $2::text,
           least(100, coalesce((proficiencies.values->>$2)::numeric, 0) + $3::numeric)
         ),
         updated_at = now()
       returning (values->>$2)::numeric as new_value`,
      [req.userId, type, amount]
    );

    return { data: { type, value: Number(rows[0]?.new_value ?? 0) } };
  }

  // ============ equipment_instances ============

  @Get("equipment-instances")
  async equipmentInstances(@Query("characterId") characterId?: string) {
    if (typeof characterId !== "string" || !characterId) {
      throw new BadRequestException({ error: "characterId가 필요합니다" });
    }
    const { rows } = await pool.query(
      `select * from equipment_instances where character_id = $1 order by created_at desc`,
      [characterId]
    );
    return { data: rows };
  }

  @Get("equipment-instances/:id")
  async equipmentInstance(@Param("id") id: string) {
    const { rows } = await pool.query(`select * from equipment_instances where id = $1`, [id]);
    if (!rows[0]) {
      throw new NotFoundException({ error: "장비 인스턴스가 없습니다" });
    }
    return { data: rows[0] };
  }

  @Delete("equipment-instances/:id")
  async deleteEquipmentInstance(@Param("id") id: string) {
    await pool.query(`delete from equipment_instances where id = $1`, [id]);
    return { data: null };
  }
}
