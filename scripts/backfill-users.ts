/**
 * Supabase auth.users → app_users 백필 스크립트 (멱등).
 * 같은 Postgres에 붙어 있으므로 SQL 한 번으로 끝난다.
 * 백필된 유저는 password_hash가 없으므로 로그인 시 비밀번호 재설정을 거친다.
 *
 * 실행: npm run backfill-users -w server
 */
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? undefined : { rejectUnauthorized: false },
});

async function main() {
  await pool.query(`
    create table if not exists app_users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text,
      must_reset_password boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);

  const { rows } = await pool.query(`
    insert into app_users (id, email, must_reset_password, created_at)
    select id, email, true, created_at
    from auth.users
    where email is not null
    on conflict (id) do nothing
    returning email
  `);

  console.log(`백필 완료: ${rows.length}명 이전됨`);
  for (const r of rows) console.log(`  - ${r.email}`);

  const { rows: total } = await pool.query(`select count(*)::int as n from app_users`);
  console.log(`app_users 총 ${total[0].n}명`);

  await pool.end();
}

main().catch((e) => {
  console.error("백필 실패:", e);
  process.exit(1);
});
