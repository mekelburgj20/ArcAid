import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import {
    CANONICAL_ENGINES,
    CANONICAL_DEVICES,
    LEGACY_PLATFORM_MAP,
    UNKNOWN,
    enginesFromLegacyPlatforms,
    mapLegacyPlatform,
    isEngineDeviceCompatible,
} from '../utils/scoreProvenance.js';
import {
    legacyPlatformsForEngine,
    legacyPlatformsForDevice,
    normalizeCataloguePlatformId,
    passesplatformRules,
    parseTournamentRules,
} from '../utils/platformRules.js';
import { CANONICAL_PLATFORMS, normalizePlatform } from '../utils/platformMapping.js';

/**
 * ADR 0016 catalogue phase, Section 1 — taxonomy prerequisites.
 *
 * `global_games.platforms` is about to become an ENGINE list. Before any data
 * moves, engine ids have to be first-class citizens of the read paths that
 * classify a catalogue value, or the move silently breaks two things at once:
 *
 *   H-A — an engine id that is not a `LEGACY_PLATFORM_MAP` key reads as
 *         unknown/unknown, so the submit picker auto-locks "Unspecified" (the
 *         exact bug this phase exists to kill) and the engine's own id is
 *         missing from `legacyPlatformsForEngine(e)`, so a tournament requiring
 *         that engine admits zero games.
 *   H-B — the OLD taxonomy's `normalizePlatform` is an alias table over LEGACY
 *         ids, and `PLATFORM_ALIASES['fx'] = 'pinball_fx'`. Two runtime paths
 *         run catalogue values through it, so an engine id `fx` would be
 *         re-legacied before rules or pickers ever saw it.
 *
 * Everything here must hold while the catalogue is STILL legacy — the identity
 * mappings are additive, and the assertions below pin that they change nothing
 * about how a legacy id resolves.
 */

// ─────────────────────────────────────────────────────────────────────────────
// H-A — engine ids are first-class
// ─────────────────────────────────────────────────────────────────────────────

