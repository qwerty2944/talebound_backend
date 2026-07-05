import { Module, Injectable, type OnModuleInit } from "@nestjs/common";
import cron from "node-cron";
import { pool } from "../database/pool.js";

/**
 * Supabase Edge Function 크론 대체.
 * - recover-fatigue (10분): batch_recover_fatigue 호출
 * - update-game-time (30분): game_settings의 현재 시간/시간대/날씨 컬럼 갱신
 *   (프론트는 epoch로 직접 계산하므로 이 컬럼들은 표시/호환용)
 */
@Injectable()
class FatigueCronService implements OnModuleInit {
  onModuleInit() {
    cron.schedule("*/10 * * * *", async () => {
      try {
        const { rows } = await pool.query(`select batch_recover_fatigue(10) as updated`);
        console.log(`[cron] 피로도 회복 완료 (${rows[0]?.updated}명)`);
      } catch (e) {
        console.error("[cron] 피로도 회복 실패:", e instanceof Error ? e.message : e);
      }
    });

    cron.schedule("0,30 * * * *", async () => {
      try {
        await pool.query(`
          update game_settings set
            current_game_hour = floor(
              (extract(epoch from (now() - game_epoch)) % (day_cycle_hours * 3600))
              / (day_cycle_hours * 3600) * 24
            )::int,
            current_period = (array['night','dawn','day','dusk'])[
              floor(
                (extract(epoch from (now() - game_epoch)) % (day_cycle_hours * 3600))
                / (day_cycle_hours * 3600) * 4
              )::int + 1
            ],
            current_weather = (array['sunny','cloudy','rainy','stormy','foggy'])[
              floor(
                (extract(epoch from (now() - weather_epoch::timestamptz)) % (weather_cycle_hours * 3600))
                / (weather_cycle_hours * 3600) * 5
              )::int + 1
            ],
            updated_at = now()
        `);
        console.log("[cron] 게임 시간/날씨 갱신 완료");
      } catch (e) {
        console.error("[cron] 게임 시간 갱신 실패:", e instanceof Error ? e.message : e);
      }
    });
  }
}

@Module({
  providers: [FatigueCronService],
})
export class CronModule {}
