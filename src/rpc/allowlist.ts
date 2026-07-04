import type { RpcReturns } from "../db/rpc.js";

/**
 * 프론트엔드가 호출할 수 있는 DB 함수 allowlist.
 * - returns: 언랩 방식 (scalar = 단일 값/JSON, set = SETOF/TABLE)
 * - injectUserId: true면 p_user_id를 JWT의 userId로 강제 덮어씀 (클라이언트 값 무시)
 * - ownCharacter: true면 p_character_id가 본인 캐릭터인지 검증
 */
export interface RpcMeta {
  returns: RpcReturns;
  injectUserId?: boolean;
  ownCharacter?: boolean;
}

export const RPC_ALLOWLIST: Record<string, RpcMeta> = {
  // 프로필/피로도/크리스탈/부상/로그인
  consume_fatigue: { returns: "scalar", injectUserId: true },
  restore_fatigue: { returns: "scalar", injectUserId: true },
  use_crystal: { returns: "scalar", injectUserId: true },
  consume_whisper_charge: { returns: "set", injectUserId: true },
  add_injury: { returns: "scalar", injectUserId: true },
  heal_injury_with_gold: { returns: "scalar", injectUserId: true },
  check_daily_login: { returns: "scalar", injectUserId: true },
  update_karma: { returns: "set", injectUserId: true },

  // 캐릭터
  save_character: { returns: "scalar", injectUserId: true },
  upsert_user_location: { returns: "scalar", injectUserId: true },

  // 인벤토리
  inventory_get: { returns: "scalar", injectUserId: true },
  inventory_add_item: { returns: "scalar", injectUserId: true },
  inventory_remove_item: { returns: "scalar", injectUserId: true },
  inventory_move_item: { returns: "scalar", injectUserId: true },
  inventory_update_quantity: { returns: "scalar", injectUserId: true },

  // 장비 (인스턴스/강화/소켓/룬워드)
  create_equipment_instance: { returns: "scalar", ownCharacter: true },
  enhance_equipment: { returns: "scalar", ownCharacter: true },
  insert_socket_item: { returns: "scalar", ownCharacter: true },
  remove_socket_item: { returns: "scalar", ownCharacter: true },
  activate_runeword: { returns: "scalar", ownCharacter: true },

  // 어빌리티
  increase_ability_exp: { returns: "scalar", ownCharacter: true },
  update_abilities_progress: { returns: "scalar", ownCharacter: true },
  update_skill_progress: { returns: "scalar", injectUserId: true },

  // 통계
  record_battle_result: { returns: "scalar", ownCharacter: true },
  increment_combat_stat: { returns: "scalar", ownCharacter: true },

  // 채팅
  get_recent_messages: { returns: "set" },
};
