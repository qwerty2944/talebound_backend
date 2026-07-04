import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { signToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";

export const authRouter = Router();

async function hasCharacter(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from characters where user_id = $1 and character is not null limit 1`,
    [userId]
  );
  return rows.length > 0;
}

// 회원가입
authRouter.post("/signup", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || !email.includes("@") || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "이메일 형식과 6자 이상 비밀번호가 필요합니다" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      `insert into app_users (email, password_hash) values ($1, $2) returning id, email`,
      [email.toLowerCase(), passwordHash]
    );
    const user = rows[0];
    res.json({
      token: signToken({ sub: user.id, email: user.email }),
      user: { id: user.id, email: user.email },
      hasCharacter: false,
    });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "23505") {
      res.status(409).json({ error: "이미 가입된 이메일입니다" });
      return;
    }
    throw e;
  }
});

// 로그인
authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "이메일과 비밀번호가 필요합니다" });
    return;
  }

  const { rows } = await pool.query(
    `select id, email, password_hash, must_reset_password from app_users where email = $1`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" });
    return;
  }

  // Supabase에서 백필된 유저: 비밀번호 해시가 없으므로 재설정 필요
  if (!user.password_hash || user.must_reset_password) {
    res.status(409).json({ error: "비밀번호 재설정이 필요합니다", code: "PASSWORD_RESET_REQUIRED" });
    return;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" });
    return;
  }

  res.json({
    token: signToken({ sub: user.id, email: user.email }),
    user: { id: user.id, email: user.email },
    hasCharacter: await hasCharacter(user.id),
  });
});

// 비밀번호 재설정 (백필 유저 전용 — must_reset_password가 true인 계정만 허용)
authRouter.post("/reset-password", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "이메일과 6자 이상 새 비밀번호가 필요합니다" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `update app_users
     set password_hash = $2, must_reset_password = false
     where email = $1 and must_reset_password = true
     returning id, email`,
    [email.toLowerCase(), passwordHash]
  );
  const user = rows[0];
  if (!user) {
    res.status(400).json({ error: "재설정 대상 계정이 아닙니다" });
    return;
  }

  res.json({
    token: signToken({ sub: user.id, email: user.email }),
    user: { id: user.id, email: user.email },
    hasCharacter: await hasCharacter(user.id),
  });
});

// 현재 유저 조회
authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({
    user: { id: req.userId, email: req.userEmail },
    hasCharacter: await hasCharacter(req.userId!),
  });
});
