import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalPinService } from '../services/GlobalPinService.js';

/**
 * v2.52.0 (Track A, phase A4) — Global Scoreboard pins + per-viewer rank
 * context (tmp/global-scoreboard-a4-contract.md).
 *
 * Bootstrap follows global-scoreboard-hasscores.test.ts: global.ts declares its
 * routes WITHOUT a '/global' prefix on the router itself, so it mounts at bare
 * '/api'. setup.ts's global beforeEach resets the in-memory DB per `it()`.
 */
async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const playerToken = (discordId: string, username = 'Tester') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

async function makeGame(name: string): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`,
        id, name,
    );
    return id;
}

/**
 * Seed one global score. `submittedBy` is the attributed identity
 * (`submitted_by_user_id`), which is what the leaderboard partitions and ranks
 * by — the same column a logged-in web submit writes.
 */
async function addScore(gameId: string, opts: {
    username: string;
    score: number;
    submittedBy?: string | null;
    at?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, submitted_by_user_id, iscored_username, score, origin_type, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'global', ?)`,
        crypto.randomUUID(), gameId,
        opts.submittedBy ?? `anon:${opts.username}`,
        opts.submittedBy ?? null,
        opts.username, opts.score,
        opts.at ?? new Date().toISOString(),
    );
}

/** Seed N filler players descending from `top`, so ranks are deterministic. */
async function addFillerScores(gameId: string, count: number, top: number) {
    for (let i = 0; i < count; i++) {
        await addScore(gameId, {
            username: `Filler${i + 1}`,
            score: top - i * 1000,
            submittedBy: `filler-${i + 1}`,
        });
    }
}

// ── Migration 124 / FK correctness ──────────────────────────────────────────

describe('migration 124 — global_game_pins', () => {
    it('(a) accepts a real pin INSERT on a fresh DB (proves the FK target is global_games(id))', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const gameId = await makeGame('Medieval Madness');

        // The handoff spec said REFERENCES global_games(global_game_id). SQLite
        // creates that table happily and only reports `foreign key mismatch` at
        // DML time — so asserting the migration ran proves nothing. This insert
        // is the actual regression guard.
        await expect(db.run(
            `INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES (?, ?)`,
            'disc-1', gameId,
        )).resolves.toBeDefined();

        const row = await db.get('SELECT * FROM global_game_pins WHERE discord_user_id = ?', 'disc-1');
        expect(row.global_game_id).toBe(gameId);
        expect(row.created_at).toBeTruthy();
    });

    it('(b) rejects a pin on a non-existent game and cascades on catalogue delete', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const gameId = await makeGame('Attack from Mars');
        await db.run(`INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES ('d', ?)`, gameId);

        await expect(db.run(
            `INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES ('d', 'no-such-game')`,
        )).rejects.toThrow();

        await db.run('DELETE FROM global_games WHERE id = ?', gameId);
        const left = await db.all('SELECT * FROM global_game_pins');
        expect(left.length).toBe(0);
    });
});

// ── Pin / unpin endpoints ───────────────────────────────────────────────────

