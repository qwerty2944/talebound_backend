import { Controller, Post, Body, Req, UseGuards, BadRequestException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import { getHealerPrice } from "../game-data/game-data.js";

/** 이 레벨 이하 캐릭터는 치료비 무료 (초보자 배려). 서버 권위로 판정한다. */
const FREE_HEAL_MAX_LEVEL = 5;

/**
 * NPC 상호작용. 치료비는 서버가 healers.json 가격표로 계산한다 (클라이언트 금액 신뢰 안 함).
 */
@Controller("api/npc")
@UseGuards(JwtAuthGuard)
export class NpcController {
  @Post("heal")
  async heal(@Req() req: Request, @Body() body: { npcId?: unknown; injuryIndex?: unknown }) {
    const { npcId, injuryIndex } = body ?? {};
    if (typeof npcId !== "string" || typeof injuryIndex !== "number" || injuryIndex < 0) {
      throw new BadRequestException({ error: "npcId와 injuryIndex가 필요합니다" });
    }

    // 부상 등급과 캐릭터 레벨은 DB에서 읽는다 (클라 전달값 불신)
    const { rows } = await pool.query(
      // $2::int 캐스트 필수 — 없으면 jsonb -> text(키 조회)로 바인딩돼 배열 인덱스 조회 실패
      `select injuries -> $2::int as injury, level from characters where user_id = $1`,
      [req.userId, injuryIndex]
    );
    const injury = rows[0]?.injury as { type?: string } | null;
    if (!injury?.type) {
      throw new NotFoundException({ error: "해당 부상이 없습니다" });
    }

    const basePrice = getHealerPrice(npcId, injury.type);
    if (basePrice === undefined) {
      throw new NotFoundException({ error: "치료 서비스를 제공하지 않는 NPC입니다" });
    }

    // 레벨 5 이하 무료 (서버 권위). DB level이 없으면 1로 간주.
    const level = typeof rows[0]?.level === "number" ? (rows[0].level as number) : 1;
    const goldCost = level <= FREE_HEAL_MAX_LEVEL ? 0 : basePrice;

    const data = await callDbFunction(
      "heal_injury_with_gold",
      { p_user_id: req.userId, p_injury_index: injuryIndex, p_gold_cost: goldCost },
      "scalar"
    );
    return { data };
  }
}
