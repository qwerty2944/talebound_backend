import fs from "fs";
import path from "path";

/**
 * game-data/*.json 로더 (부팅 시 1회).
 * 원본은 프론트 public/data — scripts/sync-game-data.mjs로 동기화한다.
 * 서버 권위 보상/검증은 이 데이터만 신뢰한다.
 */

export interface MonsterRewards {
  exp: number;
  gold: number;
}

export interface MonsterDrop {
  itemId: string;
  chance: number; // 0~1
  quantity: [number, number]; // [min, max]
}

export interface GameMonster {
  id: string;
  nameKo: string;
  level: number;
  type: string;
  alignment?: string;
  rewards: MonsterRewards;
  drops?: MonsterDrop[];
}

interface HealerService {
  gold: number;
}

interface HealerNpc {
  id: string;
  mapId?: string;
  services?: { healing?: Record<string, HealerService | number> };
}

const DATA_DIR = path.resolve(process.cwd(), "game-data");

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
}

const monstersById = new Map<string, GameMonster>();
const healersById = new Map<string, HealerNpc>();
const itemTypeById = new Map<string, string>();

export function loadGameData(): void {
  const monsterData = loadJson<{ monsters: GameMonster[] }>("monsters.json");
  for (const m of monsterData.monsters) monstersById.set(m.id, m);

  const healerData = loadJson<{ npcs?: HealerNpc[]; healers?: HealerNpc[] }>("healers.json");
  for (const h of healerData.npcs ?? healerData.healers ?? []) healersById.set(h.id, h);

  // 아이템 타입 맵 (드랍 지급 시 inventory_add_item의 item_type에 사용)
  for (const file of ["equipment.json", "consumables.json", "materials.json", "misc.json"]) {
    try {
      const data = loadJson<{ items: { id: string; type: string }[] }>(file);
      for (const item of data.items ?? []) itemTypeById.set(item.id, item.type);
    } catch {
      console.warn(`[game-data] ${file} 없음 — 해당 타입 드랍은 material로 처리됨`);
    }
  }

  console.log(`🎲 게임 데이터 로드: 몬스터 ${monstersById.size}, 치료사 ${healersById.size}, 아이템 ${itemTypeById.size}`);
}

export function getItemType(itemId: string): string {
  return itemTypeById.get(itemId) ?? "material";
}

export function getMonster(id: string): GameMonster | undefined {
  return monstersById.get(id);
}

/** 치료사의 부상 등급별 치료비 (severity: light/medium/critical) */
export function getHealerPrice(npcId: string, severity: string): number | undefined {
  const npc = healersById.get(npcId);
  const svc = npc?.services?.healing?.[severity];
  if (svc === undefined) return undefined;
  return typeof svc === "number" ? svc : svc.gold;
}
