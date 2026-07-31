import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { UserProfileService } from '../services/UserProfileService.js';
import { CommunityScoreService } from '../services/CommunityScoreService.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';

/**
 * v2.54.0 — username lock + identity-resolved score reads.
 *
 * The bug: a Discord-logged-in player typed a fake name into the submit modal
 * and saw their real name on the leaderboard card (which partitions by
 * `submitted_by_user_id` and joins `user_profiles`) but the fake name on the
 * ticker and the "All Score History" list (which shipped raw `iscored_username`
 * with no identity join). Two halves to the fix, both covered here:
 *
 *   1. WRITE — an authenticated submitter's posted `username` is discarded and
 *      resolved server-side. Guests are deliberately unchanged.
 *   2. READ  — the history/community reads ship `display_name`, and the
 *      community leaderboard collapses a player's aliases into one rank.
 *
 * Phase 1 (ADR 0016) regression guards ride along: engine/device must still be
 * required, validated, and recorded on every one of the four submit routes.
 */

// Minimal valid PNG signature — passes isAllowedImage's magic-byte check.
const VALID_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
]);

/** The name a malicious/confused client posts. Never expected to be stored. */
const SPOOFED = 'FakeName';

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string, username: string, roomId = '') {
    return signToken({ role: 'player', gameRoomIds: roomId ? [roomId] : [], discordId, username });
}

async function seedCatalogueGame(gameName: string, platforms = ['real']) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status)
         VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, gameName, JSON.stringify(platforms),
    );
    return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Write paths — the lock itself
// ─────────────────────────────────────────────────────────────────────────────

