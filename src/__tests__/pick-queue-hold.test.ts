import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

// ---------------------------------------------------------------------------
// Pick-queue HOLD model (v2.126.0, owner spec 2026-08-21).
//
// "If a table is in their queue and it is next to be used, and that table is
// currently in cooldown, I want it to remain on a hold in their queue until
// the game is no longer in cooldown. At that point, it should be the top of
// their queue."
//
// Before this, every walker DELETEd the ineligible row: a player who queued a
// table a week too early simply lost the pick, learned nothing about it, and
// found out by watching something else go active. Now the row is stamped
// (`games.queue_held_at`), keeps its place, sorts ahead of the player's unheld
// picks, and wins outright the moment the cooldown clears.
//
// Every reader shares ONE ordering fragment (`queueOrderSql`), so what the
// Picks page shows is what the engine will do.
// ---------------------------------------------------------------------------

const PLAYER = '111111111111111111';

let counter = 0;

function playerToken(discordId = PLAYER) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' } as never);
}

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function setupTournament(opts: { maxActive?: number } = {}) {
    const db = await getDatabase();
    const slug = `hold-${++counter}`;
    const roomId = await createTestRoom(slug, `Hold Room ${counter}`);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: `Hold Cup ${counter}` });
    await db.run(
        'UPDATE tournaments SET max_active_games = ?, winner_picks = 1 WHERE id = ?',
        opts.maxActive ?? 1, tournamentId,
    );
    PickAwardGate.invalidate();
    return { roomId, tournamentId, slug };
}

/**
 * A COMPLETED run of `name` inside the lookback window — the thing
 * `isGameEligible` counts. Returned id so a test can push it out of the window.
 */
