import { Injectable, BadRequestException, NotFoundException, InternalServerErrorException } from "@nestjs/common";
import { pool } from "../database/pool.js";
import { callDbFunction } from "../database/rpc.js";
import {
  getMerchant,
  getItemValue,
  getItemSellPrice,
  getItemType,
} from "../game-data/game-data.js";

/**
 * 서버 권위 상점.
 * - 가격은 game-data(프론트 items 동기화본)의 value/sellPrice만 신뢰한다.
 * - 골드는 조건부 UPDATE(gold >= cost)로 원자적으로 차감/지급해 음수·경합을 막는다.
 */

interface InventoryItem {
  slot: number;
  itemId: string;
  quantity: number;
}

export interface BuyResult {
  gold: number;
  itemId: string;
  quantity: number;
}

export interface SellResult {
  gold: number;
}

@Injectable()
export class ShopService {
  /** npcId 상인이 itemId를 quantity만큼 판매 → 골드 차감 후 인벤 지급 */
  async buy(userId: string, npcId: string, itemId: string, quantity: number): Promise<BuyResult> {
    const qty = this.validateQuantity(quantity);

    const merchant = getMerchant(npcId);
    if (!merchant) throw new NotFoundException({ error: `상인을 찾을 수 없습니다: ${npcId}` });
    if (!merchant.stock?.includes(itemId)) {
      throw new BadRequestException({ error: "이 상인이 취급하지 않는 품목입니다", code: "ITEM_NOT_STOCKED" });
    }

    const unit = getItemValue(itemId);
    if (unit === undefined) {
      throw new BadRequestException({ error: `가격 정보가 없는 아이템입니다: ${itemId}`, code: "NO_PRICE" });
    }
    const cost = unit * qty;

    // 원자적 골드 차감 (음수 불가). rowCount 0 → 잔액 부족
    const { rows, rowCount } = await pool.query<{ gold: number }>(
      `update characters set gold = gold - $2
       where user_id = $1 and gold >= $2
       returning gold`,
      [userId, cost]
    );
    if (rowCount === 0) {
      // 캐릭터 존재 여부로 부족/미존재 구분
      const { rows: cr } = await pool.query(`select 1 from characters where user_id = $1`, [userId]);
      if (cr.length === 0) throw new NotFoundException({ error: "캐릭터가 없습니다" });
      throw new BadRequestException({ error: "골드가 부족합니다", code: "NOT_ENOUGH_GOLD" });
    }
    let gold = Number(rows[0].gold);

    // 인벤 지급 — 실패 시 골드 환불 (원자성 보장)
    try {
      await callDbFunction(
        "inventory_add_item",
        {
          p_user_id: userId,
          p_inventory_type: "personal",
          p_item_id: itemId,
          p_item_type: getItemType(itemId),
          p_quantity: qty,
        },
        "scalar"
      );
    } catch (e) {
      const refund = await pool.query<{ gold: number }>(
        `update characters set gold = gold + $2 where user_id = $1 returning gold`,
        [userId, cost]
      );
      gold = Number(refund.rows[0]?.gold ?? gold + cost);
      console.error(`[shop] 구매 지급 실패, 골드 환불 (${itemId}):`, e instanceof Error ? e.message : e);
      throw new InternalServerErrorException({ error: "아이템 지급에 실패했습니다", code: "GRANT_FAILED" });
    }

    return { gold, itemId, quantity: qty };
  }

  /** itemId를 quantity만큼 판매 → 인벤 차감 후 골드 지급 */
  async sell(userId: string, itemId: string, quantity: number): Promise<SellResult> {
    const qty = this.validateQuantity(quantity);

    const unit = getItemSellPrice(itemId);
    if (unit === undefined) {
      throw new BadRequestException({ error: `판매할 수 없는 아이템입니다: ${itemId}`, code: "NO_PRICE" });
    }

    const items = await this.getPersonalItems(userId);
    const owned = items.filter((it) => it.itemId === itemId);
    const have = owned.reduce((s, it) => s + it.quantity, 0);
    if (have < qty) {
      throw new BadRequestException({
        error: `보유 수량이 부족합니다 (${have}/${qty})`,
        code: "NOT_ENOUGH_ITEMS",
      });
    }

    // 인벤에서 먼저 차감 (권위 감소) → 슬롯 순회
    let remaining = qty;
    for (const it of owned) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, it.quantity);
      await callDbFunction(
        "inventory_remove_item",
        { p_user_id: userId, p_inventory_type: "personal", p_slot: it.slot, p_quantity: take },
        "scalar"
      );
      remaining -= take;
    }

    // 골드 지급
    const payout = unit * qty;
    const { rows } = await pool.query<{ gold: number }>(
      `update characters set gold = gold + $2 where user_id = $1 returning gold`,
      [userId, payout]
    );
    if (rows.length === 0) throw new NotFoundException({ error: "캐릭터가 없습니다" });

    return { gold: Number(rows[0].gold) };
  }

  private validateQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new BadRequestException({ error: "수량은 1~99 사이 정수여야 합니다", code: "INVALID_QUANTITY" });
    }
    return quantity;
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
