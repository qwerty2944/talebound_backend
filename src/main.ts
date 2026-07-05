import "reflect-metadata";
import fs from "fs";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { AppModule } from "./app.module.js";
import { env } from "./config/env.js";
import { ensureSchema } from "./database/pool.js";
import { loadGameData } from "./game-data/game-data.js";
import { MapRoom } from "./game/rooms/map.room.js";

async function bootstrap() {
  loadGameData();
  await ensureSchema();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: env.CORS_ORIGIN },
  });
  app.useBodyParser("json", { limit: "1mb" });
  app.use("/colyseus", monitor());

  // Colyseus는 Nest의 http 서버에 WebSocket으로 얹힌다
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: app.getHttpServer() }),
  });
  // 같은 mapId끼리 같은 룸에 배정
  gameServer.define("map", MapRoom).filterBy(["mapId"]);

  // Colyseus Cloud는 인스턴스별 Unix 소켓(/run/colyseus/{port}.sock)으로 프록시한다
  const isCloud = process.env.COLYSEUS_CLOUD !== undefined;
  const instance = Number(process.env.NODE_APP_INSTANCE || "0");
  if (isCloud) {
    const socketPath = `/run/colyseus/${2567 + instance}.sock`;
    try { fs.unlinkSync(socketPath); } catch { /* 없으면 무시 */ }
    await app.listen(socketPath);
    console.log(`🎮 TALEBOUND 서버 실행 중: ${socketPath}`);
  } else {
    await app.listen(env.PORT + instance);
    console.log(`🎮 TALEBOUND 서버 실행 중: http://localhost:${env.PORT + instance}`);
  }
  if (typeof process.send === "function") process.send("ready");
  console.log(`   - REST API: /api/*`);
  console.log(`   - Colyseus 모니터: /colyseus`);
}

bootstrap().catch((e) => {
  console.error("서버 시작 실패:", e);
  process.exit(1);
});
