import cron from "node-cron";
import { pool } from "./db/pool.js";

/**
 * Supabase Edge Function `recover-fatigue` (pg_cron 10분 주기) 대체.
 * 기존 DB 함수 batch_recover_fatigue를 그대로 호출한다.
 */
export function startCronJobs(): void {
  cron.schedule("*/10 * * * *", async () => {
    try {
      await pool.query(`select batch_recover_fatigue(10)`);
      console.log("[cron] batch_recover_fatigue(10) 실행 완료");
    } catch (e) {
      console.error("[cron] 피로도 회복 실패:", e instanceof Error ? e.message : e);
    }
  });
}
