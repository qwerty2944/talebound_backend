import { Controller, Post, Body, Req, UseGuards, Inject, BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ShopService } from "./shop.service.js";

@Controller("api/shop")
@UseGuards(JwtAuthGuard)
export class ShopController {
  constructor(@Inject(ShopService) private readonly shop: ShopService) {}

  @Post("buy")
  async buy(
    @Req() req: Request,
    @Body() body: { npcId?: unknown; itemId?: unknown; quantity?: unknown }
  ) {
    const { npcId, itemId, quantity } = body ?? {};
    if (typeof npcId !== "string" || typeof itemId !== "string") {
      throw new BadRequestException({ error: "npcId와 itemId가 필요합니다" });
    }
    const qty = quantity === undefined ? 1 : quantity;
    if (typeof qty !== "number") {
      throw new BadRequestException({ error: "quantity는 숫자여야 합니다" });
    }
    return this.shop.buy(req.userId!, npcId, itemId, qty);
  }

  @Post("sell")
  async sell(@Req() req: Request, @Body() body: { itemId?: unknown; quantity?: unknown }) {
    const { itemId, quantity } = body ?? {};
    if (typeof itemId !== "string") {
      throw new BadRequestException({ error: "itemId가 필요합니다" });
    }
    const qty = quantity === undefined ? 1 : quantity;
    if (typeof qty !== "number") {
      throw new BadRequestException({ error: "quantity는 숫자여야 합니다" });
    }
    return this.shop.sell(req.userId!, itemId, qty);
  }
}
