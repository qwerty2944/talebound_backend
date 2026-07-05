import { Controller, Post, Body, Req, UseGuards, Inject, BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { BattleService } from "./battle.service.js";

@Controller("api/battle")
@UseGuards(JwtAuthGuard)
export class BattleController {
  constructor(@Inject(BattleService) private readonly battle: BattleService) {}

  @Post("start")
  async start(@Req() req: Request, @Body() body: { monsterId?: unknown }) {
    if (typeof body?.monsterId !== "string") {
      throw new BadRequestException({ error: "monsterId가 필요합니다" });
    }
    return this.battle.start(req.userId!, body.monsterId);
  }

  @Post("complete")
  async complete(
    @Req() req: Request,
    @Body() body: { battleToken?: unknown; result?: unknown; currentHp?: unknown; currentMp?: unknown }
  ) {
    const { battleToken, result } = body ?? {};
    if (typeof battleToken !== "string") {
      throw new BadRequestException({ error: "battleToken이 필요합니다" });
    }
    if (result !== "victory" && result !== "defeat" && result !== "fled") {
      throw new BadRequestException({ error: "result는 victory/defeat/fled 중 하나여야 합니다" });
    }
    return this.battle.complete(
      req.userId!,
      battleToken,
      result,
      Number(body.currentHp),
      Number(body.currentMp)
    );
  }
}
