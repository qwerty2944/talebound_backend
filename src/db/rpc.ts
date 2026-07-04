import { pool } from "./pool.js";

/**
 * 기존 Supabase Postgres에 정의된 DB 함수를 named-argument 방식으로 호출한다.
 * 모든 결과를 jsonb 배열로 수집한 뒤, 함수 성격(set/scalar)에 따라 언랩한다.
 * - scalar/json 반환 함수 → 배열 첫 요소
 * - SETOF/TABLE 반환 함수 → 배열 그대로
 */
export type RpcReturns = "scalar" | "set";

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function callDbFunction(
  fn: string,
  args: Record<string, unknown>,
  returns: RpcReturns
): Promise<unknown> {
  if (!IDENT.test(fn)) throw new Error(`잘못된 함수명: ${fn}`);

  const names = Object.keys(args).filter((k) => args[k] !== undefined);
  for (const n of names) {
    if (!IDENT.test(n)) throw new Error(`잘못된 인자명: ${n}`);
  }

  const placeholders = names.map((n, i) => `${n} := $${i + 1}`).join(", ");
  const values = names.map((n) => {
    const v = args[n];
    // 배열은 pg가 Postgres 배열 리터럴로 직렬화 (text[] 등),
    // 일반 객체는 JSON 문자열로 보내 jsonb 파라미터에 코어싱되게 한다.
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return JSON.stringify(v);
    }
    return v;
  });

  const query = `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as result from ${fn}(${placeholders}) as t`;
  const { rows } = await pool.query(query, values);
  const arr = (rows[0]?.result ?? []) as unknown[];

  return returns === "set" ? arr : arr[0] ?? null;
}
