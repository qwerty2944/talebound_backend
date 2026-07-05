import { Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import {
  getQuest,
  getAllQuests,
  killQuestIdsByMonster,
  getItemType,
  type GameQuest,
} from "../game-data/game-data.js";
import { grantExpGold } from "../database/rewards.js";

/**
 * 서버 권위 퀘스트.
 * - accept: minLevel 검증 후 user_quests 행 생성
 * - claim: 목표 달성 검증 → exp/gold/아이템 지급(+레벨업). 서버만 보상을 계산한다.
 * kill 진행도는 battle.service 승리 정산에서 incrementKillProgress로 누적된다.
 */

type QuestStatus = "accepted" | "completed" | "claimed";

interface UserQuestRow {
  quest_id: string;
  status: QuestStatus;
  progress: { kill?: number } | null;
}

export interface QuestClaimResult {
  questId: string;
  exp: number;
  gold: number;
  items: { itemId: string; quantity: number }[];
  levelUp: { leveledUp: boolean; newLevel: number; levelsGained: number };
  totalGold: number;
  totalExp: number;
}

interface InventoryItem {
  slot: number;
  itemId: string;
  quantity: number;
}

@Injectable()
export class QuestService {
  /** 모든 퀘스트 정의 + 유저 상태(accepted/completed/claimed) 병합 */
  async list(userId: string): Promise<
    (GameQuest & { status: QuestStatus | "available"; progress: { kill?: number } })[]
  > {
    const { rows } = await pool.query<UserQuestRow>(
      `select quest_id, status, progress from user_quests where user_id = $1`,
      [userId]
    );
    const byId = new Map(rows.map((r) => [r.quest_id, r]));
    return getAllQuests().map((q) => {
      const uq = byId.get(q.id);
      return {
        ...q,
        status: uq?.status ?? "available",
        progress: uq?.progress ?? {},
      };
    });
  }

  async accept(userId: string, questId: string): Promise<{ questId: string; status: QuestStatus }> {
    const quest = getQuest(questId);
    if (!quest) throw new NotFoundException({ error: `알 수 없는 퀘스트: ${questId}` });

    const { rows } = await pool.query<{ level: number }>(
      `select level from characters where user_id = $1`,
      [userId]
    );
    const level = Number(rows[0]?.level) || 1;
    if (level < quest.minLevel) {
      throw new BadRequestException({
        error: `레벨이 부족합니다 (필요 Lv.${quest.minLevel})`,
        code: "LEVEL_TOO_LOW",
      });
    }

    const existing = await pool.query<UserQuestRow>(
      `select status from user_quests where user_id = $1 and quest_id = $2`,
      [userId, questId]
    );
    if (existing.rows[0]) {
      throw new ConflictException({ error: "이미 수락했거나 완료한 퀘스트입니다", code: "ALREADY_ACCEPTED" });
    }

    const initialProgress = quest.objective.type === "kill" ? { kill: 0 } : {};
    await pool.query(
      `insert into user_quests (user_id, quest_id, status, progress) values ($1, $2, 'accepted', $3)`,
      [userId, questId, JSON.stringify(initialProgress)]
    );
    return { questId, status: "accepted" };
  }

  /** 전투 승리 시 호출 — 해당 몬스터를 목표로 하는 accepted kill 퀘스트 진행도 누적 */
  async incrementKillProgress(userId: string, monsterId: string): Promise<void> {
    const questIds = killQuestIdsByMonster(monsterId);
    if (questIds.length === 0) return;

    for (const questId of questIds) {
      const quest = getQuest(questId);
      if (!quest || quest.objective.type !== "kill") continue;
      const target = quest.objective.count ?? 1;

      const { rows } = await pool.query<UserQuestRow>(
        `select status, progress from user_quests where user_id = $1 and quest_id = $2`,
        [userId, questId]
      );
      const row = rows[0];
      if (!row || row.status !== "accepted") continue; // 미수락/완료/수령 → 스킵

      const current = Number(row.progress?.kill ?? 0);
      const next = Math.min(target, current + 1);
      const status: QuestStatus = next >= target ? "completed" : "accepted";
      await pool.query(
        `update user_quests set progress = $3, status = $4, updated_at = now()
         where user_id = $1 and quest_id = $2`,
        [userId, questId, JSON.stringify({ kill: next }), status]
      );
    }
  }

  async claim(userId: string, questId: string): Promise<QuestClaimResult> {
    const quest = getQuest(questId);
    if (!quest) throw new NotFoundException({ error: `알 수 없는 퀘스트: ${questId}` });

    const { rows } = await pool.query<UserQuestRow>(
      `select status, progress from user_quests where user_id = $1 and quest_id = $2`,
      [userId, questId]
    );
    const row = rows[0];
    if (!row) throw new BadRequestException({ error: "수락하지 않은 퀘스트입니다", code: "NOT_ACCEPTED" });
    if (row.status === "claimed") {
      throw new ConflictException({ error: "이미 보상을 수령한 퀘스트입니다", code: "ALREADY_CLAIMED" });
    }

    // ---- 목표 검증 ----
    const obj = quest.objective;
    if (obj.type === "kill") {
      const target = obj.count ?? 1;
      if (Number(row.progress?.kill ?? 0) < target) {
        throw new BadRequestException({ error: "아직 목표를 달성하지 못했습니다", code: "OBJECTIVE_INCOMPLETE" });
      }
    } else if (obj.type === "visit") {
      const { rows: cr } = await pool.query<{ current_map_id: string | null }>(
        `select current_map_id from characters where user_id = $1`,
        [userId]
      );
      if (cr[0]?.current_map_id !== obj.mapId) {
        throw new BadRequestException({
          error: "해당 장소에서만 보상을 받을 수 있습니다",
          code: "OBJECTIVE_INCOMPLETE",
        });
      }
    } else if (obj.type === "collect") {
      const itemId = obj.itemId!;
      const need = obj.count ?? 1;
      const items = await this.getPersonalItems(userId);
      const have = items.filter((it) => it.itemId === itemId).reduce((s, it) => s + it.quantity, 0);
      if (have < need) {
        throw new BadRequestException({
          error: `재료가 부족합니다 (${have}/${need})`,
          code: "OBJECTIVE_INCOMPLETE",
        });
      }
      // 인벤토리에서 차감 (슬롯 순회)
      let remaining = need;
      for (const it of items) {
        if (remaining <= 0) break;
        if (it.itemId !== itemId) continue;
        const take = Math.min(remaining, it.quantity);
        await callDbFunction(
          "inventory_remove_item",
          { p_user_id: userId, p_inventory_type: "personal", p_slot: it.slot, p_quantity: take },
          "scalar"
        );
        remaining -= take;
      }
    }

    // ---- 보상 지급 ----
    const exp = quest.rewards.exp ?? 0;
    const gold = quest.rewards.gold ?? 0;

    // 원자적: 보상 수령 상태를 조건부로 갱신 (동시 중복 수령 방지). 지급 전에 선점.
    const upd = await pool.query(
      `update user_quests set status = 'claimed', updated_at = now()
       where user_id = $1 and quest_id = $2 and status <> 'claimed'`,
      [userId, questId]
    );
    if (upd.rowCount === 0) {
      throw new ConflictException({ error: "이미 보상을 수령한 퀘스트입니다", code: "ALREADY_CLAIMED" });
    }

    // 보상은 상대 증분으로 지급 → 동시 정산 lost-update 방지.
    const { newLevel, newExp, levelsGained, totalGold } = await grantExpGold(userId, exp, gold);

    const items = quest.rewards.items ?? [];
    for (const item of items) {
      try {
        await callDbFunction(
          "inventory_add_item",
          {
            p_user_id: userId,
            p_inventory_type: "personal",
            p_item_id: item.itemId,
            p_item_type: getItemType(item.itemId),
            p_quantity: item.quantity,
          },
          "scalar"
        );
      } catch (e) {
        console.error(`[quest] 보상 아이템 지급 실패 (${item.itemId}):`, e instanceof Error ? e.message : e);
      }
    }

    return {
      questId,
      exp,
      gold,
      items,
      levelUp: { leveledUp: levelsGained > 0, newLevel, levelsGained },
      totalGold,
      totalExp: newExp,
    };
  }

  private async getPersonalItems(userId: string): Promise<InventoryItem[]> {
    const inv = (await callDbFunction(
      "inventory_get",
      { p_user_id: userId, p_inventory_type: "personal" },
      "scalar"
    )) as { items?: InventoryItem[]; error?: string } | null;
    return inv?.items ?? [];
  }
}
