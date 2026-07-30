import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase, _resetForTesting } from '../database/database.js';
import { addEngineDeviceProvenance } from '../database/migrations/engineDeviceProvenance.js';
import { ScoreProvenanceService } from '../services/ScoreProvenanceService.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { CommunityScoreService } from '../services/CommunityScoreService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';
import { SubmissionDraftService } from '../services/SubmissionDraftService.js';
import { UNKNOWN, mapLegacyPlatform, deriveLegacyPlatform } from '../utils/scoreProvenance.js';

/**
 * ADR 0016 Phase 1 — engine + device score provenance.
 *
 * Covers migration 125 against a production-shaped fixture, the write paths,
 * the compatibility rules, and the `'unknown'`-is-never-NULL invariant.
 */

const ROOM_ID = 'room-prov';

async function seedRoom() {
    const db = await getDatabase();
    await db.run(
        `INSERT OR REPLACE INTO game_rooms (id, name, slug, is_public) VALUES (?, ?, ?, 1)`,
        ROOM_ID, 'Provenance Room', 'provenance-room',
    );
    return db;
}

async function seedCatalogueGame(name: string, platforms: string[]) {
    const db = await getDatabase();
    const id = `gg-${name.toLowerCase().replace(/\W+/g, '-')}`;
    await db.run(
        `INSERT OR REPLACE INTO global_games (id, name, type, platforms, status)
         VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, name, JSON.stringify(platforms),
    );
    return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration 125
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prod's actual score-platform distribution as of the ADR (~120 rows, dominated
 * by uppercase `ATGAMES`, with `VPX`/`vpx` and `VPXS`/`vpxs` case splits and a
 * large NULL tail). No prod DB copy was available on this machine, so the
 * fixture reproduces that distribution on a REAL, fully-migrated schema (every
 * prior migration applied, FK enforcement on) rather than a hand-rolled table —
 * see the test below for how migration 125 is rolled back and replayed.
 */
const PROD_PLATFORM_SHAPE: Array<[string | null, number]> = [
    ['ATGAMES', 57],
    ['vpx', 16],
    ['VPX', 4],
    ['VPXS', 3],
    ['vpxs', 2],
    ['real', 5],
    ['pinball_fx_vr', 2],
    ['atgames', 4],
    [null, 27],
];

describe('migration 125 — engine/device backfill against a prod-shaped DB', () => {
    it('maps every legacy value per ADR 0016 and leaves no NULLs', async () => {
        const tmpPath = path.join(os.tmpdir(), `arcaid-prov-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
        const originalDbPath = process.env.DB_PATH;
        try {
            // 1. Build a REAL database: every migration up to and including 125.
            process.env.DB_PATH = tmpPath;
            await _resetForTesting();
            const db = await getDatabase();

            // 2. Roll migration 125 back so we can replay it over legacy data.
            //    (Indexes first — SQLite refuses to drop an indexed column.)
            await db.exec('PRAGMA foreign_keys = OFF');
            for (const idx of [
                'idx_submissions_game_engine', 'idx_submissions_game_device',
                'idx_score_history_game_engine', 'idx_score_history_game_device',
                'idx_community_game_engine', 'idx_community_game_device',
                'idx_global_scores_game_engine', 'idx_global_scores_game_device',
            ]) {
                await db.exec(`DROP INDEX IF EXISTS ${idx}`);
            }
            for (const table of ['submissions', 'score_history', 'community_scores', 'global_scores', 'submission_drafts']) {
                await db.exec(`ALTER TABLE ${table} DROP COLUMN engine`);
                await db.exec(`ALTER TABLE ${table} DROP COLUMN device`);
            }
            await db.exec('ALTER TABLE tournaments DROP COLUMN iscored_default_engine');
            await db.exec('ALTER TABLE tournaments DROP COLUMN iscored_default_device');
            await db.run(`DELETE FROM schema_migrations WHERE name = '125_engine_device_score_provenance'`);

            // 3. Seed the prod-shaped legacy rows.
            let n = 0;
            for (const [platform, count] of PROD_PLATFORM_SHAPE) {
                for (let i = 0; i < count; i++) {
                    n++;
                    await db.run(
                        `INSERT INTO submissions (id, game_id, iscored_username, score, timestamp, discord_user_id, platform)
                         VALUES (?, NULL, ?, ?, datetime('now'), ?, ?)`,
                        `s-${n}`, `player${n}`, 1000 + n, `iscored:player${n}`, platform,
                    );
                }
            }
            // A row in every other provenance-carrying table too.
            await db.run(
                `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, platform)
                 VALUES ('WHO dunnit', ?, 'p', 'SYSTEM', 1, 'sync', 'VPXS')`, ROOM_ID);
            await db.run(
                `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score, platform)
                 VALUES ('WHO dunnit', ?, 'p', 'ANON', 1, 'ATGAMES')`, ROOM_ID);
            await db.run(
                `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, submitted_at, platform)
                 VALUES ('gs-1', 'gg-x', 'u1', 'p', 1, 'global', datetime('now'), 'zaccaria_vr')`);
            await db.run(
                `INSERT INTO submission_drafts (state_param, target_json, created_at, expires_at, platform)
                 VALUES ('st-1', '{}', datetime('now'), datetime('now', '+5 minutes'), 'bam')`);

            const preTotal = (await db.get(`SELECT COUNT(*) AS n FROM submissions`)) as { n: number };
            expect(preTotal.n).toBe(120);

            // 4. Replay the migration.
            await addEngineDeviceProvenance(db);

            // 5. Every legacy value maps as ADR 0016 specifies.
            const grouped = (await db.all(
                `SELECT platform, engine, device, COUNT(*) AS n FROM submissions GROUP BY platform, engine, device`,
            )) as Array<{ platform: string | null; engine: string; device: string; n: number }>;
            const byPlatform = new Map(grouped.map(r => [String(r.platform), r]));

            // AtGames — the whole point of the ADR: engine is unknowable, device is not.
            expect(byPlatform.get('ATGAMES')).toMatchObject({ engine: 'unknown', device: 'atgames', n: 57 });
            expect(byPlatform.get('atgames')).toMatchObject({ engine: 'unknown', device: 'atgames', n: 4 });
            // Case-split duplicates collapse to the same provenance.
            expect(byPlatform.get('vpx')).toMatchObject({ engine: 'vpx', device: 'unknown', n: 16 });
            expect(byPlatform.get('VPX')).toMatchObject({ engine: 'vpx', device: 'unknown', n: 4 });
            expect(byPlatform.get('VPXS')).toMatchObject({ engine: 'vpx', device: 'atgames', n: 3 });
            expect(byPlatform.get('vpxs')).toMatchObject({ engine: 'vpx', device: 'atgames', n: 2 });
            expect(byPlatform.get('real')).toMatchObject({ engine: 'real', device: 'real_cabinet', n: 5 });
            expect(byPlatform.get('pinball_fx_vr')).toMatchObject({ engine: 'fx', device: 'vr_headset', n: 2 });
            // The NULL tail becomes explicit 'unknown', not NULL.
            expect(byPlatform.get('null')).toMatchObject({ engine: 'unknown', device: 'unknown', n: 27 });

            // 6. Other tables mapped too.
            const sh = await db.get(`SELECT engine, device FROM score_history LIMIT 1`);
            expect(sh).toMatchObject({ engine: 'vpx', device: 'atgames' });
            const cs = await db.get(`SELECT engine, device FROM community_scores LIMIT 1`);
            expect(cs).toMatchObject({ engine: 'unknown', device: 'atgames' });
            const gs = await db.get(`SELECT engine, device FROM global_scores LIMIT 1`);
            expect(gs).toMatchObject({ engine: 'zaccaria', device: 'vr_headset' });
            // BAM is not an engine — it folds to Future Pinball (ADR 0016).
            const sd = await db.get(`SELECT engine, device FROM submission_drafts LIMIT 1`);
            expect(sd).toMatchObject({ engine: 'fp', device: 'unknown' });

            // 7. No NULLs anywhere, and `platform` is untouched (reads still use it).
            for (const table of ['submissions', 'score_history', 'community_scores', 'global_scores']) {
                const nulls = (await db.get(
                    `SELECT COUNT(*) AS n FROM ${table} WHERE engine IS NULL OR device IS NULL`,
                )) as { n: number };
                expect(nulls.n, `${table} has NULL provenance`).toBe(0);
            }
            const platformsIntact = (await db.get(
                `SELECT COUNT(*) AS n FROM submissions WHERE platform = 'ATGAMES'`,
            )) as { n: number };
            expect(platformsIntact.n).toBe(57);

            // 8. Indexes recreated.
            const indexes = (await db.all(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_engine'`,
            )) as Array<{ name: string }>;
            expect(indexes.map(i => i.name).sort()).toEqual([
                'idx_community_game_engine', 'idx_global_scores_game_engine',
                'idx_score_history_game_engine', 'idx_submissions_game_engine',
            ]);

            // 9. Idempotent — a second run changes nothing and does not throw.
            await expect(addEngineDeviceProvenance(db)).resolves.toBeUndefined();
            const after = (await db.get(
                `SELECT COUNT(*) AS n FROM submissions WHERE engine = 'unknown' AND device = 'atgames'`,
            )) as { n: number };
            expect(after.n).toBe(61);
        } finally {
            process.env.DB_PATH = originalDbPath ?? ':memory:';
            await _resetForTesting();
            try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        }
    }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation rules
// ─────────────────────────────────────────────────────────────────────────────

describe('ScoreProvenanceService.validate', () => {
    beforeEach(async () => {
        await seedRoom();
    });

    it('accepts a coherent pair and derives the legacy platform', async () => {
        await seedCatalogueGame('WHO dunnit', ['vpx', 'vpxs', 'real', 'atgames']);
        const result = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'WHO dunnit', 'vpx', 'atgames');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.engine).toBe('vpx');
            expect(result.device).toBe('atgames');
            // vpx-on-atgames IS the legacy `vpxs` id, and the game carries it.
            expect(result.platform).toBe('vpxs');
        }
    });

    it('rejects an impossible engine/device pair', async () => {
        await seedCatalogueGame('Attack From Mars', ['real', 'vpx']);
        const result = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Attack From Mars', 'real', 'pc');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/can't run/i);
    });

    it('rejects an engine the game does not offer', async () => {
        await seedCatalogueGame('Medieval Madness', ['vpx']);
        const result = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Medieval Madness', 'zaccaria', 'pc');
        expect(result.ok).toBe(false);
    });

    it('rejects an unknown engine or device id outright', async () => {
        await seedCatalogueGame('Twilight Zone', ['vpx']);
        expect((await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Twilight Zone', 'not_a_thing', 'pc')).ok).toBe(false);
        expect((await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Twilight Zone', 'vpx', 'not_a_thing')).ok).toBe(false);
    });

    it("treats 'unknown' as a first-class value on both axes", async () => {
        await seedCatalogueGame('Funhouse', ['vpx', 'atgames']);
        const both = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Funhouse', UNKNOWN, UNKNOWN);
        expect(both.ok).toBe(true);
        const engineOnly = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Funhouse', 'vpx', UNKNOWN);
        expect(engineOnly.ok).toBe(true);
        const deviceOnly = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Funhouse', UNKNOWN, 'atgames');
        expect(deviceOnly.ok).toBe(true);
    });

    it('auto-locks engine to unknown for an AtGames-only game rather than blocking', async () => {
        await seedCatalogueGame('AtGames Exclusive', ['atgames']);
        const scope = await ScoreProvenanceService.resolveForRoomGame(ROOM_ID, 'AtGames Exclusive');
        expect(ScoreProvenanceService.enginesFor(scope)).toEqual([UNKNOWN]);
        const result = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'AtGames Exclusive', UNKNOWN, 'atgames');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.platform).toBe('atgames');
    });

    it('rejects a missing axis instead of falling through as allowed', async () => {
        await seedCatalogueGame('Tales of the Arabian Nights', ['vpx']);
        expect((await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Tales of the Arabian Nights', '', 'pc')).ok).toBe(false);
        expect((await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Tales of the Arabian Nights', 'vpx', '')).ok).toBe(false);
        expect((await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Tales of the Arabian Nights', undefined, undefined)).ok).toBe(false);
    });

    it('honours a tournament `excluded` rule on the device axis', async () => {
        const db = await getDatabase();
        await seedCatalogueGame('Excluded Game', ['vpx', 'atgames']);
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, game_room_id, platform_rules, is_active)
             VALUES ('t-excl', 'T', 'weekly', 'pinball', ?, ?, 1)`,
            ROOM_ID, JSON.stringify({ required: [], excluded: ['atgames'] }),
        );
        await db.run(
            `INSERT INTO games (id, name, tournament_id, status, game_room_id)
             VALUES ('g-excl', 'Excluded Game', 't-excl', 'ACTIVE', ?)`, ROOM_ID);

        const blocked = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Excluded Game', 'vpx', 'atgames');
        expect(blocked.ok).toBe(false);
        const allowed = await ScoreProvenanceService.validateForRoomGame(ROOM_ID, 'Excluded Game', 'vpx', 'pc');
        expect(allowed.ok).toBe(true);
    });

    it('resolves the same engine set for a room-tagged game as the Discord path', async () => {
        const db = await getDatabase();
        // Catalogue says vpx only; the ROOM additionally tags it as playable on
        // Pinball FX. Pre-v2.53.0 the Discord command ignored room tags, so the
        // two surfaces disagreed about what was submittable.
        const ggId = await seedCatalogueGame('Room Tagged Game', ['vpx']);
        await db.run(
            `INSERT INTO room_game_tags (game_room_id, global_game_id, tag) VALUES (?, ?, 'pinball_fx')`,
            ROOM_ID, ggId,
        );
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, game_room_id, platform_rules, is_active)
             VALUES ('t-tag', 'T', 'weekly', 'pinball', ?, '{}', 1)`, ROOM_ID);

        const webScope = await ScoreProvenanceService.resolveForRoomGame(ROOM_ID, 'Room Tagged Game');
        const discordScope = await ScoreProvenanceService.resolveForTournamentGame('t-tag', 'Room Tagged Game');
        expect(ScoreProvenanceService.enginesFor(discordScope).sort())
            .toEqual(ScoreProvenanceService.enginesFor(webScope).sort());
        expect(ScoreProvenanceService.enginesFor(discordScope).sort()).toEqual(['fx', 'vpx']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write paths
// ─────────────────────────────────────────────────────────────────────────────

describe('write paths record engine + device', () => {
    beforeEach(async () => {
        await seedRoom();
    });

    it('CommunityScoreService writes both columns to community_scores AND score_history', async () => {
        const db = await getDatabase();
        await CommunityScoreService.submitScore(
            ROOM_ID, 'Funhouse', 'Ada', 4200, undefined, undefined,
            { platform: 'vpxs', engine: 'vpx', device: 'atgames' },
        );
        const cs = await db.get(`SELECT engine, device, platform FROM community_scores WHERE game_name = 'Funhouse'`);
        expect(cs).toMatchObject({ engine: 'vpx', device: 'atgames', platform: 'vpxs' });
        const sh = await db.get(`SELECT engine, device FROM score_history WHERE game_name = 'Funhouse'`);
        expect(sh).toMatchObject({ engine: 'vpx', device: 'atgames' });
    });

    it("defaults to 'unknown' — never NULL — when a caller supplies nothing", async () => {
        const db = await getDatabase();
        await CommunityScoreService.submitScore(ROOM_ID, 'No Provenance', 'Bob', 10);
        const cs = await db.get(`SELECT engine, device FROM community_scores WHERE game_name = 'No Provenance'`);
        expect(cs).toMatchObject({ engine: UNKNOWN, device: UNKNOWN });

        await ScoreHistoryService.log({
            gameName: 'Sync Only', gameRoomId: ROOM_ID, username: 'Cy', score: 5, source: 'sync',
        });
        const sh = await db.get(`SELECT engine, device FROM score_history WHERE game_name = 'Sync Only'`);
        expect(sh).toMatchObject({ engine: UNKNOWN, device: UNKNOWN });
    });

    it('GlobalScoreService.submit writes both columns', async () => {
        const db = await getDatabase();
        const ggId = await seedCatalogueGame('Global Game', ['pinball_fx']);
        await GlobalScoreService.submit({
            globalGameId: ggId, playerId: 'u-1', iscoredUsername: 'Dee', score: 9,
            originType: 'global', platform: 'pinball_fx_vr', engine: 'fx', device: 'vr_headset',
        });
        const gs = await db.get(`SELECT engine, device, platform FROM global_scores WHERE iscored_username = 'Dee'`);
        expect(gs).toMatchObject({ engine: 'fx', device: 'vr_headset', platform: 'pinball_fx_vr' });
    });

    it('drafts round-trip both columns, defaulting to unknown on legacy rows', async () => {
        const db = await getDatabase();
        await SubmissionDraftService.create('st-x', { kind: 'freeplay', roomId: ROOM_ID, globalGameId: 'gg', gameName: 'G' } as never, {
            playerName: 'Eve', score: 7, engine: 'vpx', device: 'pc',
        });
        const draft = await SubmissionDraftService.get('st-x');
        expect(draft).toMatchObject({ engine: 'vpx', device: 'pc' });

        // A row staged before this release has NULLs on disk; the reader must
        // still hand back 'unknown', because the commit paths validate the pair.
        await db.run(
            `INSERT INTO submission_drafts (state_param, target_json, player_name, score, created_at, expires_at, engine, device)
             VALUES ('st-legacy', ?, 'Frank', 3, datetime('now'), datetime('now', '+5 minutes'), NULL, NULL)`,
            JSON.stringify({ kind: 'freeplay', roomId: ROOM_ID, globalGameId: 'gg', gameName: 'G' }),
        );
        const legacy = await SubmissionDraftService.get('st-legacy');
        expect(legacy).toMatchObject({ engine: UNKNOWN, device: UNKNOWN });
    });

    it('COALESCE-preserve: a sync re-write cannot blank provenance a player supplied', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, score, timestamp, discord_user_id, platform, engine, device)
             VALUES ('sub-1', NULL, 'Gil', 100, datetime('now'), 'u-9', 'vpxs', 'vpx', 'atgames')`);
        // Same upsert shape the sync writers use, with the 'unknown' placeholder.
        await db.run(`
            INSERT INTO submissions (id, game_id, iscored_username, score, timestamp, discord_user_id, platform, engine, device)
            VALUES ('sub-1', NULL, 'Gil', 200, datetime('now'), 'u-9', NULL, 'unknown', 'unknown')
            ON CONFLICT(id) DO UPDATE SET
                score = excluded.score,
                platform = COALESCE(excluded.platform, submissions.platform),
                engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')
        `);
        const row = await db.get(`SELECT score, platform, engine, device FROM submissions WHERE id = 'sub-1'`);
        expect(row).toMatchObject({ score: 200, platform: 'vpxs', engine: 'vpx', device: 'atgames' });

        // …but a concrete incoming value still wins.
        await db.run(`
            INSERT INTO submissions (id, game_id, iscored_username, score, timestamp, discord_user_id, engine, device)
            VALUES ('sub-1', NULL, 'Gil', 300, datetime('now'), 'u-9', 'fx', 'vr_headset')
            ON CONFLICT(id) DO UPDATE SET
                score = excluded.score,
                engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')
        `);
        const updated = await db.get(`SELECT engine, device FROM submissions WHERE id = 'sub-1'`);
        expect(updated).toMatchObject({ engine: 'fx', device: 'vr_headset' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Derivation invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy platform derivation', () => {
    it('round-trips the ids whose provenance is unambiguous', () => {
        for (const id of ['real', 'vpx', 'vpxs', 'pinball_fx_vr', 'zaccaria_vr', 'atgames', 'pinball_fx_classic_vr']) {
            const { engine, device } = mapLegacyPlatform(id);
            expect(deriveLegacyPlatform(engine, device, [id]), `${id} did not round-trip`).toBe(id);
        }
    });

    it('prefers an id the game actually carries', () => {
        // vpx-on-atgames is `vpxs` when the game has it, plain `vpx` when not.
        expect(deriveLegacyPlatform('vpx', 'atgames', ['vpx', 'vpxs'])).toBe('vpxs');
        expect(deriveLegacyPlatform('vpx', 'atgames', ['vpx'])).toBe('vpx');
    });

    it('falls back to the device when the engine is unknown', () => {
        expect(deriveLegacyPlatform(UNKNOWN, 'atgames', ['atgames'])).toBe('atgames');
        expect(deriveLegacyPlatform(UNKNOWN, UNKNOWN, [])).toBeNull();
    });
});
