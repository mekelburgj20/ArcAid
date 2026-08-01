import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import {
    parseTournamentRules,
    normalizeTournamentRulesInput,
    liftLegacyPlatformIds,
    passesplatformRules,
    resolveSubmittablePlatforms,
    legacyPlatformsForEngine,
    legacyPlatformsForDevice,
    emptyTournamentRules,
    hasAnyPlatformRules,
    hasGameLevelPlatformRules,
    type TournamentRules,
} from '../utils/platformRules.js';
import { LEGACY_PLATFORM_MAP, UNKNOWN } from '../utils/scoreProvenance.js';

/**
 * ADR 0016 P2 — Section 2: `platform_rules` moves onto two axes.
 *
 * The risk this file exists to hold down is not "does the new shape work" but
 * "does the OLD shape keep working". ~200 live rooms store the pre-0016 flat
 * blob; nothing migrates them. `parseTournamentRules` lifts at read time, and a
 * lift that loses a restriction turns a tournament silently wide open — the
 * exact failure mode Section 1 was built to make visible.
 *
 * ADR 0009's orthogonality is unchanged and asserted here per axis:
 *   `required` — game eligibility only, NEVER a picker filter.
 *   `excluded` — picker/submission filter only, NEVER an eligibility gate.
 */

const legacy = (required: string[], excluded: string[] = []) =>
    JSON.stringify({ required, excluded });

const twoAxis = (rules: {
    engines?: { required?: string[]; excluded?: string[] };
    devices?: { required?: string[]; excluded?: string[] };
}) => JSON.stringify({
    engines: { required: [], excluded: [], ...(rules.engines ?? {}) },
    devices: { required: [], excluded: [], ...(rules.devices ?? {}) },
});

