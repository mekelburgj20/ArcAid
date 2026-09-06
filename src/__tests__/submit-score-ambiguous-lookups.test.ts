import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * v2.155.2 — the ambiguous-active-games bug (v2.155.1) had FIVE more name-only
 * lookups downstream of the write side: the platform picker, the provenance
 * check, the submit-moment rank card, the iScored mirror, and the OAuth
 * draft-commit path. Each is now routed through the SAME
 * `SubmissionGameResolver.resolveSubmissionGame` (or a caller-supplied
 * `tournamentId` derived from it), so a room with two ACTIVE games sharing a
 * name in different tournaments can no longer have the picker/provenance/rank
 * disagree with where the score is actually written.
 *
 * Fixture used throughout: "Black Rose" is ACTIVE in BOTH "Weekly Grind - VR"
 * (tournament A, EXCLUDES engine `vpx`) and "Daily Grind" (tournament B, no
 * exclusion — `vpx` allowed). The catalogue lists `vpx` as a valid engine for
 * the game, so which tournament wins decides whether a `vpx` submission is
 * accepted at all.
 */

async function seedCatalogueGame(gameName: string, platforms: string[] = ['vpx', 'real']) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status)
         VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, gameName, JSON.stringify(platforms),
    );
    return id;
}

async function seedProvenanceAmbiguousFixture(roomSlug: string, gameName = 'Black Rose') {
    const db = await getDatabase();
    const roomId = await createTestRoom(roomSlug, roomSlug);
    await seedCatalogueGame(gameName);

    const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
    const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
    await db.run(
        `UPDATE tournaments SET platform_rules = ? WHERE id = ?`,
        JSON.stringify({ required: [], excluded: ['vpx'] }), tournamentA,
    );
    // Tournament B carries no rules at all — vpx is allowed there.

    // Later-start-date game (B) inserted FIRST, earlier-start-date game (A)
    // inserted SECOND — same anti-insertion-order-bias shape as the write-side
    // fixture, so nothing here can be passing by accident of scan/creation order.
    const gameB = await createTestGame(tournamentB, {
        name: gameName, status: 'ACTIVE', startDate: '2026-09-06T03:00:00.000Z',
    });
    const gameA = await createTestGame(tournamentA, {
        name: gameName, status: 'ACTIVE', startDate: '2026-09-03T00:00:00.000Z',
    });

    return { db, roomId, gameName, tournamentA, tournamentB, gameA, gameB };
}

function playerToken(discordId: string, username: string, roomId: string) {
    return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
}

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

describe('GET /api/submit/platforms — resolves against the SAME game as gameId (item 1)', () => {
    it('returns tournament B\'s (permissive) rules when gameId points at B', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('platforms-b');

        const res = await request(app).get('/api/submit/platforms').query({
            roomId: fx.roomId, gameName: fx.gameName, gameId: fx.gameB,
        });
        expect(res.status).toBe(200);
        expect(res.body.submittable).toContain('vpx');
        expect(res.body.tournamentRules?.engines?.excluded ?? []).not.toContain('vpx');
    });

    it("returns tournament A's (restrictive) rules when gameId points at A", async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('platforms-a');

        const res = await request(app).get('/api/submit/platforms').query({
            roomId: fx.roomId, gameName: fx.gameName, gameId: fx.gameA,
        });
        expect(res.status).toBe(200);
        expect(res.body.tournamentRules?.engines?.excluded ?? []).toContain('vpx');
        expect(res.body.submittable).not.toContain('vpx');
    });

    it('with no gameId, resolves the earliest-start-date ACTIVE game (A) — same default as the write side', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('platforms-default');

        const res = await request(app).get('/api/submit/platforms').query({
            roomId: fx.roomId, gameName: fx.gameName,
        });
        expect(res.status).toBe(200);
        expect(res.body.tournamentRules?.engines?.excluded ?? []).toContain('vpx');
    });
});

