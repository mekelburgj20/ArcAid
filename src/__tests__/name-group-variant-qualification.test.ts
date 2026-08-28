import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { firstQualifyingVariant, type QualificationVariant } from '../utils/platformRules.js';

/**
 * v2.144.1 — the Walking Dead miss (live prod, found 2026-08-28).
 *
 * The catalogue can hold multiple APPROVED rows sharing one `name` — genuinely
 * different games/variants with the same title. Four eligibility readers used
 * to collapse those rows with `GROUP BY LOWER(name)` + `MIN()`-per-column SQL.
 * `MIN()` is per-COLUMN and lexicographic, so the "collapsed" row could pair
 * one variant's `platforms` with a DIFFERENT variant's `features` — a
 * chimera neither actual catalogue row has. That silently hid The Walking
 * Dead's Zen Studios FX Classic VR variant from a VR tournament even though it
 * fully qualifies on its own.
 *
 * The fix: a name-group qualifies iff at least ONE variant qualifies on its
 * own merits (platforms + features from the SAME row); room tags apply to
 * every variant equally (a fact about the name, not one row). This file pins
 * that at the shared helper (`firstQualifyingVariant` in
 * `src/utils/platformRules.ts`) and at each of the four call sites.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the live Walking Dead shape, plus the anti-cross-mix pair.
// ─────────────────────────────────────────────────────────────────────────────

const WALKING_DEAD = 'The Walking Dead';
/** VR tournament rules from ADR 0019: engines ∪ devices, both `required`. */
const VR_RULES = {
    engines: { required: ['zaccaria', 'fx_classic', 'star_wars', 'fx'], excluded: [] },
    devices: { required: ['vr_headset'], excluded: [] },
};

/** Row A — the "Original" VPX fan table. Has NO fx_classic VR evidence. */
const VARIANT_A = { platforms: ['vpx', 'fx_classic'], features: ['dt only', 'no rom', 'vr'], manufacturer: 'Original', year: 2016 };
/** Row B — the Zen Studios FX Classic release. The ADR 0019 evidence row. */
const VARIANT_B = { platforms: ['fx_classic'], features: ['vr', 'fx_classic_vr'], manufacturer: 'Zen Studios', year: null as number | null };

const ANTI_MIX = 'Anti Mix Table';
// Distinct manufacturer/year on C vs D — same as the live Walking Dead pair —
// so both rows coexist under the `idx_global_games_identity` UNIQUE index
// (ADR 0004: same-name rows from different manufacturers are allowed to
// coexist; true (name, type, mfg, year) dupes are what it rejects).
/** Row C — carries the engine (fx_classic) but NO VR evidence feature. */
const VARIANT_C = { platforms: ['fx'], features: [] as string[], manufacturer: 'Studio C', year: 2020 };
/** Row D — carries VR evidence but on an engine `VR_RULES` doesn't require. */
const VARIANT_D = { platforms: ['vpx'], features: ['fx_vr'], manufacturer: 'Studio D', year: 2021 };

let seq = 0;

