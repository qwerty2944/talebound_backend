import { Router } from "express";
import { callDbFunction } from "../db/rpc.js";
import { RPC_ALLOWLIST } from "./allowlist.js";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const rpcRouter = Router();

rpcRouter.use(requireAuth);

/** p_character_id가 본인(userId 자체 또는 본인 소유 캐릭터 id)인지 검증 */
async function ownsCharacter(userId: string, characterId: unknown): Promise<boolean> {
  if (characterId === userId) return true;
  if (typeof characterId !== "string") return false;
  const { rows } = await pool.query(
    `select 1 from characters where id = $1::uuid and user_id = $2 limit 1`,
    [characterId, userId]
  );
  return rows.length > 0;
}

// supabase.rpc(fn, args) 대체 엔드포인트
rpcRouter.post("/:fn", async (req, res) => {
  const fn = req.params.fn;
  const meta = RPC_ALLOWLIST[fn];
  if (!meta) {
    res.status(404).json({ error: `허용되지 않은 함수: ${fn}` });
    return;
  }

  const args: Record<string, unknown> = { ...(req.body ?? {}) };

  if (meta.injectUserId) {
    args.p_user_id = req.userId;
  }
  if (meta.ownCharacter && !(await ownsCharacter(req.userId!, args.p_character_id))) {
    res.status(403).json({ error: "본인 캐릭터가 아닙니다" });
    return;
  }

  try {
    const data = await callDbFunction(fn, args, meta.returns);
    res.json({ data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "RPC 실행 실패";
    console.error(`[rpc:${fn}]`, message);
    res.status(500).json({ error: message });
  }
});
