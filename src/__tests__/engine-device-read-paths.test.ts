import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { RoomScoresService } from '../services/RoomScoresService.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';
import {
    UNKNOWN,
    ENGINE_CATEGORY_LABELS,
    CANONICAL_ENGINES,
    CANONICAL_DEVICES,
    equivalentLegacyPlatforms,
    getEngineCategory,
    getEngineCategoryLabel,
    isDeviceInformative,
} from '../utils/scoreProvenance.js';

/**
 * ADR 0016 Phase 3 — read paths on engine/device, plus the fidelity categories.
 *
 * The load-bearing assertion in this file is the tab/filter agreement one:
 * before P3, `getDistinctPlatforms` alias-folded its values while
 * `getForGameByPlatform` compared raw strings, so the UI could offer a tab that
 * matched zero rows. Both halves now read the same columns, and the test below
 * proves it by feeding every offered value back through the filter.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

/**
 * Seed a score_history row with explicit provenance. `platform` is written too
 * because writers still maintain it in parallel — the point of several tests
 * here is that reads no longer depend on it.
 */
async function seedScore(opts: {
    roomId: string;
    tournamentId: string;
    gameName: string;
    username: string;
    score: number;
    engine: string;
    device: string;
    platform?: string | null;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            orphaned_at, created_at, platform, engine, device
         ) VALUES (?, ?, NULL, ?, ?, ?, 'tournament', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        opts.gameName, opts.roomId, opts.username, 'SYSTEM', opts.score,
        opts.roomId, opts.tournamentId, new Date().toISOString(),
        opts.platform ?? null, opts.engine, opts.device,
    );
}

/** A room + tournament + game with a deliberately mixed-provenance leaderboard. */
async function seedMixedGame() {
    const roomId = await createTestRoom();
    const tournamentId = await createTestTournament(roomId);
    const gameName = 'WHO dunnit';
    const gameId = await createTestGame(tournamentId, { name: gameName });
    const base = { roomId, tournamentId, gameName };

    // VPX on a PC, VPX on an AtGames cabinet — the ADR's worked example: same
    // engine, different devices, so they MUST share a leaderboard.
    await seedScore({ ...base, username: 'PcPlayer', score: 900, engine: 'vpx', device: 'pc', platform: 'vpx' });
    await seedScore({ ...base, username: 'CabPlayer', score: 800, engine: 'vpx', device: 'atgames', platform: 'vpxs' });
    // FX — a different engine, so NOT comparable.
    await seedScore({ ...base, username: 'FxPlayer', score: 700, engine: 'fx', device: 'pc', platform: 'pinball_fx' });
    // The irreducible AtGames row: device known, engine genuinely unknowable.
    await seedScore({ ...base, username: 'AtgPlayer', score: 600, engine: UNKNOWN, device: 'atgames', platform: 'atgames' });
    // A real machine.
    await seedScore({ ...base, username: 'RealPlayer', score: 500, engine: 'real', device: 'real_cabinet', platform: 'real' });

    return { roomId, tournamentId, gameId, gameName };
}