describe('pin endpoints', () => {
    it('(c) pin is idempotent, unpin is idempotent, and pin_count tracks the user total', async () => {
        const app = await createTestApp();
        const g1 = await makeGame('Twilight Zone');
        const g2 = await makeGame('Monster Bash');
        const auth = { Authorization: `Bearer ${playerToken('disc-1')}` };

        const first = await request(app).post(`/api/global/games/${g1}/pin`).set(auth);
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ pinned: true, pin_count: 1 });

        // Re-pin: 200 no-op, count unchanged.
        const again = await request(app).post(`/api/global/games/${g1}/pin`).set(auth);
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ pinned: true, pin_count: 1 });

        const second = await request(app).post(`/api/global/games/${g2}/pin`).set(auth);
        expect(second.body.pin_count).toBe(2);

        const off = await request(app).delete(`/api/global/games/${g1}/pin`).set(auth);
        expect(off.status).toBe(200);
        expect(off.body).toEqual({ pinned: false, pin_count: 1 });

        // Unpin something never pinned: still 200.
        const offAgain = await request(app).delete(`/api/global/games/${g1}/pin`).set(auth);
        expect(offAgain.status).toBe(200);
        expect(offAgain.body).toEqual({ pinned: false, pin_count: 1 });
    });

    it('(d) 404s an unknown game and 401s without a token', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-1')}` };

        const missing = await request(app).post('/api/global/games/not-a-game/pin').set(auth);
        expect(missing.status).toBe(404);

        expect((await request(app).post('/api/global/games/x/pin')).status).toBe(401);
        expect((await request(app).delete('/api/global/games/x/pin')).status).toBe(401);
        expect((await request(app).get('/api/global/pins')).status).toBe(401);
    });

    it('(e) a google:* identity can pin — nothing here parses the id shape', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Cactus Canyon');
        const auth = { Authorization: `Bearer ${playerToken('google:10293847')}` };

        const res = await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);
        expect(res.status).toBe(200);
        expect(res.body.pin_count).toBe(1);

        const list = await request(app).get('/api/global/pins').set(auth);
        expect(list.status).toBe(200);
        expect(list.body.pins.length).toBe(1);
        expect(list.body.pins[0].global_game_id).toBe(gameId);
    });

    it('(f) GET /pins carries the card rows + my rank, newest first, and seeds last_known_rank', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const g1 = await makeGame('Theatre of Magic');
        const g2 = await makeGame('Tron: Legacy');
        await addScore(g1, { username: 'Champ', score: 9000, submittedBy: 'disc-champ' });
        await addScore(g1, { username: 'Me', score: 5000, submittedBy: 'disc-me' });

        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        await request(app).post(`/api/global/games/${g1}/pin`).set(auth);
        await request(app).post(`/api/global/games/${g2}/pin`).set(auth);

        // Seeded at pin time from the viewer's live rank.
        const seeded = await db.get(
            'SELECT last_known_rank FROM global_game_pins WHERE discord_user_id = ? AND global_game_id = ?',
            'disc-me', g1,
        );
        expect(seeded.last_known_rank).toBe(2);
        const noScore = await db.get(
            'SELECT last_known_rank FROM global_game_pins WHERE discord_user_id = ? AND global_game_id = ?',
            'disc-me', g2,
        );
        expect(noScore.last_known_rank).toBeNull();

        const res = await request(app).get('/api/global/pins').set(auth);
        expect(res.status).toBe(200);
        // created_at DESC — g2 was pinned last.
        expect(res.body.pins.map((p: any) => p.global_game_id)).toEqual([g2, g1]);

        const withScores = res.body.pins.find((p: any) => p.global_game_id === g1);
        // v2.55.0: rows, not a lone champion — the rail renders the grid's card.
        expect(withScores.top_scores.map((s: any) => s.iscored_username)).toEqual(['Champ', 'Me']);
        expect(withScores.top_scores[0].score).toBe(9000);
        expect('top_player' in withScores).toBe(false);
        expect(withScores.top_score).toBe(9000);
        expect(withScores.score_count).toBe(2);
        expect(withScores.my_rank).toBe(2);
        expect(withScores.my_score).toBe(5000);
        expect(withScores.rank_delta).toBe(0); // seeded == current

        const empty = res.body.pins.find((p: any) => p.global_game_id === g2);
        expect(empty.top_scores).toEqual([]);
        expect(empty.neighbors).toEqual([]);
        expect(empty.my_rank).toBeNull();
        expect(empty.rank_delta).toBeNull();
    });

    // ── v2.55.0 — the payload the full card needs ───────────────────────────
    it('(f2) top_scores is capped at the 6 rows the card renders, best first', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Six Row Cap');
        await addFillerScores(gameId, 9, 90_000);
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);

        const res = await request(app).get('/api/global/pins').set(auth);
        const row = res.body.pins[0];
        expect(row.top_scores).toHaveLength(6);
        expect(row.top_scores.map((s: any) => s.score)).toEqual([90_000, 89_000, 88_000, 87_000, 86_000, 85_000]);
        // Same entry shape the grid card's rows use, badge fields included.
        // v2.74.0 (S24.1): `avatar_url` joins the set — Google-linked users
        // store a full URL rather than a Discord CDN hash, and `PlayerAvatar`
        // prefers it. Additive; every pre-existing key is unchanged.
        expect(Object.keys(row.top_scores[0]).sort()).toEqual([
            'avatar_hash', 'avatar_url', 'discord_user_id', 'display_name', 'iscored_username',
            'origin_room_logo_url', 'origin_room_short_tag', 'origin_room_slug', 'score',
        ]);
    });

    it('(f3) neighbors ship only when the viewer ranks BELOW the six rendered rows', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };

        // Rank 9 of 9 — outside the card's six rows, so the "YOU" row needs data.
        const deep = await makeGame('Deep Board');
        await addFillerScores(deep, 8, 100_000);
        await addScore(deep, { username: 'Me', score: 55_000, submittedBy: 'disc-me' });

        // Rank 2 — already on the card; a neighbours read here would be wasted.
        const shallow = await makeGame('Shallow Board');
        await addScore(shallow, { username: 'F', score: 900, submittedBy: 'f-1' });
        await addScore(shallow, { username: 'Me', score: 800, submittedBy: 'disc-me' });

        await request(app).post(`/api/global/games/${deep}/pin`).set(auth);
        await request(app).post(`/api/global/games/${shallow}/pin`).set(auth);

        const res = await request(app).get('/api/global/pins').set(auth);
        const byId = Object.fromEntries(res.body.pins.map((p: any) => [p.global_game_id, p]));

        expect(byId[deep].my_rank).toBe(9);
        expect(byId[deep].neighbors.map((n: any) => n.rank)).toEqual([8, 9]);
        const you = byId[deep].neighbors.find((n: any) => n.rank === 9);
        expect(you.iscored_username).toBe('Me');
        expect(you.score).toBe(55_000);

        expect(byId[shallow].my_rank).toBe(2);
        expect(byId[shallow].neighbors).toEqual([]);
    });

    // The A4 contract and the handoff both write `last_known_rank - my_rank`
    // AND "negative = improved" — mutually exclusive. The sign convention is
    // what the badge renders, so it wins; this test pins that decision down.
    it('(g) rank_delta is negative when the viewer improved, positive when they dropped', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const gameId = await makeGame('Monster Bash');
        await addScore(gameId, { username: 'Me', score: 9999, submittedBy: 'disc-me' });
        // Pinned back when they sat at #5; they are #1 now.
        await db.run(
            `INSERT INTO global_game_pins (discord_user_id, global_game_id, created_at, last_known_rank)
             VALUES ('disc-me', ?, '2026-01-01T00:00:00.000Z', 5)`,
            gameId,
        );

        const pins = await GlobalPinService.list('disc-me');
        expect(pins[0].my_rank).toBe(1);
        expect(pins[0].rank_delta).toBe(-4); // negative = improved

        // Same viewer, now overtaken: two better scores push them to #3.
        await addScore(gameId, { username: 'A', score: 20_000, submittedBy: 'disc-a' });
        await addScore(gameId, { username: 'B', score: 15_000, submittedBy: 'disc-b' });
        await db.run(
            'UPDATE global_game_pins SET last_known_rank = 1 WHERE discord_user_id = ? AND global_game_id = ?',
            'disc-me', gameId,
        );
        const after = await GlobalPinService.list('disc-me');
        expect(after[0].my_rank).toBe(3);
        expect(after[0].rank_delta).toBe(2); // positive = dropped
    });
});