describe('canonical engine ids resolve as themselves', () => {
    it('maps every engine id to itself', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            const prov = LEGACY_PLATFORM_MAP[id];
            expect(prov, `engine "${id}" is not a LEGACY_PLATFORM_MAP key`).toBeDefined();
            expect(prov.engine, id).toBe(id);
            // The pair must satisfy the parity suite's compat invariant.
            expect(isEngineDeviceCompatible(prov.engine, prov.device), id).toBe(true);
        }
    });

    it('adds the four missing ids with NO device claim, and disturbs no other key', () => {
        // These four existed only in the new taxonomy — the map held their
        // legacy spellings alone. Device is `unknown` by construction: an
        // engine id names what PRODUCED a score and asserts nothing about
        // hardware. That also satisfies the parity suite's compat invariant
        // for free, since `unknown` on either axis is "no claim", never a
        // wrong claim.
        for (const id of ['fx_classic', 'fx_midnight', 'star_wars', 'atgames_native']) {
            expect(LEGACY_PLATFORM_MAP[id], id).toEqual({ engine: id, device: UNKNOWN });
        }
        // The ids that were ALREADY keys keep the device half they always
        // carried — `real` has meant real+real_cabinet since P1, and `pc`
        // exists in both namespaces (taxonomy header, H-H).
        expect(LEGACY_PLATFORM_MAP.real).toEqual({ engine: 'real', device: 'real_cabinet' });
        expect(LEGACY_PLATFORM_MAP.pc).toEqual({ engine: 'pc', device: 'pc' });
        expect(LEGACY_PLATFORM_MAP.vpx).toEqual({ engine: 'vpx', device: UNKNOWN });
        expect(LEGACY_PLATFORM_MAP.fx).toEqual({ engine: 'fx', device: UNKNOWN });
    });

    it('round-trips an engine-only catalogue list through the picker resolver', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            expect(enginesFromLegacyPlatforms([id]), id).toEqual([id]);
        }
        // The phase's motivating case: an AtGames-only game offers a real engine
        // choice instead of auto-locking Unspecified.
        expect(enginesFromLegacyPlatforms(['atgames_native'])).toEqual(['atgames_native']);
        expect(enginesFromLegacyPlatforms(['fx_classic', 'fx'])).toEqual(['fx_classic', 'fx']);
        // …while the legacy id it replaces still resolves exactly as before.
        expect(enginesFromLegacyPlatforms(['atgames'])).toEqual([UNKNOWN]);
    });

    it('puts every canonical engine and device in its own expansion set', () => {
        // A rule token is matched by exact membership over its expansion set, so
        // an id missing from its OWN set matches nothing.
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            expect(legacyPlatformsForEngine(id), id).toContain(id);
        }
        for (const id of Object.keys(CANONICAL_DEVICES)) {
            expect(legacyPlatformsForDevice(id), id).toContain(id);
        }
        // Expansion still carries the legacy spellings — this is additive.
        expect(legacyPlatformsForEngine('fx_classic')).toEqual(
            expect.arrayContaining(['fx_classic', 'pinball_fx_classic', 'pinball_fx_classic_vr', 'fx3']),
        );
        expect(legacyPlatformsForDevice('atgames')).toEqual(
            expect.arrayContaining(['atgames', 'vpxs', 'vpxs_manual']),
        );
        expect(legacyPlatformsForDevice('real_cabinet')).toEqual(
            expect.arrayContaining(['real_cabinet', 'real', 'irl']),
        );
        // `unknown` is the no-claim value and must never behave as a rule.
        expect(legacyPlatformsForEngine(UNKNOWN)).toEqual([]);
        expect(legacyPlatformsForDevice(UNKNOWN)).toEqual([]);
    });

    it('leaves every legacy spelling resolving exactly as it did', () => {
        // The identity mappings sit alongside the legacy ids they will one day
        // replace; none of these may shift.
        expect(mapLegacyPlatform('atgames')).toEqual({ engine: UNKNOWN, device: 'atgames' });
        expect(mapLegacyPlatform('vpxs')).toEqual({ engine: 'vpx', device: 'atgames' });
        expect(mapLegacyPlatform('vpxs_manual')).toEqual({ engine: 'vpx', device: 'atgames' });
        expect(mapLegacyPlatform('bam')).toEqual({ engine: 'fp', device: UNKNOWN });
        expect(mapLegacyPlatform('pinball_fx')).toEqual({ engine: 'fx', device: UNKNOWN });
        expect(mapLegacyPlatform('pinball_fx_vr')).toEqual({ engine: 'fx', device: 'vr_headset' });
        expect(mapLegacyPlatform('pinball_fx_classic')).toEqual({ engine: 'fx_classic', device: UNKNOWN });
        expect(mapLegacyPlatform('pinball_fx_classic_vr')).toEqual({ engine: 'fx_classic', device: 'vr_headset' });
        expect(mapLegacyPlatform('pinball_fx_midnight')).toEqual({ engine: 'fx_midnight', device: UNKNOWN });
        expect(mapLegacyPlatform('star_wars_pinball_vr')).toEqual({ engine: 'star_wars', device: 'vr_headset' });
        expect(mapLegacyPlatform('zaccaria_vr')).toEqual({ engine: 'zaccaria', device: 'vr_headset' });
        expect(mapLegacyPlatform('real')).toEqual({ engine: 'real', device: 'real_cabinet' });
        // And an unrecognised token is still unknown/unknown, not an engine.
        expect(mapLegacyPlatform('fx2')).toEqual({ engine: UNKNOWN, device: UNKNOWN });
    });

    it('keeps today\'s dominant rule gating a legacy catalogue identically', () => {
        // `required: ['atgames']` lifts to the DEVICE axis and is the single most
        // common production rule. The identity mappings must not widen it.
        const rules = parseTournamentRules(JSON.stringify({ required: ['atgames'], excluded: [] }));
        expect(passesplatformRules(['atgames'], rules)).toBe(true);
        expect(passesplatformRules(['vpx', 'vpxs'], rules)).toBe(true);
        expect(passesplatformRules(['vpx'], rules)).toBe(false);
        expect(passesplatformRules(['pinball_fx'], rules)).toBe(false);
        // An engine id in the catalogue does NOT acquire a device claim it never
        // made — `atgames_native` is an engine, `atgames` is the device.
        expect(passesplatformRules(['atgames_native'], rules)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-B — the `normalizePlatform` alias trap
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCataloguePlatformId (H-B)', () => {
    it('passes canonical engine ids through untouched', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            expect(normalizeCataloguePlatformId(id), id).toBe(id);
        }
        // The trap itself: the old alias table folds `fx` onto the legacy id.
        expect(normalizePlatform('fx')).toBe('pinball_fx');
        expect(normalizeCataloguePlatformId('fx')).toBe('fx');
        expect(normalizeCataloguePlatformId('  FX  ')).toBe('fx');
    });

    it('normalizes every legacy id exactly as the old fold did', () => {
        // The whole point of the guard is that TODAY'S data is untouched: every
        // legacy catalogue id, alias spelling and free-form tag must come out
        // the other side identical to `normalizePlatform`.
        const legacyTokens = [
            ...Object.keys(CANONICAL_PLATFORMS),
            'ATGAMES', 'VPXS', 'vpxs-manual', 'vpx standalone', 'vpx standalone (manual install)',
            'irl', 'real machine', 'physical', 'visual pinball x', 'visual pinball 9',
            'future pinball', 'pinball fx', 'pinball fx3', 'fx3', 'pinball_fx3',
            'pinball fx classic', 'pinball fx classic vr', 'pinball fx 2 vr', 'pinball fx2 vr',
            'fx 2 vr', 'pinball fx midnight', 'pinball m', 'pinball_m', 'pinball fx vr',
            'star wars pinball vr', 'zaccaria pinball', 'zaccaria vr', 'zaccaria pinball vr',
            'playstation', 'playstation 2', 'game boy advance', 'sega genesis', 'sega saturn',
            'sega master system', 'sega cd', 'sega game gear', 'nintendo 64', 'nintendo switch',
            'turbografx-16', 'turbografx16', 'atari 2600', 'atari 7800', 'atari jaguar',
            // Free-form room tags and junk: verbatim-lowercase, unchanged.
            'fx2', 'my-house-rules', 'Beta Cab',
        ];
        for (const token of legacyTokens) {
            if (token === 'fx') continue; // the one deliberate divergence, asserted above
            expect(normalizeCataloguePlatformId(token), token).toBe(normalizePlatform(token));
        }
    });

    it('returns empty for nothing', () => {
        expect(normalizeCataloguePlatformId('')).toBe('');
        expect(normalizeCataloguePlatformId(null)).toBe('');
        expect(normalizeCataloguePlatformId(undefined)).toBe('');
        expect(normalizeCataloguePlatformId('   ')).toBe('');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-B at the two runtime paths that fold catalogue values
// ─────────────────────────────────────────────────────────────────────────────

describe('catalogue-value folding at the runtime paths', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function seedGame(id: string, name: string, platforms: string[]) {
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO global_games (id, name, type, platforms, status)
             VALUES (?, ?, 'pinball', ?, 'approved')`,
            id, name, JSON.stringify(platforms),
        );
        return id;
    }

    async function roomsApp() {
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    async function globalApp() {
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('GET /:roomId/platforms/available keeps engine ids and folds legacy ones', async () => {
        const roomId = await createTestRoom('pa-engines', 'Platforms Available');
        await seedGame('gg-engine', 'Engine Row', ['fx', 'atgames_native']);
        await seedGame('gg-legacy', 'Legacy Row', ['pinball_fx', 'VPXS', 'vpx']);

        const res = await request(await roomsApp()).get(`/api/rooms/${roomId}/platforms/available`);

        expect(res.status).toBe(200);
        // Engine ids survive the fold…
        expect(res.body.platforms).toContain('fx');
        expect(res.body.platforms).toContain('atgames_native');
        // …and legacy ids fold exactly as they always did (case-folded, aliased).
        expect(res.body.platforms).toContain('pinball_fx');
        expect(res.body.platforms).toContain('vpxs');
        expect(res.body.platforms).toContain('vpx');
    });

    it('GET /:roomId/platforms/available folds room tags the same way', async () => {
        const roomId = await createTestRoom('pa-tags', 'Platforms Tags');
        const gameId = await seedGame('gg-tagged', 'Tagged Row', ['vpx']);
        const { RoomGameTagsService } = await import('../services/RoomGameTagsService.js');
        await RoomGameTagsService.addTag(roomId, gameId, 'fx');
        await RoomGameTagsService.addTag(roomId, gameId, 'ATGAMES');

        const res = await request(await roomsApp()).get(`/api/rooms/${roomId}/platforms/available`);

        expect(res.status).toBe(200);
        expect(res.body.platforms).toContain('fx');       // engine id, untouched
        expect(res.body.platforms).toContain('atgames');  // legacy tag, folded
        expect(res.body.platforms).not.toContain('pinball_fx');
    });

    it('GET /api/submit/platforms ships engine ids to the picker unchanged', async () => {
        await seedGame('gg-submit', 'Submit Row', ['fx', 'vpx']);

        const res = await request(await globalApp())
            .get('/api/submit/platforms').query({ globalGameId: 'gg-submit' });

        expect(res.status).toBe(200);
        expect(res.body.platforms).toEqual(['fx', 'vpx']);
        expect(res.body.submittable).toEqual(['fx', 'vpx']);
        // Pre-fix this shipped `pinball_fx` — an engine id re-legacied on its
        // way to the surface that is being taught to speak engines.
        expect(res.body.platforms).not.toContain('pinball_fx');
    });

    it('GET /api/submit/platforms still folds a legacy catalogue row identically', async () => {
        await seedGame('gg-submit-legacy', 'Submit Legacy', ['VPX', 'vpxs', 'pinball_fx', 'ATGAMES']);

        const res = await request(await globalApp())
            .get('/api/submit/platforms').query({ globalGameId: 'gg-submit-legacy' });

        expect(res.status).toBe(200);
        expect(res.body.platforms).toEqual(['vpx', 'vpxs', 'pinball_fx', 'atgames']);
    });

    it('GET /api/submit/platforms unions room tags without re-legacying engines', async () => {
        const roomId = await createTestRoom('sp-union', 'Submit Union');
        const gameId = await seedGame('gg-union', 'Union Row', ['vpx']);
        const { RoomGameTagsService } = await import('../services/RoomGameTagsService.js');
        await RoomGameTagsService.addTag(roomId, gameId, 'fx');

        const res = await request(await globalApp())
            .get('/api/submit/platforms').query({ roomId, gameName: 'Union Row' });

        expect(res.status).toBe(200);
        expect(res.body.platforms).toEqual(['vpx', 'fx']);
        expect(res.body.submittable).toEqual(['vpx', 'fx']);
    });
});