describe('fidelity categories (ADR 0016 §"derive from engine only")', () => {
    it('maps every canonical engine to exactly one documented band', () => {
        for (const [id, info] of Object.entries(CANONICAL_ENGINES)) {
            const label = getEngineCategoryLabel(id);
            expect(label, id).toBe(ENGINE_CATEGORY_LABELS[info.category]);
        }
        expect(getEngineCategoryLabel('real')).toBe('Real Machine');
        expect(getEngineCategoryLabel('vpx')).toBe('Simulation');
        expect(getEngineCategoryLabel('vp9')).toBe('Simulation');
        expect(getEngineCategoryLabel('fp')).toBe('Simulation');
        for (const e of ['fx', 'fx_classic', 'fx_midnight', 'zaccaria', 'star_wars', 'atgames_native']) {
            expect(getEngineCategoryLabel(e), e).toBe('Arcade-Style');
        }
    });

    it('gives the unknown engine NO category — never a guessed one', () => {
        // This is the assertion that protects 63 of ~120 production rows from
        // being silently filed into Simulation or Arcade-Style.
        expect(getEngineCategory(UNKNOWN)).toBeNull();
        expect(getEngineCategoryLabel(UNKNOWN)).toBeNull();
        expect(getEngineCategoryLabel(null)).toBeNull();
        expect(getEngineCategoryLabel('')).toBeNull();
        expect(getEngineCategoryLabel('atgames')).toBeNull(); // a device, not an engine
    });

    it('never lets the device influence the category', () => {
        for (const device of [...Object.keys(CANONICAL_DEVICES), UNKNOWN]) {
            expect(getEngineCategoryLabel('vpx'), device).toBe('Simulation');
            expect(getEngineCategoryLabel('fx'), device).toBe('Arcade-Style');
            expect(getEngineCategoryLabel(UNKNOWN), device).toBeNull();
        }
    });

    it('renames the video band away from the colliding "Arcade" word', () => {
        // `arcade` is a live engine id, so the band cannot share its name.
        expect(ENGINE_CATEGORY_LABELS.video).toBe('Video Games');
        expect(ENGINE_CATEGORY_LABELS.arcade_style).toBe('Arcade-Style');
        expect(getEngineCategoryLabel('arcade')).toBe('Video Games');
    });

    it('drops a device tag that carries no information', () => {
        expect(isDeviceInformative('real', 'real_cabinet')).toBe(false);
        expect(isDeviceInformative('vpx', UNKNOWN)).toBe(false);
        expect(isDeviceInformative('vpx', 'atgames')).toBe(true);
    });
});

describe('LeaderboardService — engine/device reads', () => {
    it('ships engine + device on every ranking row', async () => {
        const { gameId } = await seedMixedGame();
        const rankings = await LeaderboardService.recalculate(gameId);

        expect(rankings).toHaveLength(5);
        const byName = Object.fromEntries(rankings.map(r => [r.iscored_username, r]));
        expect(byName.PcPlayer.engine).toBe('vpx');
        expect(byName.PcPlayer.device).toBe('pc');
        expect(byName.CabPlayer.engine).toBe('vpx');
        expect(byName.CabPlayer.device).toBe('atgames');
        // The unknown row is present and explicitly 'unknown' — not dropped,
        // not null, not silently bucketed.
        expect(byName.AtgPlayer.engine).toBe(UNKNOWN);
        expect(byName.AtgPlayer.device).toBe('atgames');
    });

    it('groups the same engine across different devices (the AtGames case)', async () => {
        const { gameId } = await seedMixedGame();
        const vpx = await LeaderboardService.getForGameByProvenance(gameId, { engine: 'vpx' });

        // PC-VPX and AtGames-VPX are comparable and share one leaderboard.
        expect(vpx.map(r => r.iscored_username)).toEqual(['PcPlayer', 'CabPlayer']);
        expect(vpx.map(r => r.rank)).toEqual([1, 2]);
    });

    it('excludes unknown-engine rows from a real engine filter', async () => {
        const { gameId } = await seedMixedGame();
        const vpx = await LeaderboardService.getForGameByProvenance(gameId, { engine: 'vpx' });
        expect(vpx.some(r => r.iscored_username === 'AtgPlayer')).toBe(false);
    });

    it('selects exactly the unrecorded rows when filtering on unknown', async () => {
        const { gameId } = await seedMixedGame();
        const unknown = await LeaderboardService.getForGameByProvenance(gameId, { engine: UNKNOWN });
        expect(unknown.map(r => r.iscored_username)).toEqual(['AtgPlayer']);
    });

    it('filters on the device axis without it being a comparability boundary', async () => {
        const { gameId } = await seedMixedGame();
        const onCabinet = await LeaderboardService.getForGameByProvenance(gameId, { device: 'atgames' });
        // Two different engines, both played on an AtGames cabinet.
        expect(onCabinet.map(r => r.iscored_username).sort()).toEqual(['AtgPlayer', 'CabPlayer']);
    });

    it('intersects engine and device when both are supplied', async () => {
        const { gameId } = await seedMixedGame();
        const rows = await LeaderboardService.getForGameByProvenance(gameId, { engine: 'vpx', device: 'atgames' });
        expect(rows.map(r => r.iscored_username)).toEqual(['CabPlayer']);
    });

    it('returns the unfiltered board when neither axis is supplied', async () => {
        const { gameId } = await seedMixedGame();
        const rows = await LeaderboardService.getForGameByProvenance(gameId, {});
        expect(rows).toHaveLength(5);
    });
});

