import { Module } from "@nestjs/common";
import { NpcController } from "./npc.controller.js";
import { AuthModule } from "../auth/auth.module.js";

@Module({
  imports: [AuthModule],
  controllers: [NpcController],
})
export class NpcModule {}
