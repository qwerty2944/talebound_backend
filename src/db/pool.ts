import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // Supabase pooler는 TLS 필수
  ssl: env.DATABASE_URL.includes("localhost") ? undefined : { rejectUnauthorized: false },
});

/** 서버 자체 테이블 준비 (멱등) */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    create table if not exists app_users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text,
      must_reset_password boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);

  // 숙련도 저장 (무기 8종 + 마법 8속성, 값 0-100)
  await pool.query(`
    create table if not exists proficiencies (
      user_id uuid primary key,
      values jsonb not null default '{}',
      updated_at timestamptz not null default now()
    )
  `);
}