describe('POST /submit-score — provenance is checked against the SAME game as gameId (item 2)', () => {
    it('accepts a vpx score on tournament B\'s game', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('provenance-accept-b');
        const token = playerToken('prov-player-1', 'ProvPlayer1', fx.roomId);

        const res = await request(app)
            .post(`/api/rooms/${fx.roomId}/submit-score/${encodeURIComponent(fx.gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '1000')
            .field('engine', 'vpx')
            .field('device', 'pc')
            .field('gameId', fx.gameB);

        expect(res.status).toBe(201);

        const submission = await fx.db.get(
            `SELECT game_id FROM submissions WHERE id = ?`, `${fx.gameB}-provplayer1`,
        );
        expect(submission?.game_id).toBe(fx.gameB);
    });

    it('rejects the SAME vpx score on tournament A\'s game', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('provenance-reject-a');
        const token = playerToken('prov-player-2', 'ProvPlayer2', fx.roomId);

        const res = await request(app)
            .post(`/api/rooms/${fx.roomId}/submit-score/${encodeURIComponent(fx.gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '1000')
            .field('engine', 'vpx')
            .field('device', 'pc')
            .field('gameId', fx.gameA);

        expect(res.status).toBe(400);
        // Excluding vpx strips it from tournament A's submittable set before
        // the engine list is derived, so the rejection reads as "not
        // available... Allowed: Real Machine" rather than the separate
        // "not allowed for this tournament" exclusion message — both mean
        // the same thing here; what matters is that vpx did NOT pass.
        expect(res.body.error).toMatch(/not (available|allowed)/i);
    });
});

describe('the submit-moment rank card is computed against the resolved tournament\'s window (item 3)', () => {
    it('does not count a rival scoped to the OTHER tournament', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('rank-window');

        // A rival score that belongs ONLY to tournament A's window.
        await fx.db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id
             ) VALUES (?, ?, ?, 'RivalOnA', 'disc-rival', 9999999, 'community', ?, ?)`,
            fx.gameName, fx.roomId, fx.gameA, fx.roomId, fx.tournamentA,
        );

        const token = playerToken('rank-player-1', 'RankPlayer1', fx.roomId);
        const res = await request(app)
            .post(`/api/rooms/${fx.roomId}/submit-score/${encodeURIComponent(fx.gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '100')
            .field('engine', 'vpx')
            .field('device', 'pc')
            .field('gameId', fx.gameB);

        expect(res.status).toBe(201);
        // If the rank card had fallen back to a room-wide/undecided lookup it
        // could have picked up RivalOnA's 9,999,999 score and reported rank 2
        // of 2 — it must instead see ONLY tournament B's (empty) population.
        expect(res.body.rank).toBeTruthy();
        expect(res.body.rank.rank).toBe(1);
        expect(res.body.rank.totalPlayers).toBe(1);
    });
});

// syncScoreToIScored's own ambiguous-active-games coverage (item 4) lives in
// `iscored-submit-mirrors-resolved-game.test.ts` — it needs a module-level
// `vi.mock` of `IScoredApiClient.js` (hoisted, applied for the whole file),
// which cannot safely share a file with the supertest-driven tests above
// (mid-file `vi.resetModules()` would also reset `database.js`'s singleton
// and orphan every row seeded through this file's already-imported `db`).

describe('OAuth draft-commit resolves the SAME game as the draft target\'s gameId (item 6)', () => {
    it('lands the submissions row and tournament stamp on the target game, not the name-only default', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('draft-commit');

        const { SubmissionDraftService } = await import('../services/SubmissionDraftService.js');
        const stateParam = 'draft-state-' + crypto.randomUUID();
        await SubmissionDraftService.create(
            stateParam,
            { kind: 'tournament', roomId: fx.roomId, gameName: fx.gameName, gameId: fx.gameB },
            {
                playerName: 'DraftPlayer', score: 4200,
                excludeFromGlobal: false, platform: null, engine: 'vpx', device: 'pc',
            },
        );

        const token = playerToken('draft-player-1', 'DraftPlayer', fx.roomId);
        const res = await request(app)
            .post(`/api/submission-drafts/${encodeURIComponent(stateParam)}/commit`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);

        const submission = await fx.db.get(
            `SELECT game_id, submitted_during_tournament_id FROM submissions WHERE id = ?`,
            `${fx.gameB}-draftplayer`,
        );
        expect(submission).toBeTruthy();
        expect(submission.game_id).toBe(fx.gameB);
        expect(submission.submitted_during_tournament_id).toBe(fx.tournamentB);

        const history = await fx.db.get(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 4200`,
            fx.roomId, fx.gameName,
        );
        expect(history.submitted_during_tournament_id).toBe(fx.tournamentB);
    });

    it('rejects a draft engine excluded by the target game\'s OWN tournament (A)', async () => {
        const app = await createTestApp();
        const fx = await seedProvenanceAmbiguousFixture('draft-commit-reject');

        const { SubmissionDraftService } = await import('../services/SubmissionDraftService.js');
        const stateParam = 'draft-state-' + crypto.randomUUID();
        await SubmissionDraftService.create(
            stateParam,
            { kind: 'tournament', roomId: fx.roomId, gameName: fx.gameName, gameId: fx.gameA },
            {
                playerName: 'DraftPlayer2', score: 4200,
                excludeFromGlobal: false, platform: null, engine: 'vpx', device: 'pc',
            },
        );

        const token = playerToken('draft-player-2', 'DraftPlayer2', fx.roomId);
        const res = await request(app)
            .post(`/api/submission-drafts/${encodeURIComponent(stateParam)}/commit`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(400);
    });
});
