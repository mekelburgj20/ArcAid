import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { foldCatalogueToEngines } from '../database/migrations/catalogueEngineFold.js';
import { ScoreProvenanceService } from '../services/ScoreProvenanceService.js';
import {
    CANONICAL_DEVICES,
    foldCataloguePlatforms,
} from '../utils/scoreProvenance.js';
import {
    catalogueMatchTokens,
    deviceMatchTokens,
    deviceMatchesGame,
    legacyPlatformsForDevice,
    normalizeTournamentRulesInput,
    parsePlatformsList,
    passesplatformRules,
    type TournamentRules,
} from '../utils/platformRules.js';

/**
 * ADR 0016 catalogue phase §4 — the semantics that must hold once
 * `global_games.platforms` is an ENGINE list.
 *
 * Two things are being proved here, and they are different things:
 *
 *   1. **Gating identity across the fold.** A pre-migration catalogue row and
 *      its folded equivalent must admit the same games under the same rules.
 *      This is the analogue of P2's "a legacy row gates identically" test, and
 *      it is what makes migration 129 safe to run against production.
 *   2. **`required: ['atgames']` still means what it means today.** That single
 *      rule is the most common one in production (hazard H-C), and it is the
 *      one the fold most threatens: once `atgames` leaves `platforms`, a
 *      platforms-only device match admits ZERO games. The test compares the new
 *      predicate against the OLD one, literally.
 */

/** The rule shape a legacy stored blob lifts to. */
function rules(legacy: { required?: string[]; excluded?: string[] }): TournamentRules {
    return normalizeTournamentRulesInput(legacy);
}

function twoAxis(devices: string[]): TournamentRules {
    return normalizeTournamentRulesInput({ devices: { required: devices, excluded: [] } });
}

// ─────────────────────────────────────────────────────────────────────────────
// The device → match table (contract §4, FLAGGED PRODUCT CALL #2)
// ─────────────────────────────────────────────────────────────────────────────

