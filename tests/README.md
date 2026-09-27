# Equipment fit validation

`npm run test:equipment-fit` validates canonical item-ID restrictions, all elf race IDs, missing or non-elf races, universal equipment, and spoofed client metadata. No database or production account is used.

`PATCH /api/profile` locks the character row, validates the resulting equipment and race together, then updates in the same transaction. Changing race while retaining incompatible equipment returns 400; send the equipment removal with the race update.

The reviewed sprite rules originate in `talebound_frontend/src/shared/lib/character/equipment-fit.json`; `npm run sync-data` copies them with the item definitions. See the frontend's `docs/art-review` for the visual evidence. Deploy both PRs to apply the rule consistently. Existing unrelated profile changes are unaffected.
