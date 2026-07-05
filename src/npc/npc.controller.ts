import { Controller, Post, Body, Req, UseGuards, BadRequestException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import { getHealerPrice } from "../game-data/game-data.js";

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

    // 부상 등급은 DB에서 읽는다
    const { rows } = await pool.query(
      `select injuries -> $2 as injury from characters where user_id = $1`,
      [req.userId, injuryIndex]
    );
    const injury = rows[0]?.injury as { type?: string } | null;
    if (!injury?.type) {
      throw new NotFoundException({ error: "해당 부상이 없습니다" });
    }

    const goldCost = getHealerPrice(npcId, injury.type);
    if (goldCost === undefined) {
      throw new NotFoundException({ error: "치료 서비스를 제공하지 않는 NPC입니다" });
    }

    const data = await callDbFunction(
      "heal_injury_with_gold",
      { p_user_id: req.userId, p_injury_index: injuryIndex, p_gold_cost: goldCost },
      "scalar"
    );
    return { data };
  }
}