describe('tab strip and filter agree (the pre-P3 zero-row bug)', () => {
    it('every engine getDistinctProvenance offers matches at least one row', async () => {
        const { gameId } = await seedMixedGame();
        const { engines, devices } = await LeaderboardService.getDistinctProvenance(gameId);

        expect(engines.length).toBeGreaterThan(0);
        for (const engine of engines) {
            const rows = await LeaderboardService.getForGameByProvenance(gameId, { engine });
            expect(rows.length, `engine tab "${engine}" matched zero rows`).toBeGreaterThan(0);
        }
        for (const device of devices) {
            const rows = await LeaderboardService.getForGameByProvenance(gameId, { device });
            expect(rows.length, `device "${device}" matched zero rows`).toBeGreaterThan(0);
        }
    });

    it('holds even when stored casing varies — the exact old failure mode', async () => {
        // Pre-P3, distinct values were alias-folded to `vpx` while the filter
        // compared `UPPER(platform) = UPPER(?)`; a tab could be built from
        // rows the filter then failed to find. Mixed casing is the trigger.
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameName = 'Casing';
        const gameId = await createTestGame(tournamentId, { name: gameName });
        const base = { roomId, tournamentId, gameName };
        await seedScore({ ...base, username: 'A', score: 300, engine: 'VPX', device: 'PC', platform: 'VPX' });
        await seedScore({ ...base, username: 'B', score: 200, engine: 'vpx', device: 'pc', platform: 'vpx' });

        const { engines } = await LeaderboardService.getDistinctProvenance(gameId);
        expect(engines).toEqual(['vpx']); // folded to one tab, not two
        const rows = await LeaderboardService.getForGameByProvenance(gameId, { engine: 'vpx' });
        expect(rows).toHaveLength(2);
    });

    it('offers the unknown bucket as a real tab, sorted last', async () => {
        const { gameId } = await seedMixedGame();
        const { engines } = await LeaderboardService.getDistinctProvenance(gameId);
        expect(engines).toContain(UNKNOWN);
        expect(engines[engines.length - 1]).toBe(UNKNOWN);
    });

    it('omits the unknown device from the device list (nothing to filter on)', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameName = 'NoDevice';
        const gameId = await createTestGame(tournamentId, { name: gameName });
        await seedScore({
            roomId, tournamentId, gameName, username: 'A', score: 100,
            engine: 'vpx', device: UNKNOWN,
        });
        const { engines, devices } = await LeaderboardService.getDistinctProvenance(gameId);
        expect(engines).toEqual(['vpx']);
        expect(devices).toEqual([]);
    });
});

describe('deprecated ?platform= alias', () => {
    it('resolves a legacy token through both axes', async () => {
        const { gameId } = await seedMixedGame();
        // `vpxs` means engine vpx ON device atgames — so it must select the
        // cabinet row only, not every VPX score.
        const rows = await LeaderboardService.getForGameByPlatform(gameId, 'vpxs');
        expect(rows.map(r => r.iscored_username)).toEqual(['CabPlayer']);
    });

    it('tolerates the uppercase spellings found in production data', async () => {
        const { gameId } = await seedMixedGame();
        const rows = await LeaderboardService.getForGameByPlatform(gameId, 'VPX');
        expect(rows.map(r => r.iscored_username)).toEqual(['PcPlayer', 'CabPlayer']);
    });

    it('maps a device-only legacy token to the device axis', async () => {
        const { gameId } = await seedMixedGame();
        const rows = await LeaderboardService.getForGameByPlatform(gameId, 'atgames');
        expect(rows.map(r => r.iscored_username).sort()).toEqual(['AtgPlayer', 'CabPlayer']);
    });

    it('keeps distinctPlatforms consistent with the engines it derives from', async () => {
        const { gameId } = await seedMixedGame();
        const platforms = await LeaderboardService.getDistinctPlatforms(gameId);
        // Derived, so it can never disagree with the engine list. The unknown
        // engine contributes nothing (it has no legacy platform to name).
        expect(platforms).toContain('vpx');
        expect(platforms).toContain('real');
        expect(platforms).toContain('pinball_fx');
    });
});

