import { pool } from "./pool.js";

/**
 * 정산 멱등성(재플레이 방지)을 DB에 영속화한다.
 *
 * 인메모리 Map은 재시작/PM2 다중 인스턴스에서 공유되지 않아 같은 토큰의 이중 지급이
 * 가능했다. consumed_jtis(jti primary key)에 INSERT ... ON CONFLICT DO NOTHING 하고
 * rowCount로 최초 소비 여부를 판정한다(원자적).
 *
 * @returns true = 이번에 처음 소비(정산 진행 가능), false = 이미 소비됨(재플레이)
 */
export async function consumeJti(jti: string, ttlMs: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const { rowCount } = await pool.query(
    `insert into consumed_jtis (jti, expires_at) values ($1, $2)
     on conflict (jti) do nothing`,
    [jti, expiresAt]
  );

  // TTL 지난 행 opportunistic 정리 (저확률 게이트로 오버헤드 최소화)
  if (Math.random() < 0.02) {
    pool.query(`delete from consumed_jtis where expires_at < now()`).catch(() => {});
  }

  return rowCount === 1;
}
