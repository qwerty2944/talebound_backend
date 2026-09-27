import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getEquipmentFitError } from '../src/game-data/equipment-fit.js';
const rules=JSON.parse(fs.readFileSync('game-data/equipment-fit.json','utf8')).rules as {itemIds:string[]}[];
const equipment=JSON.parse(fs.readFileSync('game-data/equipment.json','utf8')).items as {id:string;requirements?:{raceCategories?:string[]}}[];
test('all reviewed item IDs, including legacy aliases, reject every non-elf race',()=>{
  for(const rule of rules) for(const itemId of rule.itemIds) {
    assert.ok(equipment.some(item=>item.id===itemId && item.requirements?.raceCategories?.includes('elf')));
    for(const raceId of ['eastern_human','green_orc','hill_dwarf',null,'unknown']) {
      assert.ok(getEquipmentFitError({helmet:{itemId}},{raceId}));
    }
  }
});
test('all four elf races and legacy elf IDs can wear fitted helmets',()=>{
  for(const raceId of ['dark_elf','high_elf','moon_elf','wood_elf','elf','darkelf']) {
    assert.equal(getEquipmentFitError({helmet:{itemId:rules[0].itemIds[0]}},{raceId}),null);
  }
});
test('client cannot spoof fit by changing metadata or the slot',()=>{
  assert.ok(getEquipmentFitError({cloth:{itemId:rules[0].itemIds[0],name:'가죽 모자',requirements:{},spriteId:'Helmet_1'}},{raceId:'eastern_human'}));
});
test('universal tiara, weapons, empty slots and clearing equipment remain allowed',()=>{
  assert.equal(getEquipmentFitError({helmet:{itemId:'leather_cap'},mainHand:{itemId:'iron_sword'}},{raceId:'eastern_human'}),null);
  assert.equal(getEquipmentFitError({helmet:null},{raceId:'eastern_human'}),null);
  assert.equal(getEquipmentFitError(null,null),null);
});
test('legacy character race is supported but cannot override an explicit non-elf appearance',()=>{
  const eq={helmet:{itemId:rules[0].itemIds[0]}};
  assert.equal(getEquipmentFitError(eq,null,{race:'elf'}),null);
  assert.ok(getEquipmentFitError(eq,{raceId:'human'},{race:'elf'}));
});
