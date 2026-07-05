import { Controller, Post, Body, Req, UseGuards, Inject, BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { TrainingService } from "./training.service.js";

@Controller("api/training")
@UseGuards(JwtAuthGuard)
export class TrainingController {
  constructor(@Inject(TrainingService) private readonly training: TrainingService) {}

  @Post("train")
  async train(@Req() req: Request, @Body() body: { proficiencyType?: unknown }) {
    if (typeof body?.proficiencyType !== "string") {
      throw new BadRequestException({ error: "proficiencyType이 필요합니다" });
    }
    return this.training.train(req.userId!, body.proficiencyType);
  }
}