describe('username lock — an authenticated submit ignores the posted username', () => {
    it('POST /:roomId/community-scores/:gameName stores the resolved name, not the typed one', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-community', 'UL Community');
        const gameName = 'UL Community Game';
        await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-1', 'CanonicalOne');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${playerToken('ul-user-1', 'JwtOne', roomId)}`)
            .send({ username: SPOOFED, score: 1000, engine: 'real', device: 'real_cabinet' });

        expect(res.status).toBe(201);
        expect(res.body.displayName).toBe('CanonicalOne');

        const db = await getDatabase();
        const row = await db.get(
            `SELECT iscored_username, engine, device FROM community_scores
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row.iscored_username).toBe('CanonicalOne');
        // Phase 1 guard — provenance still recorded.
        expect(row).toMatchObject({ engine: 'real', device: 'real_cabinet' });

        // …and the history row the ticker reads from agrees.
        const hist = await db.get(
            `SELECT iscored_username FROM score_history WHERE game_room_id = ?`, roomId,
        );
        expect(hist.iscored_username).toBe('CanonicalOne');
    });

    it('POST /:roomId/submit-score/:gameName stores the resolved name, not the typed one', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-submit', 'UL Submit');
        const gameName = 'UL Submit Game';
        await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-2', 'CanonicalTwo');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${playerToken('ul-user-2', 'JwtTwo', roomId)}`)
            .field('username', SPOOFED)
            .field('score', '2000')
            .field('engine', 'real')
            .field('device', 'real_cabinet');

        expect(res.status).toBe(201);
        expect(res.body.displayName).toBe('CanonicalTwo');

        const db = await getDatabase();
        const row = await db.get(
            `SELECT iscored_username, engine, device FROM community_scores
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row.iscored_username).toBe('CanonicalTwo');
        expect(row).toMatchObject({ engine: 'real', device: 'real_cabinet' });
    });

    it('POST /:roomId/freeplay-score stores the resolved name, not the typed one', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-freeplay', 'UL Freeplay');
        const gameName = 'UL Freeplay Game';
        const ggId = await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-3', 'CanonicalThree');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/freeplay-score`)
            .set('Authorization', `Bearer ${playerToken('ul-user-3', 'JwtThree', roomId)}`)
            .field('globalGameId', ggId)
            .field('username', SPOOFED)
            .field('score', '3000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });

        expect(res.status).toBe(201);
        expect(res.body.displayName).toBe('CanonicalThree');

        const db = await getDatabase();
        const row = await db.get(
            `SELECT iscored_username, engine, device FROM community_scores
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row.iscored_username).toBe('CanonicalThree');
        expect(row).toMatchObject({ engine: 'real', device: 'real_cabinet' });
    });

    it('POST /global/scores ignores displayName and claims only the CANONICAL alias', async () => {
        const app = await createTestApp();
        const gameName = 'UL Global Game';
        const ggId = await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-4', 'CanonicalFour');

        const res = await request(app)
            .post('/api/global/scores')
            .set('Authorization', `Bearer ${playerToken('ul-user-4', 'JwtFour')}`)
            .field('globalGameId', ggId)
            .field('displayName', SPOOFED)
            .field('score', '4000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });

        expect(res.status).toBe(201);
        expect(res.body.iscored_username).toBe('CanonicalFour');
        expect(res.body).toMatchObject({ engine: 'real', device: 'real_cabinet' });

        // Pre-lock, the typed name became a PERMANENT user_mappings alias of the
        // account. Only the canonical name may be claimed now.
        const db = await getDatabase();
        const aliases = await db.all(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?`, 'ul-user-4',
        ) as Array<{ iscored_username: string }>;
        expect(aliases.map(a => a.iscored_username)).toEqual(['CanonicalFour']);
    });

    it('a second submit reuses the room claim established by the first (name stays stable)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-stable', 'UL Stable');
        const gameName = 'UL Stable Game';
        await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-5', 'CanonicalFive');
        const token = playerToken('ul-user-5', 'JwtFive', roomId);

        for (const score of [10, 20]) {
            const res = await request(app)
                .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
                .set('Authorization', `Bearer ${token}`)
                .send({ username: SPOOFED, score, engine: 'real', device: 'real_cabinet' });
            expect(res.status).toBe(201);
            expect(res.body.displayName).toBe('CanonicalFive');
        }

        const db = await getDatabase();
        const names = await db.all(
            `SELECT DISTINCT iscored_username FROM community_scores WHERE game_room_id = ?`, roomId,
        ) as Array<{ iscored_username: string }>;
        expect(names.map(n => n.iscored_username)).toEqual(['CanonicalFive']);
    });

    it('an authed submit that omits username entirely still succeeds (schema allows it)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-omit', 'UL Omit');
        const gameName = 'UL Omit Game';
        await seedCatalogueGame(gameName);
        await UserProfileService.setDisplayName('ul-user-6', 'CanonicalSix');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${playerToken('ul-user-6', 'JwtSix', roomId)}`)
            .send({ score: 500, engine: 'real', device: 'real_cabinet' });

        expect(res.status).toBe(201);
        expect(res.body.displayName).toBe('CanonicalSix');
    });
});

describe('username lock — the guest flow is deliberately unchanged', () => {
    it('a guest keeps their free-text name on every room route', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-guest', 'UL Guest');
        const gameName = 'UL Guest Game';
        const ggId = await seedCatalogueGame(gameName);

        const community = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .send({ username: 'GuestyOne', score: 100, engine: 'real', device: 'real_cabinet' });
        expect(community.status).toBe(201);
        expect(community.body.displayName).toBe('GuestyOne');

        const freeplay = await request(app)
            .post(`/api/rooms/${roomId}/freeplay-score`)
            .field('globalGameId', ggId)
            .field('username', 'GuestyTwo')
            .field('score', '200')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
        expect(freeplay.status).toBe(201);
        expect(freeplay.body.displayName).toBe('GuestyTwo');
    });

    it('a guest with no username still 400s on all three room routes', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-guest-noname', 'UL Guest No Name');
        const gameName = 'UL Guest No Name Game';
        const ggId = await seedCatalogueGame(gameName);

        const community = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .send({ score: 100, engine: 'real', device: 'real_cabinet' });
        expect(community.status).toBe(400);
        expect(community.body.error).toMatch(/username is required/);

        const submit = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .field('score', '100')
            .field('engine', 'real')
            .field('device', 'real_cabinet');
        expect(submit.status).toBe(400);
        expect(submit.body.error).toMatch(/username is required/);

        const freeplay = await request(app)
            .post(`/api/rooms/${roomId}/freeplay-score`)
            .field('globalGameId', ggId)
            .field('score', '100')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
        expect(freeplay.status).toBe(400);
        expect(freeplay.body.error).toMatch(/username is required/);
    });

    it('a whitespace-only guest username is treated as absent (400), not stored blank', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-guest-blank', 'UL Guest Blank');
        const gameName = 'UL Guest Blank Game';
        await seedCatalogueGame(gameName);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .send({ username: '   ', score: 100, engine: 'real', device: 'real_cabinet' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/username is required/);
    });
});

describe('ADR 0016 Phase 1 regression — engine/device survive the username lock', () => {
    it('all four submit routes still reject a missing or impossible provenance pair', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ul-prov', 'UL Prov');
        const gameName = 'UL Prov Game';
        const ggId = await seedCatalogueGame(gameName, ['real']);
        const token = playerToken('ul-user-7', 'JwtSeven', roomId);

        // Missing both axes — Zod rejects before the handler body runs.
        const missing = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ score: 10 });
        expect(missing.status).toBe(400);

        // Impossible pair: `real` can't run on a PC.
        const impossible = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '10').field('engine', 'real').field('device', 'pc');
        expect(impossible.status).toBe(400);

        const freeplayBad = await request(app)
            .post(`/api/rooms/${roomId}/freeplay-score`)
            .set('Authorization', `Bearer ${token}`)
            .field('globalGameId', ggId)
            .field('score', '10').field('engine', 'real').field('device', 'pc')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
        expect(freeplayBad.status).toBe(400);

        const globalBad = await request(app)
            .post('/api/global/scores')
            .set('Authorization', `Bearer ${token}`)
            .field('globalGameId', ggId)
            .field('score', '10').field('engine', 'real').field('device', 'pc')
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
        expect(globalBad.status).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Read paths — identity resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('identity-resolved reads ship display_name', () => {
    /** One Discord user with a chosen display name + an alias, plus a guest row. */
    async function seedIdentity(roomId: string, gameName: string) {
        const db = await getDatabase();
        await UserProfileService.setDisplayName('rd-user-1', 'RealName');
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            'rd-user-1', 'LegacyAlias',
        );
        await CommunityScoreService.submitScore(roomId, gameName, 'LegacyAlias', 900, 'rd-user-1');
        await CommunityScoreService.submitScore(roomId, gameName, 'PlainGuest', 100);
        return db;
    }

    it('CommunityScoreService.getGameHistory / getRecentActivity resolve the display name', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('rd-community', 'RD Community');
        const gameName = 'RD Community Game';
        await seedIdentity(roomId, gameName);

        const history = await CommunityScoreService.getGameHistory(roomId, gameName) as Array<{
            iscored_username: string; display_name: string | null;
        }>;
        const mapped = new Map(history.map(h => [h.iscored_username, h.display_name]));
        expect(mapped.get('LegacyAlias')).toBe('RealName');
        // A guest has no identity to resolve — the FE falls back to the raw name.
        expect(mapped.get('PlainGuest')).toBeFalsy();

        const recent = await CommunityScoreService.getRecentActivity(roomId) as Array<{
            iscored_username: string; display_name: string | null;
        }>;
        expect(recent.find(r => r.iscored_username === 'LegacyAlias')?.display_name).toBe('RealName');
    });

    it('ScoreHistoryService.getGameHistory / getGameSubmissions / getPlayerGameHistory resolve it too', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('rd-history', 'RD History');
        const gameName = 'RD History Game';
        const db = await seedIdentity(roomId, gameName);

        const history = await ScoreHistoryService.getGameHistory(roomId, gameName) as Array<{
            iscored_username: string; display_name: string | null;
        }>;
        expect(history.find(h => h.iscored_username === 'LegacyAlias')?.display_name).toBe('RealName');
        expect(history.find(h => h.iscored_username === 'PlainGuest')?.display_name).toBeFalsy();

        const player = await ScoreHistoryService.getPlayerGameHistory(roomId, gameName, 'LegacyAlias') as Array<{
            iscored_username: string; display_name: string | null;
        }>;
        expect(player).toHaveLength(1);
        expect(player[0]).toMatchObject({ iscored_username: 'LegacyAlias', display_name: 'RealName' });

        // getGameSubmissions is keyed on game_id, so give the rows one.
        await db.run(`UPDATE score_history SET game_id = 'rd-game-1' WHERE game_room_id = ?`, roomId);
        const submissions = await ScoreHistoryService.getGameSubmissions(roomId, 'rd-game-1') as Array<{
            iscored_username: string; display_name: string | null;
        }>;
        expect(submissions.find(s => s.iscored_username === 'LegacyAlias')?.display_name).toBe('RealName');
    });
});

describe('community leaderboard collapses a player\'s aliases into one rank', () => {
    it('one row per identity, best alias shown, plays aggregated across aliases', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cl-collapse', 'CL Collapse');
        const gameName = 'CL Collapse Game';
        await UserProfileService.setDisplayName('cl-user-1', 'OneTrueName');

        // Same Discord user, three different typed names — pre-fix this was
        // three separate ranks on the same board.
        await CommunityScoreService.submitScore(roomId, gameName, 'AliasA', 500, 'cl-user-1');
        await CommunityScoreService.submitScore(roomId, gameName, 'AliasB', 900, 'cl-user-1');
        await CommunityScoreService.submitScore(roomId, gameName, 'AliasC', 700, 'cl-user-1');
        // A genuine second player (guest) still gets their own row.
        await CommunityScoreService.submitScore(roomId, gameName, 'SomeoneElse', 800);

        const board = await CommunityScoreService.getGameLeaderboard(roomId, gameName) as Array<{
            player_key: string; iscored_username: string; display_name: string | null;
            best_score: number; times_played: number; last_played: string;
        }>;

        expect(board).toHaveLength(2);
        const [first, second] = board;

        // The multi-alias user ranks once, under the alias of their BEST score.
        expect(first).toMatchObject({
            player_key: 'cl-user-1',
            iscored_username: 'AliasB',
            display_name: 'OneTrueName',
            best_score: 900,
            times_played: 3,
        });
        expect(first.last_played).toBeTruthy();

        // The guest partitions on the iscored:* fallback key.
        expect(second).toMatchObject({
            player_key: 'iscored:someoneelse',
            iscored_username: 'SomeoneElse',
            best_score: 800,
            times_played: 1,
        });
        expect(second.display_name).toBeFalsy();
    });

    it('breaks a best-score tie by the OLDEST row, so the shown alias is deterministic', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cl-tie', 'CL Tie');
        const gameName = 'CL Tie Game';

        await CommunityScoreService.submitScore(roomId, gameName, 'EarlyAlias', 500, 'cl-user-2');
        await CommunityScoreService.submitScore(roomId, gameName, 'LateAlias', 500, 'cl-user-2');

        const board = await CommunityScoreService.getGameLeaderboard(roomId, gameName) as Array<{
            iscored_username: string; times_played: number;
        }>;
        expect(board).toHaveLength(1);
        expect(board[0]).toMatchObject({ iscored_username: 'EarlyAlias', times_played: 2 });
    });
});