async function seedRecentlyPlayed(tournamentId: string, name: string): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date, end_date)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?)`,
        id, tournamentId, name, new Date().toISOString(), new Date().toISOString(),
    );
    return id;
}

async function queueRow(id: string) {
    const db = await getDatabase();
    return db.get('SELECT id, name, status, queue_order, queue_held_at FROM games WHERE id = ?', id);
}

describe('nextEligibleQueuedFor — the hold walker', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('holds a cooled-down head-of-queue pick and returns the next eligible one', async () => {
        const { tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();

        const a = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        const b = await engine.queueGame(tournamentId, 'Fresh Table', undefined, undefined, PLAYER);
        await seedRecentlyPlayed(tournamentId, 'Cooling Table');

        const next = await engine.nextEligibleQueuedFor(tournamentId, PLAYER);

        expect(next?.id).toBe(b.id);
        const held = await queueRow(a.id);
        expect(held).toBeDefined();
        expect(held.status).toBe('QUEUED');
        expect(held.queue_held_at).toBeTruthy();
    });

    it('a held pick wins outright once its cooldown clears, even from behind a newer pick', async () => {
        const db = await getDatabase();
        const { tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();

        const a = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        await engine.queueGame(tournamentId, 'Fresh Table', undefined, undefined, PLAYER);
        const blockerId = await seedRecentlyPlayed(tournamentId, 'Cooling Table');

        // Round 1 — the cooled-down pick goes on hold, the other one runs.
        await engine.nextEligibleQueuedFor(tournamentId, PLAYER);
        expect((await queueRow(a.id)).queue_held_at).toBeTruthy();

        // The player then queues something else, which lands at the BACK of
        // their stored order — and would have been next under the old rules.
        await engine.queueGame(tournamentId, 'Newest Table', undefined, undefined, PLAYER);
        // Consume the row that actually ran, so only queued rows remain.
        await db.run(`DELETE FROM games WHERE tournament_id = ? AND name = 'Fresh Table'`, tournamentId);

        // The cooldown expires (push the blocking run out of the lookback).
        const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
        await db.run('UPDATE games SET start_date = ?, end_date = ? WHERE id = ?', longAgo, longAgo, blockerId);

        const next = await engine.nextEligibleQueuedFor(tournamentId, PLAYER);
        expect(next?.id).toBe(a.id);
        expect(next?.name).toBe('Cooling Table');
    });

    it('never deletes: a second walk over a still-cooling pick leaves it alone', async () => {
        const { tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();

        const a = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        await seedRecentlyPlayed(tournamentId, 'Cooling Table');

        expect(await engine.nextEligibleQueuedFor(tournamentId, PLAYER)).toBeNull();
        const first = await queueRow(a.id);
        expect(await engine.nextEligibleQueuedFor(tournamentId, PLAYER)).toBeNull();
        const second = await queueRow(a.id);

        expect(second.status).toBe('QUEUED');
        // The stamp is set once — a re-walk must not keep resetting the clock,
        // because `queue_held_at ASC` is the tie-break between held picks.
        expect(second.queue_held_at).toBe(first.queue_held_at);
    });
});

describe('runMaintenance extra-slot loop — hold, not delete', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('parks a cooled-down queued row and activates the next eligible one instead', async () => {
        const { tournamentId } = await setupTournament({ maxActive: 1 });
        const engine = TournamentEngine.getInstance();

        const stale = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        const fresh = await engine.queueGame(tournamentId, 'Fresh Table', undefined, undefined, PLAYER);
        await seedRecentlyPlayed(tournamentId, 'Cooling Table');

        await engine.runMaintenance(tournamentId);

        const parked = await queueRow(stale.id);
        expect(parked).toBeDefined();
        expect(parked.status).toBe('QUEUED');
        expect(parked.queue_held_at).toBeTruthy();
        expect((await queueRow(fresh.id)).status).toBe('ACTIVE');
    });
});

describe('GET /:roomId/pick-status — held rows', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('lists the held pick first and flags it', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();

        const a = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        await engine.queueGame(tournamentId, 'Fresh Table', undefined, undefined, PLAYER);
        await seedRecentlyPlayed(tournamentId, 'Cooling Table');
        await engine.nextEligibleQueuedFor(tournamentId, PLAYER);
        // Park the held pick LAST by stored position: the HOLD, not
        // `queue_order`, is what must float it back to the top of the read.
        const db = await getDatabase();
        await db.run('UPDATE games SET queue_order = 99 WHERE id = ?', a.id);

        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .expect(200);

        expect(res.body.queueMax).toBe(30);
        const names = res.body.queuedGames.map((g: { game_name: string }) => g.game_name);
        expect(names[0]).toBe('Cooling Table');
        expect(res.body.queuedGames[0].held).toBe(true);
        expect(res.body.queuedGames[0].daysUntilAvailable).toBeGreaterThan(0);
        expect(res.body.queuedGames[1].held).toBe(false);
    });
});

describe('DELETE /:roomId/queue/:gameId — queue compaction', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('renumbers the remaining picks 1..N instead of leaving a hole', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();
        const db = await getDatabase();

        const one = await engine.queueGame(tournamentId, 'Table One', undefined, undefined, PLAYER);
        const two = await engine.queueGame(tournamentId, 'Table Two', undefined, undefined, PLAYER);
        const three = await engine.queueGame(tournamentId, 'Table Three', undefined, undefined, PLAYER);

        await request(app)
            .delete(`/api/rooms/${roomId}/queue/${two.id}`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .expect(200);

        const rows = await db.all(
            `SELECT id, queue_order FROM games WHERE tournament_id = ? AND status = 'QUEUED'
             ORDER BY queue_order ASC`,
            tournamentId,
        );
        expect(rows.map(r => r.queue_order)).toEqual([1, 2]);
        expect(rows.map(r => r.id)).toEqual([one.id, three.id]);
    });
});

describe('PUT /:roomId/queue/reorder — held rows are not reordered away', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('applies the supplied order to unheld picks and leaves the hold in place', async () => {
        const app = await createTestApp();
        const { roomId, tournamentId } = await setupTournament();
        const engine = TournamentEngine.getInstance();
        const db = await getDatabase();

        const held = await engine.queueGame(tournamentId, 'Cooling Table', undefined, undefined, PLAYER);
        const b = await engine.queueGame(tournamentId, 'Table B', undefined, undefined, PLAYER);
        const c = await engine.queueGame(tournamentId, 'Table C', undefined, undefined, PLAYER);
        await seedRecentlyPlayed(tournamentId, 'Cooling Table');
        await engine.nextEligibleQueuedFor(tournamentId, PLAYER);
        const heldStamp = (await queueRow(held.id)).queue_held_at;
        expect(heldStamp).toBeTruthy();

        // The FE sends the whole visible list (held row first, then the swap).
        await request(app)
            .put(`/api/rooms/${roomId}/queue/reorder`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .send({ gameIds: [held.id, c.id, b.id] })
            .expect(200);

        // The hold is untouched...
        expect((await queueRow(held.id)).queue_held_at).toBe(heldStamp);
        // ...and the unheld picks took positions 1 and 2, not 2 and 3.
        expect((await queueRow(c.id)).queue_order).toBe(1);
        expect((await queueRow(b.id)).queue_order).toBe(2);

        // The read the player gets back still puts the held pick first.
        const res = await request(app)
            .get(`/api/rooms/${roomId}/pick-status`)
            .set('Authorization', `Bearer ${playerToken()}`)
            .expect(200);
        expect(res.body.queuedGames.map((g: { game_name: string }) => g.game_name))
            .toEqual(['Cooling Table', 'Table C', 'Table B']);
        expect(await db.get('SELECT id FROM games WHERE id = ?', held.id)).toBeDefined();
    });
});