describe('device → match table', () => {
    it('matches `atgames` on explicit availability, never on engine compat', () => {
        // The whole point of the ruling. `ENGINE_DEVICE_COMPAT.vpx` contains
        // `atgames`, so a compat-based gate would admit EVERY VPX table. The
        // plain VPX game below must NOT match.
        expect(deviceMatchesGame('atgames', ['vpx'], [])).toBe(false);
        expect(deviceMatchesGame('atgames', ['vpx'], ['vpxs'])).toBe(true);
        expect(deviceMatchesGame('atgames', ['vpx'], ['vpxs_manual'])).toBe(true);
        expect(deviceMatchesGame('atgames', ['atgames_native'], ['atgames'])).toBe(true);
        // …and pre-fold, on the legacy platform ids still sitting in the column.
        expect(deviceMatchesGame('atgames', ['vpx', 'vpxs'], [])).toBe(true);
        expect(deviceMatchesGame('atgames', ['atgames'], [])).toBe(true);
    });

    it('matches `vr_headset` on the `vr` feature or any legacy `*_vr` id', () => {
        expect(deviceMatchesGame('vr_headset', ['fx'], ['vr'])).toBe(true);
        expect(deviceMatchesGame('vr_headset', ['fx'], [])).toBe(false);
        expect(deviceMatchesGame('vr_headset', ['pinball_fx_vr'], [])).toBe(true);
        expect(deviceMatchesGame('vr_headset', ['zaccaria_vr'], [])).toBe(true);
        expect(deviceMatchesGame('vr_headset', ['star_wars_pinball_vr'], [])).toBe(true);
    });

    it('matches `real_cabinet` on the `real` engine', () => {
        expect(deviceMatchesGame('real_cabinet', ['real'], [])).toBe(true);
        expect(deviceMatchesGame('real_cabinet', ['irl'], [])).toBe(true);
        expect(deviceMatchesGame('real_cabinet', ['vpx'], [])).toBe(false);
    });

    it('matches `pc` on the PC video engine, not on "runs on a PC"', () => {
        // `pc` lives in BOTH namespaces (hazard H-H). The device rule means the
        // game exists as a PC title — not that a PC could run it, which is true
        // of nearly everything and would make the rule meaningless.
        expect(deviceMatchesGame('pc', ['pc'], [])).toBe(true);
        expect(deviceMatchesGame('pc', ['vpx'], [])).toBe(false);
    });

    it('matches `console` on any console video engine and `arcade_cabinet` on `arcade`', () => {
        expect(deviceMatchesGame('console', ['nes'], [])).toBe(true);
        expect(deviceMatchesGame('console', ['ps2'], [])).toBe(true);
        expect(deviceMatchesGame('console', ['pc'], [])).toBe(false);
        expect(deviceMatchesGame('console', ['arcade'], [])).toBe(false);
        expect(deviceMatchesGame('console', ['vpx'], [])).toBe(false);
        expect(deviceMatchesGame('arcade_cabinet', ['arcade'], [])).toBe(true);
        expect(deviceMatchesGame('arcade_cabinet', ['nes'], [])).toBe(false);
    });

    it('matches `standalone_other` on nothing — the catalogue does not record it', () => {
        for (const platforms of [['vpx'], ['vpxs'], ['nes'], ['real']]) {
            expect(deviceMatchesGame('standalone_other', platforms, ['vpxs'])).toBe(false);
        }
    });

    it('gives every canonical device a match rule that is decidable', () => {
        for (const device of Object.keys(CANONICAL_DEVICES)) {
            const t = deviceMatchTokens(device);
            expect(Array.isArray(t.platforms), device).toBe(true);
            expect(Array.isArray(t.features), device).toBe(true);
        }
        // `unknown` is the explicit no-claim value and must never gate.
        expect(deviceMatchTokens('unknown')).toEqual({ platforms: [], features: [] });
        expect(deviceMatchesGame('unknown', ['vpx'], ['vpxs'])).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// "required: ['atgames'] keeps admitting exactly what it admits today"
// ─────────────────────────────────────────────────────────────────────────────

describe("the dominant production rule — required: ['atgames']", () => {
    /** Exactly what `passesplatformRules` did before this phase. */
    function oldDeviceMatch(device: string, gamePlatforms: string[]): boolean {
        const tokens = legacyPlatformsForDevice(device);
        const have = new Set(gamePlatforms.map(p => p.trim().toLowerCase()));
        return tokens.some(t => have.has(t));
    }

    const LEGACY_CATALOGUE: string[][] = [
        ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'], // WHO dunnit
        ['vpx'],
        ['vpx', 'vpxs'],
        ['vpx', 'vpxs_manual'],
        ['vpx', 'vpx standalone'],
        ['atgames'],
        ['real'],
        ['pinball_fx'],
        ['pinball_fx_vr'],
        ['zaccaria', 'zaccaria_vr'],
        ['star_wars_pinball_vr'],
        ['bam', 'fp'],
        ['nes'],
        ['pc'],
        ['vr'],
        [],
    ];

    it('reproduces the pre-phase gate on the legacy catalogue, device by device', () => {
        // Only the devices a legacy rule can actually lift to are compared —
        // `console`/`arcade_cabinet` matched literally nothing before (no legacy
        // id maps to them), and their widening is documented in
        // `DEVICE_MATCH_ENGINES`. `vr_headset` is EXCLUDED here as of ADR
        // 0019 — it now WIDENS on purpose; see the dedicated test below.
        for (const device of ['atgames', 'real_cabinet', 'pc', 'standalone_other']) {
            for (const platforms of LEGACY_CATALOGUE) {
                expect(
                    deviceMatchesGame(device, platforms, []),
                    `${device} vs ${JSON.stringify(platforms)}`,
                ).toBe(oldDeviceMatch(device, platforms));
            }
        }
    });

    it("widens `vr_headset`'s SQL-superset tokens for the wholesale ('always') engines — ADR 0019", () => {
        // `deviceMatchTokens('vr_headset')` — and therefore `deviceMatchesGame`
        // — is no longer pinned 1:1 to `oldDeviceMatch`: ADR 0019 deliberately
        // widens it into a SUPERSET so a wholesale-VR-engine game (e.g. a
        // plain `vpx` row carrying no legacy `*_vr`/`vr` token at all)
        // survives the SQL pre-filter in rooms.ts and reaches the JS gate.
        // The real authority is `vrHeadsetMatchesGame` (engine-scoped,
        // exercised in vr-availability.test.ts), which narrows this back
        // down; `deviceMatchesGame` itself no longer decides eligibility for
        // this device, only SQL candidacy. Pinned entry by entry:
        const nowMatches = [
            ['vpx'], ['vpx', 'vpxs'], ['vpx', 'vpxs_manual'], ['vpx', 'vpx standalone'],
            ['bam', 'fp'],
        ];
        const stillNoMatch = [
            ['atgames'], ['real'], ['pinball_fx'], ['nes'], ['pc'], [],
        ];
        const alreadyMatched = [
            ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'],
            ['pinball_fx_vr'], ['zaccaria', 'zaccaria_vr'], ['star_wars_pinball_vr'], ['vr'],
        ];
        for (const platforms of nowMatches) {
            expect(oldDeviceMatch('vr_headset', platforms), JSON.stringify(platforms)).toBe(false);
            expect(deviceMatchesGame('vr_headset', platforms, []), JSON.stringify(platforms)).toBe(true);
        }
        for (const platforms of stillNoMatch) {
            expect(deviceMatchesGame('vr_headset', platforms, []), JSON.stringify(platforms))
                .toBe(oldDeviceMatch('vr_headset', platforms));
        }
        for (const platforms of alreadyMatched) {
            expect(oldDeviceMatch('vr_headset', platforms), JSON.stringify(platforms)).toBe(true);
            expect(deviceMatchesGame('vr_headset', platforms, []), JSON.stringify(platforms)).toBe(true);
        }
    });

    it("admits the same games before and after the fold for required: ['atgames']", () => {
        const rule = rules({ required: ['atgames'] });
        for (const platforms of LEGACY_CATALOGUE) {
            const before = passesplatformRules(platforms, rule, []);
            const fold = foldCataloguePlatforms(platforms);
            const after = passesplatformRules(fold.engines, rule, fold.features);
            expect(after, `${JSON.stringify(platforms)} → ${JSON.stringify(fold)}`).toBe(before);
        }
    });

    it('still admits the games it admits today — not merely "the same as itself"', () => {
        // A pair of sanity anchors, so the equivalence test above cannot pass
        // vacuously by making everything false.
        const rule = rules({ required: ['atgames'] });
        expect(passesplatformRules(['vpx', 'vpxs'], rule, [])).toBe(true);
        expect(passesplatformRules(['vpx'], rule, ['vpxs'])).toBe(true);
        expect(passesplatformRules(['vpx'], rule, [])).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE equivalence test (contract §7) — pre/post-migration gating identity
// ─────────────────────────────────────────────────────────────────────────────

describe('pre/post-fold gating equivalence, over every device rule', () => {
    const CATALOGUE: string[][] = [
        ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'],
        ['vpx'], ['vpxs'], ['vpxs_manual'], ['vp9'], ['fp'], ['bam'],
        ['pinball_fx'], ['pinball_fx_vr'], ['pinball_fx_classic'],
        ['pinball_fx_classic_vr'], ['pinball_fx_midnight'],
        ['star_wars_pinball_vr'], ['zaccaria'], ['zaccaria_vr'],
        ['atgames'], ['real'], ['irl'], ['nes'], ['snes'], ['arcade'], ['pc'],
        ['vr'], ['fx2'], ['xyzzy'], [],
    ];

    it('admits the same games for every single-device rule', () => {
        // `vr_headset` is EXCLUDED here as of ADR 0019 — it has two known,
        // documented divergences (a legacy `*_vr` platform token carries
        // per-table VR evidence directly; the GENERIC fold — as opposed to an
        // FX VR importer re-sync — collapses it to feature `vr`, which no
        // longer counts as per-table evidence). See the dedicated test below.
        for (const device of Object.keys(CANONICAL_DEVICES).filter(d => d !== 'vr_headset')) {
            const rule = twoAxis([device]);
            for (const platforms of CATALOGUE) {
                const before = passesplatformRules(platforms, rule, []);
                const fold = foldCataloguePlatforms(platforms);
                // The migration keeps unfoldable tokens OUT of platforms; the
                // fixture mirrors that.
                const after = passesplatformRules(fold.engines, rule, fold.features);
                expect(after, `${device} vs ${JSON.stringify(platforms)}`).toBe(before);
            }
        }
    });

    it('`vr_headset` fold identity holds except for un-re-synced per-table `*_vr` evidence (ADR 0019)', () => {
        // `foldCataloguePlatforms` — the GENERIC legacy→engine+feature fold
        // shared by migration 129 and the importers — collapses every legacy
        // `*_vr` token to the single informational feature `vr` (unchanged by
        // this ADR; see `CATALOGUE_PLATFORM_FEATURE`). That is NOT the same
        // as the engine-scoped evidence feature (`fx_vr`/`fx_classic_vr`)
        // `vrHeadsetMatchesGame` looks for on a `per_table` engine — that
        // evidence is stamped only by the dedicated FX VR / FX Classic VR
        // importer sync (Task E), which is the ADR's documented "one owner
        // click" post-deploy step, not by re-running the generic fold.
        //
        // So a row still carrying the RAW legacy token `pinball_fx_vr` or
        // `pinball_fx_classic_vr` (never migrated, never re-synced) matches
        // via the legacy-token-evidence path directly — but the SAME
        // platforms run back through the generic fold lose that evidence
        // down to generic `vr`, and (fx/fx_classic being `per_table`, not
        // `always`) no longer qualify until an importer sync restamps the
        // evidence feature. Every OTHER row in the catalogue (including
        // `zaccaria_vr`/`star_wars_pinball_vr`, whose engines are `always`
        // and so need no per-table evidence at all) keeps the fold identity.
        const rule = twoAxis(['vr_headset']);
        const KNOWN_DIVERGENT = [['pinball_fx_vr'], ['pinball_fx_classic_vr']];
        for (const platforms of CATALOGUE) {
            const before = passesplatformRules(platforms, rule, []);
            const fold = foldCataloguePlatforms(platforms);
            const after = passesplatformRules(fold.engines, rule, fold.features);
            if (KNOWN_DIVERGENT.some(p => JSON.stringify(p) === JSON.stringify(platforms))) {
                expect(before, JSON.stringify(platforms)).toBe(true);
                expect(after, JSON.stringify(platforms)).toBe(false);
            } else {
                expect(after, JSON.stringify(platforms)).toBe(before);
            }
        }
    });

    it('admits the same games for every single-engine rule', () => {
        // The engine axis is unchanged by this phase, but the fold moves the
        // data underneath it — `vpxs` → `vpx` must keep matching a `vpx` rule.
        //
        // `atgames_native` is excluded and handled below: it is the ONE engine
        // the fold deliberately changes, and asserting it unchanged here would
        // assert the phase did not do its job.
        for (const engine of ['real', 'vpx', 'vp9', 'fp', 'fx', 'fx_classic',
            'fx_midnight', 'zaccaria', 'star_wars', 'nes', 'pc']) {
            const rule = normalizeTournamentRulesInput({
                engines: { required: [engine], excluded: [] },
            });
            for (const platforms of CATALOGUE) {
                const before = passesplatformRules(platforms, rule, []);
                const fold = foldCataloguePlatforms(platforms);
                const after = passesplatformRules(fold.engines, rule, fold.features);
                expect(after, `${engine} vs ${JSON.stringify(platforms)}`).toBe(before);
            }
        }
    });

    it('makes the `atgames_native` engine rule newly non-vacuous — the intended change', () => {
        // FLAGGED PRODUCT CALL #1, stated as a behaviour rather than a table
        // row. Before the fold, `atgames` mapped to engine `unknown`, so an
        // AtGames game had NO engine: `requiredEngines: ['atgames_native']`
        // matched zero games, and the game's own submit picker locked to
        // Unspecified. After, the game has the engine and the rule works.
        //
        // This can only widen. A rule naming `atgames_native` was unreachable
        // from the tournament form anyway (its engine options come from
        // `enginesFromLegacyPlatforms`, which dropped the unknown), so nothing
        // that gated before gates differently — something that gated NOTHING
        // now gates something.
        const rule = normalizeTournamentRulesInput({
            engines: { required: ['atgames_native'], excluded: [] },
        });
        for (const platforms of CATALOGUE) {
            const fold = foldCataloguePlatforms(platforms);
            const after = passesplatformRules(fold.engines, rule, fold.features);
            expect(after, JSON.stringify(platforms)).toBe(fold.engines.includes('atgames_native'));
            if (after) expect(passesplatformRules(platforms, rule, [])).toBe(false);
        }
    });

    it('admits the same games for the legacy flat rules P2 lifts', () => {
        const LEGACY_RULES = [
            { required: ['atgames'] },
            { required: ['vpx'] },
            { required: ['vpxs'] },
            { required: ['real'] },
            { required: ['pinball_fx'] },
            { required: ['atgames', 'real'] },
            { required: ['vpxs'], excluded: ['real'] },
        ];
        for (const legacy of LEGACY_RULES) {
            const rule = rules(legacy);
            for (const platforms of CATALOGUE) {
                const before = passesplatformRules(platforms, rule, []);
                const fold = foldCataloguePlatforms(platforms);
                const after = passesplatformRules(fold.engines, rule, fold.features);
                expect(after, `${JSON.stringify(legacy)} vs ${JSON.stringify(platforms)}`).toBe(before);
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SQL twin of `deviceMatchesGame`
// ─────────────────────────────────────────────────────────────────────────────

async function createApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

let seq = 0;
async function seedCatalogue(name: string, platforms: string[], features: string[] = []) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status)
         VALUES (?, ?, 'pinball', ?, ?, 'approved')`,
        `gg-${++seq}`, name, JSON.stringify(platforms), JSON.stringify(features),
    );
}

async function seedTournament(roomId: string, platformRules: unknown) {
    const db = await getDatabase();
    const id = `t-${++seq}`;
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, platform_rules)
         VALUES (?, 'T', 'weekly', 'pinball', '{}', 1, ?, ?)`,
        id, roomId, JSON.stringify(platformRules),
    );
    return id;
}

describe('the available-games SQL agrees with passesplatformRules', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    /**
     * `GET /:roomId/game-availability/:tournamentId` builds the eligibility
     * gate in SQL, independently of `passesplatformRules`. Two implementations
     * of one rule is exactly how a picker and a validator drift apart, so the
     * test drives BOTH over the same fixture and demands the same answer.
     */
    it.each([
        ['legacy catalogue', false],
        ['folded catalogue', true],
    ])('%s', async (_label, fold) => {
        const app = await createApp();
        const roomId = await createTestRoom(`r-${Date.now()}`);

        const FIXTURE: Array<[string, string[]]> = [
            ['Who Dunnit',  ['vpx', 'vpxs', 'real', 'atgames']],
            ['Plain VPX',   ['vpx']],
            ['Manual VPX',  ['vpx', 'vpxs_manual']],
            ['AtGames Only', ['atgames']],
            ['FX VR',       ['pinball_fx', 'pinball_fx_vr']],
            ['Real Only',   ['real']],
            ['NES Game',    ['nes']],
        ];
        for (const [name, platforms] of FIXTURE) await seedCatalogue(name, platforms);
        if (fold) await foldCatalogueToEngines(await getDatabase());

        // `required` only. The endpoint ALSO applies `excluded` in SQL, which
        // `passesplatformRules` deliberately ignores (ADR 0009: excluded is a
        // submission-level filter, not an eligibility gate) — a pre-existing
        // divergence this phase neither introduces nor fixes. It is pinned by
        // its own test below so it stays a known quirk rather than a surprise.
        const db = await getDatabase();
        for (const legacy of [
            { required: ['atgames'] },
            { required: ['vpx'] },
            { required: ['real'] },
            { required: ['vpxs'] },
            { required: ['pinball_fx'] },
        ]) {
            const tournamentId = await seedTournament(roomId, legacy);
            const res = await request(app)
                .get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
            expect(res.status).toBe(200);
            const fromSql = (res.body.games ?? res.body.availableGames ?? res.body)
                .map((g: any) => g.name).sort();

            const rows = await db.all('SELECT name, platforms, features FROM global_games');
            const parsed = normalizeTournamentRulesInput(legacy);
            const fromJs = rows
                .filter((r: any) => passesplatformRules(
                    parsePlatformsList(r.platforms || '[]'),
                    parsed,
                    parsePlatformsList(r.features || '[]'),
                ))
                .map((r: any) => r.name)
                .sort();

            expect(fromSql, `${JSON.stringify(legacy)} (${_label})`).toEqual(fromJs);
        }
    });
});

describe('`excluded` on the availability endpoint — unified with ADR 0009 (v2.102.2)', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    /**
     * The "future unification" the old pin anticipated happened 2026-08-12
     * (owner field report: WG-VPXS couldn't pick "Tales from the Crypt" — a
     * real 1993 machine with a VPXS port, hidden because the tournament
     * excludes `real`). The endpoint no longer applies `excluded` in SQL;
     * `excluded` never gates eligibility (ADR 0009). The one deliberate
     * remnant: a game whose EVERY platform is excluded — nothing left to
     * submit from — stays hidden (`resolveSubmittablePlatforms` empty).
     */
    it('shows a game that merely CARRIES an excluded platform (the Tales-from-the-Crypt case)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom(`r4-${Date.now()}`);
        await seedCatalogue('Who Dunnit', ['vpx', 'vpxs', 'real', 'atgames']);
        const legacy = { required: ['vpxs'], excluded: ['real'] };
        const tournamentId = await seedTournament(roomId, legacy);

        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
        const names = (res.body.games ?? res.body.availableGames ?? res.body).map((g: any) => g.name);
        expect(names).toContain('Who Dunnit');

        expect(passesplatformRules(
            ['vpx', 'vpxs', 'real', 'atgames'], normalizeTournamentRulesInput(legacy), [],
        )).toBe(true);
    });

    it('still hides a game whose EVERY platform is excluded (nothing submittable)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom(`r4b-${Date.now()}`);
        await seedCatalogue('Real Only Classic', ['real']);
        // No `required` — the game is eligible on paper, but `real` is the
        // sole platform and it's excluded: pickable-but-never-scorable.
        const legacy = { required: [], excluded: ['real'] };
        const tournamentId = await seedTournament(roomId, legacy);

        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
        const names = (res.body.games ?? res.body.availableGames ?? res.body).map((g: any) => g.name);
        expect(names).not.toContain('Real Only Classic');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PHASE'S ACCEPTANCE TEST
// ─────────────────────────────────────────────────────────────────────────────

describe("an AtGames-only game is no longer locked to Unspecified", () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('offers AtGames Native in the picker and validates the submission', async () => {
        // THE bug this phase exists to kill. Before the fold, an AtGames-only
        // game had `platforms: ['atgames']`, which maps to engine UNKNOWN, so
        // `enginesFromLegacyPlatforms` returned `['unknown']` and the submit
        // sheet auto-locked "Unspecified" — a score with no comparability at
        // all, on a room whose entire community is AtGames-first.
        await seedCatalogue('AtGames Only', ['atgames'], ['atgames_4k']);
        await foldCatalogueToEngines(await getDatabase());

        const db = await getDatabase();
        const row = await db.get('SELECT platforms, features FROM global_games WHERE name = ?', 'AtGames Only');
        expect(JSON.parse(row.platforms)).toEqual(['atgames_native']);
        expect(JSON.parse(row.features)).toEqual(['atgames_4k', 'atgames']);

        const roomId = await createTestRoom(`r-${Date.now()}`);
        const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, 'AtGames Only');

        const engines = ScoreProvenanceService.enginesFor(scope);
        expect(engines).toEqual(['atgames_native']);
        expect(engines).not.toContain('unknown');

        expect(ScoreProvenanceService.devicesFor(scope, 'atgames_native')).toEqual(['atgames']);

        const validation = ScoreProvenanceService.validate(scope, 'atgames_native', 'atgames');
        expect(validation.ok).toBe(true);
        if (validation.ok) {
            expect(validation.engine).toBe('atgames_native');
            expect(validation.device).toBe('atgames');
            expect(validation.platform).toBe('atgames');
        }
    });

    it('keeps offering the AtGames device for a folded VPX-Standalone table', async () => {
        // The device half of the same move: `vpxs` used to imply device
        // `atgames` straight off the platform list. Post-fold the platform list
        // says only `vpx`, and the guarantee has to come from `features`.
        await seedCatalogue('Standalone VPX', ['vpx', 'vpxs']);
        await foldCatalogueToEngines(await getDatabase());

        const roomId = await createTestRoom(`r2-${Date.now()}`);
        const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, 'Standalone VPX');
        expect(scope.features).toContain('vpxs');
        expect(ScoreProvenanceService.devicesFor(scope, 'vpx')).toContain('atgames');
        expect(ScoreProvenanceService.validate(scope, 'vpx', 'atgames').ok).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two resolvers must agree (contract §4, last bullet)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/submit/platforms and ScoreProvenanceService agree', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('resolves the same platforms and features for a fixture game', async () => {
        // They duplicate resolution logic on purpose (unifying them is out of
        // scope for this phase), which is precisely why they need a test that
        // fails when one is taught something the other is not.
        const app = await createApp();
        const roomId = await createTestRoom(`r3-${Date.now()}`);
        await seedCatalogue('Fixture', ['vpx', 'vpxs', 'atgames'], ['atgames_hd']);
        await foldCatalogueToEngines(await getDatabase());

        const db = await getDatabase();
        await db.run(
            `INSERT INTO room_game_tags (game_room_id, global_game_id, tag) VALUES (?, 'gg-1', 'real')`,
            roomId,
        );

        const res = await request(app)
            .get('/api/submit/platforms')
            .query({ roomId, gameName: 'Fixture' });
        expect(res.status).toBe(200);

        const scope = await ScoreProvenanceService.resolveForRoomGame(roomId, 'Fixture');
        expect([...res.body.platforms].sort()).toEqual([...scope.effective].sort());
        expect([...res.body.submittable].sort()).toEqual([...scope.submittable].sort());
        expect([...res.body.features].sort()).toEqual([...scope.features].sort());

        // …and therefore on the derived option sets the two feed.
        const { enginesFromLegacyPlatforms, devicesForEngineAndPlatforms } =
            await import('../utils/scoreProvenance.js');
        expect(enginesFromLegacyPlatforms(res.body.submittable))
            .toEqual(ScoreProvenanceService.enginesFor(scope));
        expect(devicesForEngineAndPlatforms('vpx', res.body.submittable, res.body.features))
            .toEqual(ScoreProvenanceService.devicesFor(scope, 'vpx'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue filter paths (hazard H-D)
// ─────────────────────────────────────────────────────────────────────────────

describe('catalogueMatchTokens — one resolution for both filter paths', () => {
    it('resolves a legacy request onto folded rows', () => {
        expect(catalogueMatchTokens('atgames')).toContain('atgames_native');
        expect(catalogueMatchTokens('atgames')).toContain('atgames');
        expect(catalogueMatchTokens('pinball_fx_vr')).toContain('fx');
        expect(catalogueMatchTokens('vpxs')).toContain('vpx');
    });

    it('resolves an engine request onto legacy rows', () => {
        const fx = catalogueMatchTokens('fx');
        expect(fx).toContain('fx');
        expect(fx).toContain('pinball_fx');
        expect(fx).toContain('pinball_fx_vr');
        // …and does NOT sweep in the sibling engines the old `LIKE '%pinball_fx%'`
        // matched by accident.
        expect(fx).not.toContain('pinball_fx_classic');
        expect(fx).not.toContain('pinball_fx_midnight');
    });

    it('keeps an unrecognised token matching itself, never nothing', () => {
        expect(catalogueMatchTokens('some room tag')).toEqual(['some room tag']);
        expect(catalogueMatchTokens('')).toEqual([]);
    });

    it('finds a game by either vocabulary, before and after the fold', () => {
        // Both filter paths intersect this token set with `gg.platforms`, so
        // this is the property both surfaces inherit.
        for (const request of ['atgames', 'atgames_native']) {
            const tokens = new Set(catalogueMatchTokens(request));
            expect(tokens.has('atgames'), `${request} → legacy row`).toBe(true);
            expect(tokens.has('atgames_native'), `${request} → folded row`).toBe(true);
        }
    });
});
