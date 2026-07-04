import { Room, type Client } from "@colyseus/core";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { verifyToken } from "../auth/jwt.js";
import { pool } from "../db/pool.js";
import { callDbFunction } from "../db/rpc.js";

/**
 * 맵 단위 룸. Supabase Realtime의 `map:{mapId}` 채널을 대체한다.
 * - presence → state.players (MapSchema)
 * - chat_message / whisper broadcast → onMessage 릴레이 (+ 서버측 DB 저장/크리스탈 검증)
 * - duel_* broadcast → 그대로 릴레이 (페이로드는 클라이언트 소유)
 */

export class MapPlayer extends Schema {
  @type("string") userId = "";
  @type("string") characterName = "";
}

export class MapRoomState extends Schema {
  @type({ map: MapPlayer }) players = new MapSchema<MapPlayer>();
}

interface JoinOptions {
  token: string;
  mapId: string;
  characterName: string;
}

interface ChatPayload {
  id: string;
  mapId: string;
  senderId: string;
  senderName: string;
  messageType: "normal" | "whisper" | "system";
  recipientName?: string;
  content: string;
  createdAt: string;
}

const DUEL_EVENTS = ["duel_request", "duel_response", "duel_start", "duel_action", "duel_end"] as const;

export class MapRoom extends Room<MapRoomState> {
  maxClients = 200;
  autoDispose = true;

  mapId = "";

  onCreate(options: JoinOptions) {
    this.state = new MapRoomState();
    this.mapId = options.mapId;

    // ---- 일반 채팅: 다른 클라이언트에 릴레이 + DB 저장 ----
    this.onMessage("chat_message", (client, payload: ChatPayload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      // 발신자 정보는 서버가 보증
      const message: ChatPayload = {
        ...payload,
        mapId: this.mapId,
        senderId: player.userId,
        senderName: player.characterName,
        messageType: "normal",
      };

      this.broadcast("chat_message", message, { except: client });
      this.saveChat(message).catch((e) => console.error("[chat save]", e));
    });

    // ---- 귓속말: 크리스탈 충전 검증 후 대상에게만 전달 ----
    this.onMessage("whisper", async (client, payload: ChatPayload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !payload.recipientName) return;

      try {
        const result = (await callDbFunction(
          "consume_whisper_charge",
          { p_user_id: player.userId },
          "set"
        )) as Array<{ success: boolean; remaining_charges: number; crystal_tier: string | null }>;

        if (!result[0]?.success) {
          client.send("whisper_error", {
            code: "NO_CHARGES",
            message: "통신용 크리스탈이 필요합니다",
          });
          return;
        }
      } catch (e) {
        console.error("[whisper charge]", e);
      }

      const message: ChatPayload = {
        ...payload,
        mapId: this.mapId,
        senderId: player.userId,
        senderName: player.characterName,
        messageType: "whisper",
      };

      const target = this.clients.find(
        (c) => this.state.players.get(c.sessionId)?.characterName === payload.recipientName
      );
      if (target) {
        target.send("whisper", message);
      } else {
        client.send("whisper_error", {
          code: "RECIPIENT_OFFLINE",
          message: `${payload.recipientName}님은 현재 이 지역에 없습니다`,
        });
        return;
      }

      this.saveChat(message).catch((e) => console.error("[whisper save]", e));
    });

    // ---- 결투 이벤트: 페이로드 그대로 릴레이 (클라이언트가 필터링) ----
    for (const event of DUEL_EVENTS) {
      this.onMessage(event, (client, payload: unknown) => {
        this.broadcast(event, payload, { except: client });
      });
    }
  }

  async onAuth(_client: Client, options: JoinOptions) {
    const payload = verifyToken(options.token);
    return { userId: payload.sub };
  }

  async onJoin(client: Client, options: JoinOptions, auth: { userId: string }) {
    const player = new MapPlayer();
    player.userId = auth.userId;
    player.characterName = options.characterName || "Unknown";
    this.state.players.set(client.sessionId, player);

    // 위치 기록 (기존 upsert_user_location 함수 재사용)
    try {
      await callDbFunction(
        "upsert_user_location",
        {
          p_user_id: auth.userId,
          p_character_name: player.characterName,
          p_map_id: this.mapId,
        },
        "scalar"
      );
    } catch (e) {
      console.error("[location upsert]", e);
    }
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }

  private async saveChat(message: ChatPayload): Promise<void> {
    await pool.query(
      `insert into chat_messages (map_id, sender_id, sender_name, message_type, recipient_name, content)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        message.mapId,
        message.senderId,
        message.senderName,
        message.messageType,
        message.recipientName ?? null,
        message.content,
      ]
    );
  }
}