async function seedCatalogue(name: string, variants: Array<{ platforms: string[]; features: string[]; manufacturer?: string | null; year?: number | null; type?: string }>) {
    const db = await getDatabase();
    const ids: string[] = [];
    for (const v of variants) {
        const id = `gg-${++seq}`;
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, platforms, features, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`,
            id, name, v.type ?? 'pinball', v.manufacturer ?? null, v.year ?? null,
            JSON.stringify(v.platforms), JSON.stringify(v.features),
        );
        ids.push(id);
    }
    return ids;
}

async function seedTournament(roomId: string, rules: unknown, mode = 'pinball') {
    const tournamentId = await createTestTournament(roomId, { name: 'T', mode });
    const db = await getDatabase();
    await db.run(
        'UPDATE tournaments SET platform_rules = ?, winner_picks = 1 WHERE id = ?',
        JSON.stringify(rules), tournamentId,
    );
    return tournamentId;
}

beforeEach(async () => {
    await setupTestDb();
    seq = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit level — the shared helper itself.
// ─────────────────────────────────────────────────────────────────────────────

describe('firstQualifyingVariant — the shared any-variant-qualifies helper', () => {
    it('qualifies a name-group when ANY ONE variant qualifies on its own', () => {
        const variants: QualificationVariant[] = [
            { mode: 'pinball', platforms: VARIANT_A.platforms, features: VARIANT_A.features },
            { mode: 'pinball', platforms: VARIANT_B.platforms, features: VARIANT_B.features },
        ];
        const result = firstQualifyingVariant(variants, 'pinball', VR_RULES as any, []);
        expect(result).not.toBeNull();
        // The qualifying variant must be B's own evidence — never a mix.
        expect(result?.platforms).toEqual(VARIANT_B.platforms);
        expect(result?.features).toEqual(VARIANT_B.features);
    });

    it('the anti-cross-mix pin: does NOT qualify when no single variant does, even though a column-mix would', () => {
        // C's platforms (fx) + D's features (fx_vr evidence) would, mixed,
        // look like a qualifying fx-engine-with-VR-evidence row. Neither row
        // alone is that.
        const variants: QualificationVariant[] = [
            { mode: 'pinball', platforms: VARIANT_C.platforms, features: VARIANT_C.features },
            { mode: 'pinball', platforms: VARIANT_D.platforms, features: VARIANT_D.features },
        ];
        const result = firstQualifyingVariant(variants, 'pinball', VR_RULES as any, []);
        expect(result).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 4 — services/PickQueueService.ts (checkPickQueueEligibility)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 4: checkPickQueueEligibility', () => {
    it('accepts a pick that qualifies through only ONE of several same-named catalogue variants', async () => {
        const roomId = await createTestRoom(`pq-wd-${++seq}`, 'PQ WD');
        await seedCatalogue(WALKING_DEAD, [VARIANT_A, VARIANT_B]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const { checkPickQueueEligibility } = await import('../services/PickQueueService.js');
        const result = await checkPickQueueEligibility({
            roomId, tournamentId, gameName: WALKING_DEAD, forUserId: '111111111111111111',
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.gameName).toBe(WALKING_DEAD);
    });

    it('the anti-cross-mix pin: rejects a pick when no single variant qualifies', async () => {
        const roomId = await createTestRoom(`pq-mix-${++seq}`, 'PQ Mix');
        await seedCatalogue(ANTI_MIX, [VARIANT_C, VARIANT_D]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const { checkPickQueueEligibility } = await import('../services/PickQueueService.js');
        const result = await checkPickQueueEligibility({
            roomId, tournamentId, gameName: ANTI_MIX, forUserId: '111111111111111111',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('PLATFORM_RESTRICTED');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 2 — discord/gameAutocomplete.ts (buildGameAutocompleteChoices)
// ─────────────────────────────────────────────────────────────────────────────

describe('site 2: buildGameAutocompleteChoices', () => {
    it('offers the name once when it qualifies through only one of several variants', async () => {
        const roomId = await createTestRoom(`ac-wd-${++seq}`, 'AC WD');
        await seedCatalogue(WALKING_DEAD, [VARIANT_A, VARIANT_B]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const { buildGameAutocompleteChoices } = await import('../discord/gameAutocomplete.js');
        const choices = await buildGameAutocompleteChoices(
            { id: tournamentId, mode: 'pinball', game_room_id: roomId, platform_rules: JSON.stringify(VR_RULES) },
            'walking',
        );

        const values = choices.map(c => c.value);
        expect(values.filter(v => v === WALKING_DEAD)).toHaveLength(1);
    });

    it('the anti-cross-mix pin: does not offer a name when no single variant qualifies', async () => {
        const roomId = await createTestRoom(`ac-mix-${++seq}`, 'AC Mix');
        await seedCatalogue(ANTI_MIX, [VARIANT_C, VARIANT_D]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const { buildGameAutocompleteChoices } = await import('../discord/gameAutocomplete.js');
        const choices = await buildGameAutocompleteChoices(
            { id: tournamentId, mode: 'pinball', game_room_id: roomId, platform_rules: JSON.stringify(VR_RULES) },
            'anti',
        );

        expect(choices.map(c => c.value)).not.toContain(ANTI_MIX);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site 1 — api/routes/rooms.ts GET /:roomId/game-availability/:tournamentId
// ─────────────────────────────────────────────────────────────────────────────

async function roomsApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

describe('site 1: GET /:roomId/game-availability/:tournamentId', () => {
    it('lists a name that qualifies through only one of several catalogue variants, shipping THAT variant\'s own evidence', async () => {
        const roomId = await createTestRoom(`ga-wd-${++seq}`, 'GA WD');
        await seedCatalogue(WALKING_DEAD, [VARIANT_A, VARIANT_B]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const app = await roomsApp();
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
        expect(res.status).toBe(200);

        const row = res.body.games.find((g: any) => g.name === WALKING_DEAD);
        expect(row).toBeDefined();
        // Ships the qualifying variant's OWN platforms/features — never a
        // MIN-mixed pair (e.g. A's platforms with B's features).
        expect(row.features).toEqual(expect.arrayContaining(['fx_classic_vr']));
        expect(row.platforms).toEqual(VARIANT_B.platforms);
    });

    it('the anti-cross-mix pin: does not list a name when no single variant qualifies', async () => {
        const roomId = await createTestRoom(`ga-mix-${++seq}`, 'GA Mix');
        await seedCatalogue(ANTI_MIX, [VARIANT_C, VARIANT_D]);
        const tournamentId = await seedTournament(roomId, VR_RULES);

        const app = await roomsApp();
        const res = await request(app).get(`/api/rooms/${roomId}/game-availability/${tournamentId}`);
        expect(res.status).toBe(200);

        const names = res.body.games.map((g: any) => g.name);
        expect(names).not.toContain(ANTI_MIX);
    });
});
