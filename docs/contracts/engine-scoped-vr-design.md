# Engine-scoped VR availability — arc design (owner-confirmed 2026-08-20)

**Owner confirmation:** "I guess we need to have some way of making a tournament state (only playable on FX engine and VR) evaluate the combo. Then some way to filter based on that same evaluation if the tournament is configured as such." — YES, exactly this design. Also owner facts: Banzai Run canNOT be played in VR yet was pickable + score-submittable in WG-VR; **Comet IS now VR-playable — a new Zen pack added Comet to Pinball FX VR** (so the FX VR curated draft needs a refresh in this arc).

## Problem (proven on prod, 2026-08-20)

WG-VR (rtx_pinball, id `817a98ba-...`) stores the LEGACY flat rule `{"required":["vr","zaccaria_vr","pinball_fx_classic_vr","star_wars_pinball_vr","pinball_fx_vr"]}` which `parseTournamentRules` lifts to engines{zaccaria, fx_classic, star_wars, fx} + devices{vr_headset} — **the two axes evaluate independently**, so Banzai Run / Black Knight 2000 pass (engine ✓ via `fx`, device ✓ via a flat `vr` feature that actually derives from VPX VR rooms — an engine the rule excludes). The legacy ids were engine+VR COUPLES; migration 129's fold (`pinball_fx_vr` → engine `fx` + flat feature `vr`, scoreProvenance.ts:745,811) discarded the coupling. Verified: Attack from Mars IS in fxVrPackContents (legit); Banzai Run / Black Knight 2000 / (pre-new-pack) Comet are NOT.

## Design

1. **Catalogue: per-engine VR features.** Keep flat `vr` (back-compat + "VR somehow"). Add engine-scoped features `vr_vpx`, `vr_fx`, `vr_fx_classic`, `vr_zaccaria`, `vr_star_wars` (naming TBD in build — must not collide with LEGACY_PLATFORM_MAP spellings; the legacy coupled ids `zaccaria_vr` etc. are already claimed as legacy inputs). Written by importers, which still know the coupling:
   - VPS importer: VPS's VR flag is per-VPX-table → `vr` + `vr_vpx`.
   - FX VR importer (fxVrPackContents): → `vr` + `vr_fx` (taxonomy: FX-on-Quest = engine fx + device vr_headset, scoreProvenance.ts:154). **Refresh tmp/fx-vr-tables-draft.md first — new pack incl. Comet — regenerate via `node tmp/emit-fx-vr-data-ts.js`.**
   - Zaccaria (Steam Pinball + AtGames rows with engine `zaccaria`): Zaccaria Pinball has universal VR → blanket `vr_zaccaria` for zaccaria-engine rows (migration backfill + importer forward).
   - Star Wars Pinball VR: star_wars-engine rows → `vr_star_wars` (verify whether the whole star_wars catalogue is VR-available or needs a curated subset — recon in build).
   - FX2 VR (`fx_classic`): historical, small table set — likely needs a curated list; if unrecoverable, skip (WG-VR loses nothing vs today's false positives).
2. **Rule evaluation (the combo):** in `passesplatformRules`' device axis — when the rule requires `vr_headset` AND has engines.required, the VR match must come from `vr_<E>` for some E ∈ engines.required (or a platform that already denotes engine+VR); flat `vr` satisfies only when the rule has NO engine axis. Single change inside `deviceMatchesGame`/its call — ALL 7 passesplatformRules call sites (Picks list, web pick, admin activate, Discord autocomplete+activate, autopick, timeout fallback) inherit it automatically, which is exactly the "filter based on that same evaluation" the owner asked for. Check the FE mirror parity test (`scoreProvenance-parity.test.ts` — extend, never weaken) if new ids land in the canonical sets.
3. **WG-VR rule re-save** to the modern two-axis shape (writes always emit two-axis; stored legacy upgrades on admin re-save — or a one-off prod UPDATE with owner approval).
4. **Backfill/migration:** migration adds nothing schema-wise (features are JSON) — backfill = blanket `vr_zaccaria` rule + re-run VPS/FX-VR syncs; log counts.

## Riding along (recon-found enforcement holes, 2026-08-20 — owner shown, not yet explicitly confirmed)

- Discord `/pick-game` EXECUTE path skips platform rules + mode entirely (`pickgame.ts:283-322` — autocomplete-only enforcement, bypassable by typing). This is how Banzai Run got picked. Route through the same checks as the web `POST /pick-game` (rooms.ts:926-948).
- Queue-consumption revalidation checks cooldown only (`TournamentEngine.ts:879`, `:1769` — post fix/maintenance-stale-queue-fk) — add platform-rules re-check so a rule change evicts (or skips) already-queued ineligible games.
- `PickGameModal` offers every active tournament for a clicked game regardless of eligibility (`Picks.tsx:1370`) — filter client-side per tournament (pick-status already ships `platform_rules`; needs an FE-side evaluation or a small BE assist — decide in build).
- Submission side: WG-VR accepted a Banzai Run score — `ensurePlatformAllowed` is excluded-only by design (ADR 0009); game-level eligibility is supposed to be enforced at pick/activation, which the holes above leaked. Fixing pick/activation closes it; no change to submission semantics.

## Estimate
1–2 sessions: taxonomy/feature ids + evaluator change + parity check (½), importer updates + FX-VR draft refresh + backfill + prod re-sync (½), enforcement holes + tests (½–1). ADR: amend 0016 (or new ADR) for engine-scoped availability features.