// ─────────────────────────────────────────────────────────────────────────────
// The lift table
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy → two-axis lift', () => {
    it('puts an engine-only id on the engine axis alone', () => {
        expect(liftLegacyPlatformIds(['vpx'])).toEqual({ engines: ['vpx'], devices: [] });
        expect(liftLegacyPlatformIds(['pinball_fx'])).toEqual({ engines: ['fx'], devices: [] });
        // BAM is a table requirement, not an engine (ADR 0016) — it is the `fp`
        // engine, and carries no device claim.
        expect(liftLegacyPlatformIds(['bam'])).toEqual({ engines: ['fp'], devices: [] });
        expect(liftLegacyPlatformIds(['snes'])).toEqual({ engines: ['snes'], devices: [] });
    });

    it('puts a device-only id on the device axis alone', () => {
        // An AtGames cabinet runs VPX, FX, Zaccaria and AtGames-native tables,
        // so `atgames` makes no engine claim at all.
        expect(liftLegacyPlatformIds(['atgames'])).toEqual({ engines: [], devices: ['atgames'] });
        expect(liftLegacyPlatformIds(['vr'])).toEqual({ engines: [], devices: ['vr_headset'] });
    });

    it('puts a dual-axis id on BOTH axes — dropping the device half would widen the rule', () => {
        expect(liftLegacyPlatformIds(['vpxs'])).toEqual({ engines: ['vpx'], devices: ['atgames'] });
        expect(liftLegacyPlatformIds(['vpxs_manual'])).toEqual({ engines: ['vpx'], devices: ['atgames'] });
        expect(liftLegacyPlatformIds(['real'])).toEqual({ engines: ['real'], devices: ['real_cabinet'] });
        expect(liftLegacyPlatformIds(['pinball_fx_vr'])).toEqual({ engines: ['fx'], devices: ['vr_headset'] });
        expect(liftLegacyPlatformIds(['pinball_fx_classic_vr'])).toEqual({ engines: ['fx_classic'], devices: ['vr_headset'] });
        expect(liftLegacyPlatformIds(['zaccaria_vr'])).toEqual({ engines: ['zaccaria'], devices: ['vr_headset'] });
        expect(liftLegacyPlatformIds(['star_wars_pinball_vr'])).toEqual({ engines: ['star_wars'], devices: ['vr_headset'] });
        expect(liftLegacyPlatformIds(['pc'])).toEqual({ engines: ['pc'], devices: ['pc'] });
    });

    it('a dual-axis id restricts BOTH axes once parsed', () => {
        const rules = parseTournamentRules(legacy(['vpxs']), 't-dual');
        expect(rules.engines.required).toEqual(['vpx']);
        expect(rules.devices.required).toEqual(['atgames']);
        // Both halves bite: VPX-on-PC fails the device half, AtGames-FX fails
        // the engine half, VPX-on-AtGames passes both.
        expect(passesplatformRules(['vpx'], rules)).toBe(false);
        expect(passesplatformRules(['atgames'], rules)).toBe(false);
        expect(passesplatformRules(['vpxs'], rules)).toBe(true);
        expect(passesplatformRules(['vpx', 'atgames'], rules)).toBe(true);
    });

    it('de-duplicates and lower-cases, so mixed-case production data still lifts', () => {
        expect(liftLegacyPlatformIds(['VPX', 'vpxs', 'VPXS'])).toEqual({
            engines: ['vpx'], devices: ['atgames'],
        });
        expect(liftLegacyPlatformIds(['ATGAMES'])).toEqual({ engines: [], devices: ['atgames'] });
    });

    it('keeps an unrecognised id verbatim on the engine axis rather than dropping it', () => {
        // Rooms can tag games with arbitrary strings, and those reach
        // platform_rules. Dropping the token would turn a restriction into
        // "restricts nothing" — the one outcome the shim must never produce.
        const rules = parseTournamentRules(legacy(['steam']), 't-custom');
        expect(rules.engines.required).toEqual(['steam']);
        expect(legacyPlatformsForEngine('steam')).toEqual(['steam']);
        expect(passesplatformRules(['steam'], rules)).toBe(true);
        expect(passesplatformRules(['vpx'], rules)).toBe(false);
    });

    it('every canonical legacy platform id has a defensible lift', () => {
        // Blocker check from the contract: no id may lift to nothing on both
        // axes. `LEGACY_PLATFORM_MAP` is the taxonomy P1 established, so this
        // guards it against a future entry landing as unknown/unknown.
        for (const [id, prov] of Object.entries(LEGACY_PLATFORM_MAP)) {
            const lifted = liftLegacyPlatformIds([id]);
            expect(
                lifted.engines.length + lifted.devices.length,
                `legacy id "${id}" lifted to nothing`,
            ).toBeGreaterThan(0);
            if (prov.engine !== UNKNOWN) expect(lifted.engines).toContain(prov.engine);
            if (prov.device !== UNKNOWN) expect(lifted.devices).toContain(prov.device);
        }
    });

    it('expands a rule token back to every legacy id it denotes', () => {
        expect(legacyPlatformsForEngine('vpx')).toEqual(expect.arrayContaining(['vpx', 'vpxs', 'vpxs_manual']));
        expect(legacyPlatformsForDevice('atgames')).toEqual(expect.arrayContaining(['atgames', 'vpxs', 'vpxs_manual']));
        // `unknown` is the explicit no-claim value and must never act as a rule.
        expect(legacyPlatformsForEngine(UNKNOWN)).toEqual([]);
        expect(legacyPlatformsForDevice(UNKNOWN)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A legacy row and its lifted equivalent are indistinguishable
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy row ≡ its lifted equivalent', () => {
    /** Catalogue shapes spanning every axis combination that exists in prod. */
    const GAMES: string[][] = [
        ['vpx'],
        ['vpxs'],
        ['atgames'],
        ['vpx', 'atgames'],
        ['real'],
        ['pinball_fx'],
        ['pinball_fx_vr'],
        ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'], // WHO dunnit
        ['snes'],
        [],
    ];

    /** (legacy blob, the two-axis blob it must be identical to). */
    const PAIRS: Array<[string, string]> = [
        [legacy(['atgames']), twoAxis({ devices: { required: ['atgames'] } })],
        [legacy(['vpx']), twoAxis({ engines: { required: ['vpx'] } })],
        [legacy(['vpxs']), twoAxis({ engines: { required: ['vpx'] }, devices: { required: ['atgames'] } })],
        [legacy(['real']), twoAxis({ engines: { required: ['real'] }, devices: { required: ['real_cabinet'] } })],
        [legacy([], ['atgames']), twoAxis({ devices: { excluded: ['atgames'] } })],
        [legacy([], ['real']), twoAxis({ engines: { excluded: ['real'] }, devices: { excluded: ['real_cabinet'] } })],
        [
            legacy(['atgames'], ['real']),
            twoAxis({
                engines: { excluded: ['real'] },
                devices: { required: ['atgames'], excluded: ['real_cabinet'] },
            }),
        ],
        [legacy(['pinball_fx_vr']), twoAxis({ engines: { required: ['fx'] }, devices: { required: ['vr_headset'] } })],
    ];

    it('parses to the identical rules object', () => {
        for (const [legacyBlob, liftedBlob] of PAIRS) {
            expect(parseTournamentRules(legacyBlob, 't-a')).toEqual(parseTournamentRules(liftedBlob, 't-b'));
        }
    });

    it('admits the same games and offers the same picker for every catalogue shape', () => {
        for (const [legacyBlob, liftedBlob] of PAIRS) {
            const fromLegacy = parseTournamentRules(legacyBlob, 't-a');
            const fromLifted = parseTournamentRules(liftedBlob, 't-b');
            for (const platforms of GAMES) {
                expect(
                    passesplatformRules(platforms, fromLegacy),
                    `eligibility diverged for ${legacyBlob} on ${JSON.stringify(platforms)}`,
                ).toBe(passesplatformRules(platforms, fromLifted));
                expect(
                    resolveSubmittablePlatforms(platforms, fromLegacy),
                    `picker diverged for ${legacyBlob} on ${JSON.stringify(platforms)}`,
                ).toEqual(resolveSubmittablePlatforms(platforms, fromLifted));
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0009's orthogonality, per axis and across axes
// ─────────────────────────────────────────────────────────────────────────────

describe('axis semantics', () => {
    const WHO_DUNNIT = ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'];

    it('combines the two axes with AND for eligibility', () => {
        // "FX titles on AtGames devices only" — ADR 0016's worked example.
        const rules = parseTournamentRules(
            twoAxis({ engines: { required: ['fx'] }, devices: { required: ['atgames'] } }), 't-and',
        );
        expect(passesplatformRules(['pinball_fx', 'atgames'], rules)).toBe(true);
        // FX but no AtGames → fails the device half.
        expect(passesplatformRules(['pinball_fx'], rules)).toBe(false);
        // AtGames but no FX → fails the engine half.
        expect(passesplatformRules(['atgames'], rules)).toBe(false);
        expect(passesplatformRules([], rules)).toBe(false);
    });

    it('ORs within an axis', () => {
        const rules = parseTournamentRules(
            twoAxis({ engines: { required: ['vpx', 'fx'] } }), 't-or',
        );
        expect(passesplatformRules(['vpx'], rules)).toBe(true);
        expect(passesplatformRules(['pinball_fx'], rules)).toBe(true);
        expect(passesplatformRules(['zaccaria'], rules)).toBe(false);
    });

    it('`required` never filters the picker — on either axis', () => {
        const rules = parseTournamentRules(
            twoAxis({ engines: { required: ['fx'] }, devices: { required: ['atgames'] } }), 't-req',
        );
        // The whole of ADR 0009: a game admitted under a Must rule stays fully
        // scorable on every platform it ships on.
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, rules)).toEqual(WHO_DUNNIT);
    });

    it('`excluded` never affects eligibility — on either axis', () => {
        const rules = parseTournamentRules(
            twoAxis({ engines: { excluded: ['vpx'] }, devices: { excluded: ['atgames'] } }), 't-exc',
        );
        // No `required` anywhere, so nothing is filtered out of the tournament...
        expect(passesplatformRules(['vpx'], rules)).toBe(true);
        expect(passesplatformRules(['atgames'], rules)).toBe(true);
        expect(passesplatformRules(WHO_DUNNIT, rules)).toBe(true);
        // ...but the picker loses every VPX-engine and every AtGames-device id.
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, rules))
            .toEqual(['real', 'pinball_fx', 'pinball_fx_vr']);
    });

    it('strips a platform when EITHER axis excludes it', () => {
        const engineOnly = parseTournamentRules(twoAxis({ engines: { excluded: ['fx'] } }), 't-e');
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, engineOnly))
            .toEqual(['vpx', 'vpxs', 'real', 'atgames']);

        const deviceOnly = parseTournamentRules(twoAxis({ devices: { excluded: ['vr_headset'] } }), 't-d');
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, deviceOnly))
            .toEqual(['vpx', 'vpxs', 'real', 'pinball_fx', 'atgames']);
    });

    it('no rules means no restriction', () => {
        const none = emptyTournamentRules();
        expect(hasAnyPlatformRules(none)).toBe(false);
        expect(hasGameLevelPlatformRules(none)).toBe(false);
        expect(passesplatformRules([], none)).toBe(true);
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, none)).toEqual(WHO_DUNNIT);
        // `null` rules (no active tournament) is a distinct, wider case.
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, null)).toEqual(WHO_DUNNIT);
    });

    it('reports which kind of rule is present', () => {
        const excludedOnly = parseTournamentRules(twoAxis({ devices: { excluded: ['atgames'] } }), 't-x');
        expect(hasAnyPlatformRules(excludedOnly)).toBe(true);
        // `excluded` is submission-level, so it is NOT a game-level rule.
        expect(hasGameLevelPlatformRules(excludedOnly)).toBe(false);

        const requiredOnly = parseTournamentRules(twoAxis({ devices: { required: ['atgames'] } }), 't-r');
        expect(hasGameLevelPlatformRules(requiredOnly)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Writers emit the new shape
// ─────────────────────────────────────────────────────────────────────────────

describe('writers emit the two-axis shape', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('the Zod tournament schema lifts a legacy payload instead of rejecting it', async () => {
        const { CreateTournamentSchema } = await import('../api/schemas.js');
        const parsed = CreateTournamentSchema.parse({
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Legacy Client',
            type: 'LC',
            cadence: { cron: '0 0 * * *', autoRotate: true, autoLock: true },
            platform_rules: { required: ['vpxs'], excluded: ['real'], restrictedText: 'note' },
        });
        expect(parsed.platform_rules).toEqual({
            engines: { required: ['vpx'], excluded: ['real'] },
            devices: { required: ['atgames'], excluded: ['real_cabinet'] },
            restrictedText: 'note',
        });
    });

    it('the schema passes an already-two-axis payload through unchanged', async () => {
        const { UpdateTournamentSchema } = await import('../api/schemas.js');
        const parsed = UpdateTournamentSchema.parse({
            name: 'New Client',
            type: 'NC',
            cadence: { cron: '0 0 * * *', autoRotate: true, autoLock: true },
            platform_rules: {
                engines: { required: ['fx'], excluded: [] },
                devices: { required: ['atgames'], excluded: [] },
            },
        });
        expect(parsed.platform_rules).toEqual({
            engines: { required: ['fx'], excluded: [] },
            devices: { required: ['atgames'], excluded: [] },
            restrictedText: '',
        });
    });

    it('TournamentService persists the new shape even for a legacy-shaped call', async () => {
        const { TournamentService } = await import('../services/TournamentService.js');
        const roomId = await createTestRoom('writer-room', 'Writer Room');
        await TournamentService.create({
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Writer',
            type: 'W',
            cadence: { cron: '0 0 * * *' },
            platform_rules: { required: ['atgames'], excluded: [] },
            game_room_id: roomId,
        });

        const db = await getDatabase();
        const row = await db.get(
            'SELECT platform_rules FROM tournaments WHERE id = ?',
            '22222222-2222-4222-8222-222222222222',
        );
        expect(JSON.parse(row.platform_rules)).toEqual({
            engines: { required: [], excluded: [] },
            devices: { required: ['atgames'], excluded: [] },
        });
    });

    it('getAll ships the lifted shape for a row still stored flat', async () => {
        const { TournamentService } = await import('../services/TournamentService.js');
        const roomId = await createTestRoom('read-room', 'Read Room');
        const tournamentId = await createTestTournament(roomId, { name: 'Stored Legacy' });
        const db = await getDatabase();
        // Write the flat blob straight to the column, bypassing the service —
        // this is exactly what the ~200 live rooms have.
        await db.run(
            'UPDATE tournaments SET platform_rules = ? WHERE id = ?',
            legacy(['vpxs'], ['real']), tournamentId,
        );

        const rows = await TournamentService.getAll(roomId);
        const row = rows.find((r: any) => r.id === tournamentId)!;
        expect(JSON.parse(row.platform_rules)).toEqual({
            engines: { required: ['vpx'], excluded: ['real'] },
            devices: { required: ['atgames'], excluded: ['real_cabinet'] },
        });
        // The stored row is untouched — this is a read shim, not a migration.
        const stored = await db.get('SELECT platform_rules FROM tournaments WHERE id = ?', tournamentId);
        expect(JSON.parse(stored.platform_rules)).toEqual({ required: ['vpxs'], excluded: ['real'] });
    });

    it('normalizeTournamentRulesInput degrades non-objects to no rules', () => {
        const none: TournamentRules = emptyTournamentRules();
        expect(normalizeTournamentRulesInput(undefined)).toEqual(none);
        expect(normalizeTournamentRulesInput(null)).toEqual(none);
        expect(normalizeTournamentRulesInput('vpx')).toEqual(none);
        expect(normalizeTournamentRulesInput(['vpx'])).toEqual(none);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end: a legacy row and a lifted row gate a real route the same way
// ─────────────────────────────────────────────────────────────────────────────

describe('a stored legacy row gates a live route identically to a stored lifted row', () => {
    const MATCH = 'AtGames Only Game';
    const MISS = 'PC VPX Only Game';

    async function seed(slug: string, rulesJson: string) {
        const roomId = await createTestRoom(slug, `Room ${slug}`);
        const tournamentId = await createTestTournament(roomId, { name: `T ${slug}` });
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET platform_rules = ? WHERE id = ?', rulesJson, tournamentId);
        return { roomId, tournamentId };
    }

    beforeEach(async () => {
        await setupTestDb();
        const db = await getDatabase();
        const rows: Array<[string, string[]]> = [[MATCH, ['atgames']], [MISS, ['vpx']]];
        for (const [name, platforms] of rows) {
            await db.run(
                `INSERT OR REPLACE INTO global_games (id, name, type, platforms, status)
                 VALUES (?, ?, 'pinball', ?, 'approved')`,
                `gg-${name.toLowerCase().replace(/\W+/g, '-')}`, name, JSON.stringify(platforms),
            );
        }
    });

    it('returns the same game-availability list either way', async () => {
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        const flat = await seed('ee-flat', legacy(['atgames']));
        const lifted = await seed('ee-lifted', twoAxis({ devices: { required: ['atgames'] } }));

        const names = async (s: { roomId: string; tournamentId: string }) => {
            const res = await request(app)
                .get(`/api/rooms/${s.roomId}/game-availability/${s.tournamentId}`);
            expect(res.status).toBe(200);
            return res.body.games.map((g: any) => g.name).sort();
        };

        const fromFlat = await names(flat);
        expect(fromFlat).toContain(MATCH);
        expect(fromFlat).not.toContain(MISS);
        expect(fromFlat).toEqual(await names(lifted));
    });
});
