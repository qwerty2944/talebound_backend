import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

/**
 * 프론트가 supabase.from(...)으로 직접 조회/수정하던 테이블 접근을 대체하는 REST 라우트.
 * 응답은 기존 DB row 그대로(snake_case) 반환해 프론트 매핑 코드를 유지한다.
 */
export const tablesRouter = Router();

tablesRouter.use(requireAuth);

// ============ characters (프로필) ============

tablesRouter.get("/profile", async (req, res) => {
  const { rows } = await pool.query(`select * from characters where user_id = $1`, [req.userId]);
  if (!rows[0]) {
    res.status(404).json({ error: "프로필이 없습니다" });
    return;
  }
  res.json({ data: rows[0] });
});

// 업데이트 허용 컬럼 (본인 row 한정)
const PROFILE_COLUMNS = new Set([
  "level", "experience", "gold", "gems",
  "fatigue", "fatigue_updated_at",
  "current_hp", "current_mp", "current_map_id",
  "injuries", "traits", "religion", "buffs",
  "character", "appearance", "equipment", "nickname",
  "whisper_charges", "crystal_tier",
]);

const JSONB_COLUMNS = new Set(["injuries", "traits", "religion", "buffs", "character", "appearance", "equipment"]);

tablesRouter.patch("/profile", async (req, res) => {
  const updates = req.body ?? {};
  const keys = Object.keys(updates).filter((k) => PROFILE_COLUMNS.has(k));
  if (keys.length === 0) {
    res.status(400).json({ error: "업데이트할 컬럼이 없습니다" });
    return;
  }

  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) =>
    JSONB_COLUMNS.has(k) && updates[k] !== null ? JSON.stringify(updates[k]) : updates[k]
  );

  await pool.query(`update characters set ${sets} where user_id = $1`, [req.userId, ...values]);
  res.json({ data: null });
});

// ============ game_settings ============

tablesRouter.get("/game-settings", async (_req, res) => {
  const { rows } = await pool.query(`select * from game_settings limit 1`);
  res.json({ data: rows[0] ?? null });
});

// ============ character_statistics ============

tablesRouter.get("/statistics/:characterId", async (req, res) => {
  const { rows } = await pool.query(
    `select * from character_statistics where character_id = $1`,
    [req.params.characterId]
  );
  res.json({ data: rows[0] ?? null });
});

// ============ abilities ============

tablesRouter.get("/abilities/:userId", async (req, res) => {
  // 본인 데이터만
  if (req.params.userId !== req.userId) {
    res.status(403).json({ error: "본인 데이터만 조회할 수 있습니다" });
    return;
  }
  const { rows } = await pool.query(
    `select combat, magic, life from abilities where user_id = $1`,
    [req.userId]
  );
  res.json({ data: rows[0] ?? null });
});

// ============ proficiencies (숙련도, 0-100) ============

const PROFICIENCY_KEYS = new Set([
  "light_sword", "medium_sword", "great_sword", "axe", "mace", "dagger",
  "spear", "bow", "crossbow", "staff", "fist", "shield",
  "fire", "ice", "lightning", "earth", "holy", "dark", "poison", "arcane",
]);

tablesRouter.get("/proficiencies", async (req, res) => {
  const { rows } = await pool.query(
    `select values from proficiencies where user_id = $1`,
    [req.userId]
  );
  res.json({ data: rows[0]?.values ?? {} });
});

tablesRouter.post("/proficiencies/gain", async (req, res) => {
  const { type, amount } = req.body ?? {};
  if (!PROFICIENCY_KEYS.has(type) || typeof amount !== "number" || amount <= 0 || amount > 10) {
    res.status(400).json({ error: "잘못된 숙련도 증가 요청입니다" });
    return;
  }

  const { rows } = await pool.query(
    `insert into proficiencies (user_id, values)
     values ($1, jsonb_build_object($2::text, least(100, $3::numeric)))
     on conflict (user_id) do update set
       values = proficiencies.values || jsonb_build_object(
         $2::text,
         least(100, coalesce((proficiencies.values->>$2)::numeric, 0) + $3::numeric)
       ),
       updated_at = now()
     returning (values->>$2)::numeric as new_value`,
    [req.userId, type, amount]
  );

  res.json({ data: { type, value: Number(rows[0]?.new_value ?? 0) } });
});

// ============ equipment_instances ============

tablesRouter.get("/equipment-instances", async (req, res) => {
  const characterId = req.query.characterId;
  if (typeof characterId !== "string") {
    res.status(400).json({ error: "characterId가 필요합니다" });
    return;
  }
  const { rows } = await pool.query(
    `select * from equipment_instances where character_id = $1 order by created_at desc`,
    [characterId]
  );
  res.json({ data: rows });
});

tablesRouter.get("/equipment-instances/:id", async (req, res) => {
  const { rows } = await pool.query(`select * from equipment_instances where id = $1`, [req.params.id]);
  if (!rows[0]) {
    res.status(404).json({ error: "장비 인스턴스가 없습니다" });
    return;
  }
  res.json({ data: rows[0] });
});

tablesRouter.delete("/equipment-instances/:id", async (req, res) => {
  await pool.query(`delete from equipment_instances where id = $1`, [req.params.id]);
  res.json({ data: null });
});