// ── /api/global/scoreboard payload ──────────────────────────────────────────

describe('GET /api/global/scoreboard — per-viewer context', () => {
    /** The exact per-game key set the endpoint shipped before A4. */
    // v2.59.0 (ADR 0016 P4) added `category` + `card_id` to every row. Those
    // are ADDITIVE and viewer-independent — the point of this assertion is that
    // the four PER-VIEWER keys never appear without a token, which the explicit
    // loop below checks directly.
    const PRE_A4_KEYS = [
        'global_game_id', 'name', 'display_name', 'manufacturer', 'year', 'type',
        'image_url', 'local_image_path', 'wheel_image_path', 'platforms',
        'score_count', 'top_score', 'last_submitted_at', 'popularity',
        'avg_rating', 'rating_count', 'top_scores',
        'category', 'card_id',
    ].sort();

    it('(h) an ANONYMOUS request returns exactly the pre-A4 payload — no new keys leak in', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Medieval Madness');
        await addScore(gameId, { username: 'Champ', score: 9000, submittedBy: 'disc-champ' });

        const res = await request(app).get('/api/global/scoreboard');
        expect(res.status).toBe(200);
        // v2.57.0 (A5a) added exactly ONE top-level key, `hero` (page 1 only).
        // The per-game row shape below is what must stay frozen.
        expect(Object.keys(res.body).sort()).toEqual(['data', 'hasMore', 'hero', 'total']);

        const row = res.body.data[0];
        expect(Object.keys(row).sort()).toEqual(PRE_A4_KEYS);
        // Belt-and-braces: absent, not merely null.
        for (const key of ['is_pinned', 'my_rank', 'my_score', 'neighbors', 'pinned_at']) {
            expect(key in row).toBe(false);
        }
    });

    it('(i) an AUTHENTICATED request carries is_pinned / my_rank / my_score / neighbors', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Medieval Madness');
        await addFillerScores(gameId, 8, 100_000);
        await addScore(gameId, { username: 'Me', score: 55_000, submittedBy: 'disc-me' });
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);

        const res = await request(app).get('/api/global/scoreboard').set(auth);
        expect(res.status).toBe(200);
        const row = res.body.data[0];
        expect(row.is_pinned).toBe(true);
        // 100k, 99k … 93k are the 8 fillers; 55k lands last → rank 9.
        expect(row.my_rank).toBe(9);
        expect(row.my_score).toBe(55_000);
        expect(row.neighbors.map((n: any) => n.rank)).toEqual([8, 9]);
        expect(row.neighbors.every((n: any) => typeof n.rank === 'number')).toBe(true);
    });

    it('(j) neighbors at rank 1 / rank 4 / no score / a game with fewer than 6 scores', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };

        // rank 1 — no rank 0 exists, so only 1 and 2 come back.
        const top = await makeGame('AAA Rank One');
        await addFillerScores(top, 5, 50_000);
        await addScore(top, { username: 'Me', score: 999_999, submittedBy: 'disc-me' });

        // rank 4 of 10.
        const mid = await makeGame('BBB Rank Four');
        await addScore(mid, { username: 'F1', score: 100_000, submittedBy: 'f1' });
        await addScore(mid, { username: 'F2', score: 90_000, submittedBy: 'f2' });
        await addScore(mid, { username: 'F3', score: 80_000, submittedBy: 'f3' });
        await addScore(mid, { username: 'Me', score: 70_000, submittedBy: 'disc-me' });
        await addFillerScores(mid, 6, 60_000);

        // viewer has no score at all.
        const none = await makeGame('CCC No Score');
        await addFillerScores(none, 3, 10_000);

        // fewer than 6 scores total, viewer is rank 2 of 3.
        const small = await makeGame('DDD Small Board');
        await addScore(small, { username: 'F1', score: 500, submittedBy: 'sf1' });
        await addScore(small, { username: 'Me', score: 400, submittedBy: 'disc-me' });
        await addScore(small, { username: 'F2', score: 300, submittedBy: 'sf2' });

        const res = await request(app).get('/api/global/scoreboard?sort=name_asc&limit=50').set(auth);
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(res.body.data.map((g: any) => [g.global_game_id, g]));

        expect(byId[top].my_rank).toBe(1);
        expect(byId[top].neighbors.map((n: any) => n.rank)).toEqual([1, 2]);

        expect(byId[mid].my_rank).toBe(4);
        expect(byId[mid].neighbors.map((n: any) => n.rank)).toEqual([3, 4, 5]);

        expect(byId[none].my_rank).toBeNull();
        expect(byId[none].my_score).toBeNull();
        expect(byId[none].neighbors).toEqual([]);

        expect(byId[small].my_rank).toBe(2);
        expect(byId[small].neighbors.map((n: any) => n.rank)).toEqual([1, 2, 3]);
    });

    it('(k) sort=pinned puts pinned games first (newest pin leading); anonymous degrades to popular', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };

        // `hot` is the most popular by a wide margin, so any pinned-first
        // ordering has to actively beat it.
        const hot = await makeGame('Hot Popular Game');
        await addFillerScores(hot, 8, 100_000);
        const pinA = await makeGame('Pinned A');
        const pinB = await makeGame('Pinned B');
        await addScore(pinA, { username: 'F', score: 10, submittedBy: 'f-a' });

        await request(app).post(`/api/global/games/${pinA}/pin`).set(auth);
        await request(app).post(`/api/global/games/${pinB}/pin`).set(auth);

        const res = await request(app).get('/api/global/scoreboard?sort=pinned').set(auth);
        expect(res.status).toBe(200);
        const ids = res.body.data.map((g: any) => g.global_game_id);
        expect(ids.slice(0, 2)).toEqual([pinB, pinA]); // created_at DESC
        expect(ids[2]).toBe(hot);

        // Anonymous: same query must not error, and must not be pinned-ordered.
        const anon = await request(app).get('/api/global/scoreboard?sort=pinned');
        expect(anon.status).toBe(200);
        expect(anon.body.data[0].global_game_id).toBe(hot);
        expect('is_pinned' in anon.body.data[0]).toBe(false);
    });

    it('(l) is_pinned is false for unpinned games and true only for the pinning viewer', async () => {
        const app = await createTestApp();
        const mine = await makeGame('Mine');
        const theirs = await makeGame('Theirs');
        await request(app).post(`/api/global/games/${mine}/pin`)
            .set({ Authorization: `Bearer ${playerToken('disc-me')}` });
        await request(app).post(`/api/global/games/${theirs}/pin`)
            .set({ Authorization: `Bearer ${playerToken('disc-other')}` });

        const res = await request(app).get('/api/global/scoreboard?limit=50')
            .set({ Authorization: `Bearer ${playerToken('disc-me')}` });
        const byId = Object.fromEntries(res.body.data.map((g: any) => [g.global_game_id, g]));
        expect(byId[mine].is_pinned).toBe(true);
        expect(byId[theirs].is_pinned).toBe(false);
    });

    it('(m) sort=pinned does not inflate score_count (the pin lookup is not a join)', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        const gameId = await makeGame('Join Fanout Guard');
        await addFillerScores(gameId, 4, 4_000);
        await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);

        const res = await request(app).get('/api/global/scoreboard?sort=pinned').set(auth);
        expect(res.body.data[0].score_count).toBe(4);
    });
});
