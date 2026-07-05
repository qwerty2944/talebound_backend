/**
 * 프론트엔드 public/data의 게임 데이터를 백엔드 game-data/로 복사한다.
 * 서버 권위 보상/검증 계산은 이 복사본만 신뢰한다.
 *
 * 실행: npm run sync-data  (변경 시 커밋 필요)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DATA = path.resolve(__dirname, "../../talebound_frontend/public/data");
const DEST = path.resolve(__dirname, "../game-data");

const FILES = [
  "monsters/monsters.json",
  "npcs/healers.json",
  "npcs/merchants.json",
  "npcs/trainers.json",
  "config/enhancement.json",
  "items/equipment.json",
  "items/consumables.json",
  "items/materials.json",
  "items/misc.json",
  "quests/quests.json",
  "world/dungeons.json",
];

if (!fs.existsSync(FRONTEND_DATA)) {
  console.error(`프론트엔드 데이터 경로 없음: ${FRONTEND_DATA}`);
  process.exit(1);
}

for (const rel of FILES) {
  const src = path.join(FRONTEND_DATA, rel);
  const dest = path.join(DEST, path.basename(rel));
  if (!fs.existsSync(src)) {
    console.error(`누락: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`✓ ${rel} → game-data/${path.basename(rel)}`);
}
console.log("동기화 완료. 변경분을 커밋하세요.");