describe('GET /:roomId/leaderboard/:gameId — route surface', () => {
    it('is additive: the anonymous payload keeps every pre-P3 key', async () => {
        const app = await createTestApp();
        const { roomId, gameId } = await seedMixedGame();
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}`);

        expect(res.status).toBe(200);
        for (const key of ['gameId', 'gameName', 'tournamentName', 'imageUrl', 'rankings', 'platform', 'distinctPlatforms']) {
            expect(Object.keys(res.body), key).toContain(key);
        }
        // …and declares which fields are authoritative now.
        expect(res.body.provenanceAuthority).toBe('engine_device');
        expect(Array.isArray(res.body.distinctEngines)).toBe(true);
        expect(Array.isArray(res.body.distinctDevices)).toBe(true);
    });

    it('filters by ?engine=', async () => {
        const app = await createTestApp();
        const { roomId, gameId } = await seedMixedGame();
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}?engine=vpx`);
        expect(res.status).toBe(200);
        expect(res.body.engine).toBe('vpx');
        expect(res.body.rankings.map((r: any) => r.iscored_username)).toEqual(['PcPlayer', 'CabPlayer']);
    });

    it('filters by ?device=', async () => {
        const app = await createTestApp();
        const { roomId, gameId } = await seedMixedGame();
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}?device=pc`);
        expect(res.status).toBe(200);
        expect(res.body.device).toBe('pc');
        expect(res.body.rankings.map((r: any) => r.iscored_username).sort()).toEqual(['FxPlayer', 'PcPlayer']);
    });

    it('still honours a bookmarked ?platform= link', async () => {
        const app = await createTestApp();
        const { roomId, gameId } = await seedMixedGame();
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}?platform=vpxs`);
        expect(res.status).toBe(200);
        expect(res.body.platform).toBe('vpxs');
        expect(res.body.rankings.map((r: any) => r.iscored_username)).toEqual(['CabPlayer']);
    });

    it('lets ?engine= win when a stale ?platform= rides along', async () => {
        const app = await createTestApp();
        const { roomId, gameId } = await seedMixedGame();
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}?engine=fx&platform=vpx`);
        expect(res.status).toBe(200);
        expect(res.body.engine).toBe('fx');
        expect(res.body.platform).toBeNull();
        expect(res.body.rankings.map((r: any) => r.iscored_username)).toEqual(['FxPlayer']);
    });
});

describe('RoomScoresService projects provenance (was selected then dropped)', () => {
    it('room-card ranking rows carry engine and device', async () => {
        const { roomId } = await seedMixedGame();
        const { data } = await RoomScoresService.getRoomScores(roomId);

        expect(data.length).toBeGreaterThan(0);
        const rankings = data[0].rankings;
        expect(rankings.length).toBeGreaterThan(0);
        // Pre-P3 the CTE selected `platform` and the outer SELECT never
        // projected it, so these were all undefined.
        for (const row of rankings) {
            expect(row.engine, row.iscored_username).toBeTruthy();
            expect(row.device, row.iscored_username).toBeTruthy();
        }
        const byName = Object.fromEntries(rankings.map(r => [r.iscored_username, r]));
        expect(byName.PcPlayer.engine).toBe('vpx');
        expect(byName.PcPlayer.device).toBe('pc');
        expect(byName.AtgPlayer.engine).toBe(UNKNOWN);
    });
});

describe('catalogue platform filter — exact JSON membership', () => {
    async function seedCatalogue() {
        await setupTestDb();
        const db = await getDatabase();
        const rows: Array<[string, string[]]> = [
            ['PC Only Table', ['vpx']],
            ['Standalone Table', ['vpxs']],
            ['FX Table', ['pinball_fx']],
            ['FX Classic Table', ['pinball_fx_classic']],
            ['FX VR Table', ['pinball_fx_vr']],
        ];
        for (const [name, platforms] of rows) {
            await db.run(
                `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms)
                 VALUES (?, ?, 'pinball', 'approved', 1, ?)`,
                crypto.randomUUID(), name, JSON.stringify(platforms),
            );
        }
    }

    async function namesFor(platforms: string[]): Promise<string[]> {
        const { data } = await GlobalLeaderboardService.getTopGames({ platforms, limit: 50 });
        return data.map((g: any) => g.name).sort();
    }

    it('does not sweep in every FX variant when filtering on FX', async () => {
        await seedCatalogue();
        // The live bug: `LIKE '%pinball_fx%'` matched pinball_fx_classic and
        // pinball_fx_vr too, so an "FX only" filter silently showed FX Classic.
        const names = await namesFor(['pinball_fx']);
        expect(names).not.toContain('FX Classic Table');
        expect(names).toContain('FX Table');
    });

    it('treats VPX Standalone as the VPX engine rather than a substring accident', async () => {
        await seedCatalogue();
        // `LIKE '%vpx%'` matched `vpxs` by accident; the quoted variant missed
        // it entirely. ADR 0016 says they ARE the same engine, so it matches
        // deliberately now.
        const names = await namesFor(['vpx']);
        expect(names).toEqual(['PC Only Table', 'Standalone Table']);
    });

    it('keeps FX VR with FX — same engine, different device', async () => {
        await seedCatalogue();
        expect(await namesFor(['pinball_fx'])).toContain('FX VR Table');
    });

    it('expands a token to its engine-equivalent set and no further', () => {
        const vpx = equivalentLegacyPlatforms('vpx');
        expect(vpx).toContain('vpx');
        expect(vpx).toContain('vpxs');
        expect(vpx).toContain('vpxs_manual');
        expect(vpx).not.toContain('vp9');
        expect(vpx).not.toContain('atgames');

        // A device-only token must NOT widen along the device axis — that is a
        // rule-semantics decision reserved for the tournament-rules phase.
        expect(equivalentLegacyPlatforms('atgames')).toEqual(['atgames']);
        expect(equivalentLegacyPlatforms('')).toEqual([]);
    });
});

describe('GlobalLeaderboardService — provenance on global rows', () => {
    it('ships engine + device alongside the deprecated platform', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const globalGameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms)
             VALUES (?, 'Global Table', 'pinball', 'approved', 1, '["vpx"]')`,
            globalGameId,
        );
        await db.run(
            `INSERT INTO global_scores (
                id, global_game_id, player_id, iscored_username, score, submitted_at,
                origin_type, exclude_from_global, platform, engine, device
             ) VALUES (?, ?, 'D1', 'Alice', 1000, ?, 'room', 0, 'vpxs', 'vpx', 'atgames')`,
            crypto.randomUUID(), globalGameId, new Date().toISOString(),
        );

        const rankings = await GlobalLeaderboardService.recalculate(globalGameId);
        expect(rankings).toHaveLength(1);
        expect(rankings[0].engine).toBe('vpx');
        expect(rankings[0].device).toBe('atgames');
        // Additive only — the legacy field is still there for the rules phase.
        expect(rankings[0].platform).toBe('vpxs');
    });

    it('reports unknown rather than null for an unrecorded engine', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const globalGameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms)
             VALUES (?, 'AtGames Table', 'pinball', 'approved', 1, '["atgames"]')`,
            globalGameId,
        );
        await db.run(
            `INSERT INTO global_scores (
                id, global_game_id, player_id, iscored_username, score, submitted_at,
                origin_type, exclude_from_global, platform, engine, device
             ) VALUES (?, ?, 'D2', 'Bob', 500, ?, 'room', 0, 'atgames', 'unknown', 'atgames')`,
            crypto.randomUUID(), globalGameId, new Date().toISOString(),
        );

        const rankings = await GlobalLeaderboardService.recalculate(globalGameId);
        expect(rankings[0].engine).toBe(UNKNOWN);
        expect(rankings[0].device).toBe('atgames');
    });
});
