import { Module } from "@nestjs/common";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";
import { AuthModule } from "../auth/auth.module.js";

@Module({
  imports: [AuthModule],
  controllers: [ShopController],
  providers: [ShopService],
  exports: [ShopService],
})
export class ShopModule {}
