import fs from 'node:fs';
import path from 'node:path';
const fit = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'game-data/equipment-fit.json'), 'utf8')) as { rules: {itemIds: string[]}[] };

const ELF_RACES = new Set(['elf', 'darkelf', 'dark_elf', 'high_elf', 'moon_elf', 'wood_elf']);
const restrictedIds = new Set(fit.rules.flatMap(rule => rule.itemIds));
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Never trust client-supplied names, sprite IDs or requirement metadata. */
export function getEquipmentFitError(equipment: unknown, appearance: unknown, character?: unknown): string | null {
  const race = object(appearance).raceId ?? object(character).race;
  if (typeof race === 'string' && ELF_RACES.has(race)) return null;
  for (const value of Object.values(object(equipment))) {
    const itemId = object(value).itemId;
    if (typeof itemId === 'string' && restrictedIds.has(itemId)) {
      return '엘프 전용 장비입니다. 장비를 해제하거나 엘프 종족을 선택하세요.';
    }
  }
  return null;
}
