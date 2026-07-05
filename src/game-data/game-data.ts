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

// ============ 퀘스트 ============

export type QuestObjectiveType = "kill" | "collect" | "visit";

export interface QuestObjective {
  type: QuestObjectiveType;
  monsterId?: string;
  itemId?: string;
  mapId?: string;
  count?: number;
}

export interface QuestReward {
  exp: number;
  gold: number;
  items?: { itemId: string; quantity: number }[];
}

export interface GameQuest {
  id: string;
  npcId: string;
  nameKo: string;
  descriptionKo: string;
  minLevel: number;
  objective: QuestObjective;
  rewards: QuestReward;
}

// ============ 상점 ============

export interface GameMerchant {
  id: string;
  nameKo?: string;
  mapId?: string;
  /** 상인이 취급하는 아이템 id 목록 */
  stock?: string[];
}

interface ItemPrice {
  value: number;
  sellPrice?: number;
}

// ============ 던전 ============

export interface GameDungeon {
  id: string;
  nameKo: string;
  descriptionKo: string;
  entryMapId: string;
  minLevel: number;
  fatigueCost: number;
  waves: string[]; // 몬스터 id 순서
  clearRewards: QuestReward;
}

const DATA_DIR = path.resolve(process.cwd(), "game-data");

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
}

const monstersById = new Map<string, GameMonster>();
const healersById = new Map<string, HealerNpc>();
const itemTypeById = new Map<string, string>();
const itemPriceById = new Map<string, ItemPrice>();
const merchantsById = new Map<string, GameMerchant>();
const trainerIds = new Set<string>();
const questsById = new Map<string, GameQuest>();
const dungeonsById = new Map<string, GameDungeon>();
/** kill 퀘스트: 몬스터 id → 해당 몬스터를 처치 목표로 하는 퀘스트 id 목록 */
const killQuestIdsByMonsterMap = new Map<string, string[]>();

export function loadGameData(): void {
  const monsterData = loadJson<{ monsters: GameMonster[] }>("monsters.json");
  for (const m of monsterData.monsters) monstersById.set(m.id, m);

  const healerData = loadJson<{ npcs?: HealerNpc[]; healers?: HealerNpc[] }>("healers.json");
  for (const h of healerData.npcs ?? healerData.healers ?? []) healersById.set(h.id, h);

  // 아이템 타입/가격 맵 (드랍·상점 지급 시 사용). 가격 권위는 이 서버 데이터.
  for (const file of ["equipment.json", "consumables.json", "materials.json", "misc.json"]) {
    try {
      const data = loadJson<{ items: { id: string; type: string; value?: number; sellPrice?: number }[] }>(file);
      for (const item of data.items ?? []) {
        itemTypeById.set(item.id, item.type);
        if (typeof item.value === "number") {
          itemPriceById.set(item.id, { value: item.value, sellPrice: item.sellPrice });
        }
      }
    } catch {
      console.warn(`[game-data] ${file} 없음 — 해당 타입 드랍은 material로 처리됨`);
    }
  }

  // 상인 (취급 품목 stock)
  try {
    const merchantData = loadJson<{ npcs?: GameMerchant[] }>("merchants.json");
    for (const m of merchantData.npcs ?? []) merchantsById.set(m.id, m);
  } catch {
    console.warn("[game-data] merchants.json 없음 — 상점 비활성");
  }

  // 훈련사 (train 엔드포인트는 proficiencyType만 받지만 검증/미래 확장용으로 로드)
  try {
    const trainerData = loadJson<{ npcs?: { id: string }[] }>("trainers.json");
    for (const t of trainerData.npcs ?? []) trainerIds.add(t.id);
  } catch {
    console.warn("[game-data] trainers.json 없음");
  }

  // 퀘스트
  try {
    const questData = loadJson<{ quests: GameQuest[] }>("quests.json");
    for (const q of questData.quests ?? []) {
      questsById.set(q.id, q);
      if (q.objective.type === "kill" && q.objective.monsterId) {
        const list = killQuestIdsByMonsterMap.get(q.objective.monsterId) ?? [];
        list.push(q.id);
        killQuestIdsByMonsterMap.set(q.objective.monsterId, list);
      }
    }
  } catch {
    console.warn("[game-data] quests.json 없음 — 퀘스트 비활성");
  }

  // 던전
  try {
    const dungeonData = loadJson<{ dungeons: GameDungeon[] }>("dungeons.json");
    for (const d of dungeonData.dungeons ?? []) dungeonsById.set(d.id, d);
  } catch {
    console.warn("[game-data] dungeons.json 없음 — 던전 비활성");
  }

  console.log(
    `🎲 게임 데이터 로드: 몬스터 ${monstersById.size}, 치료사 ${healersById.size}, 아이템 ${itemTypeById.size}, 상인 ${merchantsById.size}, 훈련사 ${trainerIds.size}, 퀘스트 ${questsById.size}, 던전 ${dungeonsById.size}`
  );
}

export function getItemType(itemId: string): string {
  return itemTypeById.get(itemId) ?? "material";
}

/** 아이템 구매가(value). 정의 없으면 undefined */
export function getItemValue(itemId: string): number | undefined {
  return itemPriceById.get(itemId)?.value;
}

/** 아이템 판매 단가 = sellPrice ?? floor(value*0.4). 정의 없으면 undefined */
export function getItemSellPrice(itemId: string): number | undefined {
  const p = itemPriceById.get(itemId);
  if (!p) return undefined;
  return p.sellPrice ?? Math.floor(p.value * 0.4);
}

export function getMerchant(id: string): GameMerchant | undefined {
  return merchantsById.get(id);
}

export function getMonster(id: string): GameMonster | undefined {
  return monstersById.get(id);
}

export function getQuest(id: string): GameQuest | undefined {
  return questsById.get(id);
}

export function getAllQuests(): GameQuest[] {
  return [...questsById.values()];
}

/** 특정 몬스터를 처치 목표로 하는 kill 퀘스트 id 목록 */
export function killQuestIdsByMonster(monsterId: string): string[] {
  return killQuestIdsByMonsterMap.get(monsterId) ?? [];
}

export function getDungeon(id: string): GameDungeon | undefined {
  return dungeonsById.get(id);
}

export function getAllDungeons(): GameDungeon[] {
  return [...dungeonsById.values()];
}

/** 치료사의 부상 등급별 치료비 (severity: light/medium/critical) */
export function getHealerPrice(npcId: string, severity: string): number | undefined {
  const npc = healersById.get(npcId);
  const svc = npc?.services?.healing?.[severity];
  if (svc === undefined) return undefined;
  return typeof svc === "number" ? svc : svc.gold;
}
