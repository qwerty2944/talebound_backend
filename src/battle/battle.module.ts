import { Module } from "@nestjs/common";
import { BattleController } from "./battle.controller.js";
import { BattleService } from "./battle.service.js";
import { AuthModule } from "../auth/auth.module.js";

@Module({
  imports: [AuthModule],
  controllers: [BattleController],
  providers: [BattleService],
})
export class BattleModule {}
