import "./polyfill.js"; // Symbol.metadata — @colyseus/* 임포트보다 반드시 먼저
import "reflect-metadata";
import fs from "fs";
import { execSync } from "child_process";
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

/**
 * PM2에 같은 이름의 프로세스가 중복 등록되면 하나뿐인 Unix 소켓을 서로 뺏으며
 * 재시작 루프에 빠진다. 가장 작은 pm_id만 살아남도록 자기/타자 정리를 수행한다.
 */
function dedupePm2Processes(): void {
  const myPmId = Number(process.env.pm_id);
  const myName = process.env.name;
  if (!Number.isFinite(myPmId) || !myName) return;
  try {
    const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8", timeout: 10_000 })) as Array<{
      pm_id: number;
      name: string;
    }>;
    const twins = list.filter((p) => p.name === myName).map((p) => p.pm_id).sort((a, b) => a - b);
    if (twins.length <= 1) return;
    // 플랫폼 배포는 새 프로세스 기동 → 구 프로세스 제거 순서이므로 "최신(pm_id 최대)"이 생존해야 한다
    const survivor = twins[twins.length - 1];
    if (myPmId !== survivor) {
      console.warn(`[pm2-dedupe] 중복 프로세스 감지 — 본인(pm_id=${myPmId}) 종료, 생존자 pm_id=${survivor}`);
      execSync(`pm2 delete ${myPmId}`, { timeout: 10_000 });
      return; // pm2 delete가 SIGINT를 보냄
    }
    // survivor(최대 pm_id) 본인만 남기고 삭제 — slice(1)은 최소만 남겨 자기 자신을 죽이는 버그였음
    for (const twin of twins.filter((t) => t !== survivor)) {
      console.warn(`[pm2-dedupe] 중복 프로세스 pm_id=${twin} 삭제`);
      try { execSync(`pm2 delete ${twin}`, { timeout: 10_000 }); } catch { /* 이미 죽었으면 무시 */ }
    }
  } catch (e) {
    console.warn("[pm2-dedupe] 확인 실패 (무시):", e instanceof Error ? e.message : e);
  }
}

async function bootstrap() {
  if (process.env.COLYSEUS_CLOUD !== undefined) {
    dedupePm2Processes();
  }
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
