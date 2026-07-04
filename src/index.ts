import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { env } from "./config/env.js";
import { ensureSchema } from "./db/pool.js";
import { authRouter } from "./auth/routes.js";
import { rpcRouter } from "./rpc/routes.js";
import { tablesRouter } from "./routes/tables.js";
import { MapRoom } from "./rooms/MapRoom.js";
import { startCronJobs } from "./cron.js";

async function main() {
  await ensureSchema();

  const app = express();
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/rpc", rpcRouter);
  app.use("/api", tablesRouter);
  app.use("/colyseus", monitor());

  const server = http.createServer(app);

  const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
  });

  // 같은 mapId끼리 같은 룸에 배정
  gameServer.define("map", MapRoom).filterBy(["mapId"]);

  startCronJobs();

  server.listen(env.PORT, () => {
    console.log(`🎮 MUD 서버 실행 중: http://localhost:${env.PORT}`);
    console.log(`   - REST API: /api/*`);
    console.log(`   - Colyseus 모니터: /colyseus`);
  });
}

main().catch((e) => {
  console.error("서버 시작 실패:", e);
  process.exit(1);
});
