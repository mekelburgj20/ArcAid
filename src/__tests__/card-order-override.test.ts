import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import {
    applyCardOrderOverride,
    CardOrderService,
    CARD_ORDER_SETTING_KEY,
    type CardOrderState,
    type StoredCardOrder,
} from '../services/CardOrderService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

/**
 * v2.118.0 — the admin's manual card order.
 *
 * The whole design rests on the override being SELF-INVALIDATING: nothing
 * hooks rotation, so every guarantee here is a property of the pure function
 * plus the fingerprint it is handed. Hence the exhaustive unit coverage of
 * `applyCardOrderOverride` before any endpoint is involved.
 */

const emitLeaderboardUpdated = vi.fn();

vi.mock('../api/websocket.js', () => ({
    emitSettingsUpdated: vi.fn(),
    emitLeaderboardUpdated: (...args: unknown[]) => emitLeaderboardUpdated(...args),
    emitScoreNew: vi.fn(),
    emitScoreNewGlobal: vi.fn(),
    emitLobbyEvent: vi.fn(),
    getIO: () => null,
}));

// ── pure-function fixtures ────────────────────────────────────────────────

const cards = (...ids: string[]) => ids.map(id => ({ id }));
const idsOf = (rows: Array<{ id: string }>) => rows.map(r => r.id);

function blob(order: string[], tournaments: StoredCardOrder['tournaments'] = {}, pins: string[] = []): StoredCardOrder {
    return { v: 1, savedAt: '2026-08-20T17:10:00.000Z', order, tournaments, pins };
}

function state(tournaments: CardOrderState['tournaments'], pinIds: string[] = []): CardOrderState {
    return { tournaments, pinIds };
}

describe('applyCardOrderOverride — slot-fill merge (test 1)', () => {
    it('refills the occupied slots with the manual order, worked example A', () => {
        // D=[DG',WG1,WG2,MG], L=[WG2,WG1,MG] → [DG',WG2,WG1,MG]: the rotated DG
        // returns to its configured slot, the manual WG/MG order survives.
        const D = cards('DG2', 'WG1', 'WG2', 'MG');
        const res = applyCardOrderOverride(D, blob(['WG2', 'WG1', 'MG']), state({}));
        expect(idsOf(res.cards)).toEqual(['DG2', 'WG2', 'WG1', 'MG']);
        expect(res.applied).toBe(true);
    });

    it('refills the occupied slots with the manual order, worked example B', () => {
        const D = cards('DG2', 'WG1', 'WG2', 'MG');
        const res = applyCardOrderOverride(D, blob(['MG', 'WG1', 'WG2']), state({}));
        expect(idsOf(res.cards)).toEqual(['DG2', 'MG', 'WG1', 'WG2']);
    });

    it('skips stored ids that no longer have a card', () => {
        const D = cards('A', 'B', 'C');
        const res = applyCardOrderOverride(D, blob(['GONE', 'C', 'B', 'ALSO-GONE']), state({}));
        expect(idsOf(res.cards)).toEqual(['A', 'C', 'B']);
    });

    it('is the identity when the manual order is the default order', () => {
        const D = cards('A', 'B', 'C');
        const res = applyCardOrderOverride(D, blob(['A', 'B', 'C']), state({}));
        expect(idsOf(res.cards)).toEqual(['A', 'B', 'C']);
        expect(res.applied).toBe(true);
    });

    it('returns the default order untouched for an empty / absent override', () => {
        const D = cards('A', 'B', 'C');
        expect(applyCardOrderOverride(D, null, state({})).cards).toBe(D);
        expect(applyCardOrderOverride(D, blob([]), state({})).applied).toBe(false);
        // Every stored id is gone → nothing to place → default order.
        const stale = applyCardOrderOverride(D, blob(['X', 'Y']), state({}));
        expect(stale.applied).toBe(false);
        expect(idsOf(stale.cards)).toEqual(['A', 'B', 'C']);
    });

    it('ignores duplicate ids in the stored list', () => {
        const D = cards('A', 'B', 'C');
        const res = applyCardOrderOverride(D, blob(['C', 'C', 'A']), state({}));
        expect(idsOf(res.cards)).toEqual(['C', 'B', 'A']);
    });
});

describe('applyCardOrderOverride — display_order edits discard everything (test 2)', () => {
    const stored = blob(['C', 'B', 'A'], {
        t1: { displayOrder: 0, activeGameIds: ['A'] },
        t2: { displayOrder: 1, activeGameIds: ['B'] },
    });

    it('discards the WHOLE override when any fingerprinted tournament moved', () => {
        const res = applyCardOrderOverride(cards('A', 'B', 'C'), stored, state({
            t1: { displayOrder: 5, activeGameIds: ['A'] },
            t2: { displayOrder: 1, activeGameIds: ['B'] },
        }));
        expect(res.applied).toBe(false);
        expect(idsOf(res.cards)).toEqual(['A', 'B', 'C']);
    });

    it('keeps the override when the positions are unchanged', () => {
        const res = applyCardOrderOverride(cards('A', 'B', 'C'), stored, state({
            t1: { displayOrder: 0, activeGameIds: ['A'] },
            t2: { displayOrder: 1, activeGameIds: ['B'] },
        }));
        expect(res.applied).toBe(true);
        expect(idsOf(res.cards)).toEqual(['C', 'B', 'A']);
    });

    it('does NOT discard because a tournament was deleted or deactivated', () => {
        // t2 is simply gone from the current state — that is not an admin
        // editing the configured positions, so it must not reset anything.
        const res = applyCardOrderOverride(cards('A', 'C'), stored, state({
            t1: { displayOrder: 0, activeGameIds: ['A'] },
        }));
        expect(res.applied).toBe(true);
        expect(idsOf(res.cards)).toEqual(['C', 'A']);
    });
});

describe('applyCardOrderOverride — rotation drops one tournament (test 3)', () => {
    const stored = blob(['P', 'C', 'B', 'A'], {
        t1: { displayOrder: 0, activeGameIds: ['A'] },
        t2: { displayOrder: 1, activeGameIds: ['B'] },
        t3: { displayOrder: 2, activeGameIds: ['C'] },
    }, ['P']);

    it('drops only the rotated tournament, other manual order survives', () => {
        // t1 promoted A → A2. D is the configured order with the new card.
        const res = applyCardOrderOverride(cards('P', 'A2', 'B', 'C'), stored, state({
            t1: { displayOrder: 0, activeGameIds: ['A2'] },
            t2: { displayOrder: 1, activeGameIds: ['B'] },
            t3: { displayOrder: 2, activeGameIds: ['C'] },
        }, ['P']));
        // L = [P, C, B] → slots 0,2,3 refilled in that order; A2 keeps slot 1.
        expect(idsOf(res.cards)).toEqual(['P', 'A2', 'C', 'B']);
    });

    it('drops a tournament that was DEACTIVATED down to no active games', () => {
        const res = applyCardOrderOverride(cards('P', 'B', 'C'), stored, state({
            t1: { displayOrder: 0, activeGameIds: [] },
            t2: { displayOrder: 1, activeGameIds: ['B'] },
            t3: { displayOrder: 2, activeGameIds: ['C'] },
        }, ['P']));
        expect(idsOf(res.cards)).toEqual(['P', 'C', 'B']);
    });

    it('keeps pins in their manual position and lets an unpinned id vanish', () => {
        const withTwoPins = blob(['P2', 'A', 'P1'], {
            t1: { displayOrder: 0, activeGameIds: ['A'] },
        }, ['P1', 'P2']);
        // P2 was unpinned since the save: it just is not a card any more.
        const res = applyCardOrderOverride(cards('A', 'P1'), withTwoPins, state({
            t1: { displayOrder: 0, activeGameIds: ['A'] },
        }, ['P1']));
        expect(idsOf(res.cards)).toEqual(['A', 'P1']);
        expect(res.applied).toBe(true);
    });
});

describe('applyCardOrderOverride — multi-slot tournaments (test 6, pure)', () => {
    const stored = blob(['D1', 'W2', 'W1'], {
        dg: { displayOrder: 0, activeGameIds: ['D1'] },
        wg: { displayOrder: 1, activeGameIds: ['W1', 'W2'] },
    });

    it('survives an UNRELATED tournament rotating', () => {
        const res = applyCardOrderOverride(cards('D1b', 'W1', 'W2'), stored, state({
            dg: { displayOrder: 0, activeGameIds: ['D1b'] },
            wg: { displayOrder: 1, activeGameIds: ['W1', 'W2'] },
        }));
        expect(idsOf(res.cards)).toEqual(['D1b', 'W2', 'W1']);
    });

    it('survives one of its own slots being ADDED to (set changed) only for that tournament', () => {
        // Both WG slots rotated → the manual WG order goes.
        const res = applyCardOrderOverride(cards('D1', 'W3', 'W4'), stored, state({
            dg: { displayOrder: 0, activeGameIds: ['D1'] },
            wg: { displayOrder: 1, activeGameIds: ['W3', 'W4'] },
        }));
        expect(idsOf(res.cards)).toEqual(['D1', 'W3', 'W4']);
    });

    it('compares the active set order-insensitively', () => {
        // loadCurrentState always sorts, but a hand-written / legacy blob might
        // not — the same set in a different order is NOT a rotation.
        const unsorted = blob(['D1', 'W2', 'W1'], {
            wg: { displayOrder: 1, activeGameIds: ['W1', 'W2'] },
        });
        const res = applyCardOrderOverride(cards('D1', 'W1', 'W2'), unsorted, state({
            wg: { displayOrder: 1, activeGameIds: ['W1', 'W2'] },
        }));
        expect(idsOf(res.cards)).toEqual(['D1', 'W2', 'W1']);
    });
});

// ── DB-backed tests ───────────────────────────────────────────────────────

async function makeGame(tournamentId: string, name: string, startDate: string, status = 'ACTIVE') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date) VALUES (?, ?, ?, ?, ?)`,
        id, tournamentId, name, status, startDate,
    );
    return id;
}

async function setTournamentOrder(tournamentId: string, order: number) {
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET display_order = ? WHERE id = ?', order, tournamentId);
}

async function boardIds(roomId: string) {
    return (await LeaderboardService.getActiveLeaderboards(roomId)).map(b => b.gameId);
}

describe('getActiveLeaderboards applies the stored order (test 4)', () => {
    it('renders the manual order, then returns a rotated card to its tournament slot', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const t1 = await createTestTournament(roomId, { name: 'Daily' });
        const t2 = await createTestTournament(roomId, { name: 'Weekly' });
        const t3 = await createTestTournament(roomId, { name: 'Monthly' });
        await setTournamentOrder(t1, 0);
        await setTournamentOrder(t2, 1);
        await setTournamentOrder(t3, 2);
        const a1 = await makeGame(t1, 'Alpha', '2026-08-01T00:00:00.000Z');
        const a2 = await makeGame(t2, 'Bravo', '2026-08-02T00:00:00.000Z');
        const a3 = await makeGame(t3, 'Charlie', '2026-08-03T00:00:00.000Z');

        expect(await boardIds(roomId)).toEqual([a1, a2, a3]);

        const saved = await CardOrderService.save(roomId, [a3, a2, a1]);
        expect(saved.ok).toBe(true);
        expect(await boardIds(roomId)).toEqual([a3, a2, a1]);

        // t1 rotates: Alpha completes, a new game takes the slot.
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, a1);
        const a1b = await makeGame(t1, 'Delta', '2026-08-04T00:00:00.000Z');

        // t1's card is back in its configured slot; t2/t3 keep the manual swap.
        expect(await boardIds(roomId)).toEqual([a1b, a3, a2]);
    });

    it('makes exactly one settings read and no state query when no override is stored', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const t1 = await createTestTournament(roomId);
        await makeGame(t1, 'Alpha', '2026-08-01T00:00:00.000Z');

        const spy = vi.spyOn(CardOrderService, 'loadCurrentState');
        await LeaderboardService.getActiveLeaderboards(roomId);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('ignores a malformed stored blob instead of throwing', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const t1 = await createTestTournament(roomId);
        const a1 = await makeGame(t1, 'Alpha', '2026-08-01T00:00:00.000Z');
        await GameRoomSettingsService.set(roomId, CARD_ORDER_SETTING_KEY, '{not json');

        expect(await boardIds(roomId)).toEqual([a1]);
    });
});

describe('multi-slot manual order end-to-end (test 6)', () => {
    it('survives an unrelated rotation and an unrelated settings save, dies when both slots rotate', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const dg = await createTestTournament(roomId, { name: 'Daily' });
        const wg = await createTestTournament(roomId, { name: 'Weekly' });
        await setTournamentOrder(dg, 0);
        await setTournamentOrder(wg, 1);
        const d1 = await makeGame(dg, 'Alpha', '2026-08-01T00:00:00.000Z');
        const w1 = await makeGame(wg, 'Bravo', '2026-08-02T00:00:00.000Z');
        const w2 = await makeGame(wg, 'Charlie', '2026-08-03T00:00:00.000Z');

        expect(await boardIds(roomId)).toEqual([d1, w1, w2]);
        await CardOrderService.save(roomId, [d1, w2, w1]);
        expect(await boardIds(roomId)).toEqual([d1, w2, w1]);

        // Unrelated settings write — nothing to do with card order.
        await GameRoomSettingsService.set(roomId, 'SCOREBOARD_STYLE', 'showcase');
        expect(await boardIds(roomId)).toEqual([d1, w2, w1]);

        // DG rotates. WG's manual swap survives.
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, d1);
        const d1b = await makeGame(dg, 'Delta', '2026-08-04T00:00:00.000Z');
        expect(await boardIds(roomId)).toEqual([d1b, w2, w1]);

        // Both WG slots rotate → WG falls back to its configured order.
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id IN (?, ?)`, w1, w2);
        const w3 = await makeGame(wg, 'Echo', '2026-08-05T00:00:00.000Z');
        const w4 = await makeGame(wg, 'Foxtrot', '2026-08-06T00:00:00.000Z');
        expect(await boardIds(roomId)).toEqual([d1b, w3, w4]);
    });

    it('resets everything when a tournament display_order is edited', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        const dg = await createTestTournament(roomId, { name: 'Daily' });
        const wg = await createTestTournament(roomId, { name: 'Weekly' });
        await setTournamentOrder(dg, 0);
        await setTournamentOrder(wg, 1);
        const d1 = await makeGame(dg, 'Alpha', '2026-08-01T00:00:00.000Z');
        const w1 = await makeGame(wg, 'Bravo', '2026-08-02T00:00:00.000Z');

        await CardOrderService.save(roomId, [w1, d1]);
        expect(await boardIds(roomId)).toEqual([w1, d1]);

        await setTournamentOrder(wg, 7);
        expect(await boardIds(roomId)).toEqual([d1, w1]);
        expect((await CardOrderService.getStatus(roomId)).active).toBe(false);
    });
});

// ── endpoints ─────────────────────────────────────────────────────────────

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function adminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

describe('card-order endpoints (test 5)', () => {
    beforeEach(() => {
        emitLeaderboardUpdated.mockClear();
    });

    async function seed() {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const t1 = await createTestTournament(roomId, { name: 'Daily' });
        const t2 = await createTestTournament(roomId, { name: 'Weekly' });
        await setTournamentOrder(t1, 0);
        await setTournamentOrder(t2, 1);
        const a = await makeGame(t1, 'Alpha', '2026-08-01T00:00:00.000Z');
        const b = await makeGame(t2, 'Bravo', '2026-08-02T00:00:00.000Z');
        return { app, roomId, a, b };
    }

    it('PUT rejects a stray id, names it, and broadcasts nothing', async () => {
        const { app, roomId, a } = await seed();
        const res = await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [a, 'not-a-card'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('not-a-card');
        expect(emitLeaderboardUpdated).not.toHaveBeenCalled();
    });

    it('PUT rejects a malformed body', async () => {
        const { app, roomId, a } = await seed();
        const dup = await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [a, a] });
        expect(dup.status).toBe(400);

        const empty = await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [] });
        expect(empty.status).toBe(400);
        expect(emitLeaderboardUpdated).not.toHaveBeenCalled();
    });

    it('PUT saves, broadcasts room-scoped once, and flips GET to active', async () => {
        const { app, roomId, a, b } = await seed();

        const before = await request(app)
            .get(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(before.body).toEqual({ active: false, savedAt: null });

        const res = await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [b, a] });

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(true);
        expect(typeof res.body.savedAt).toBe('string');
        expect(emitLeaderboardUpdated).toHaveBeenCalledTimes(1);
        expect(emitLeaderboardUpdated.mock.calls[0]![0]).toBe(roomId);

        const after = await request(app)
            .get(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(after.body.active).toBe(true);
        expect(after.body.savedAt).toBe(res.body.savedAt);

        expect(await boardIds(roomId)).toEqual([b, a]);
    });

    it('DELETE clears the override and broadcasts', async () => {
        const { app, roomId, a, b } = await seed();
        await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [b, a] });
        emitLeaderboardUpdated.mockClear();

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ active: false, savedAt: null });
        expect(emitLeaderboardUpdated).toHaveBeenCalledTimes(1);
        expect(emitLeaderboardUpdated.mock.calls[0]![0]).toBe(roomId);
        expect(await GameRoomSettingsService.get(roomId, CARD_ORDER_SETTING_KEY)).toBeNull();
        expect(await boardIds(roomId)).toEqual([a, b]);
    });

    it('writes an audit row for both writes', async () => {
        const { app, roomId, a, b } = await seed();
        await request(app)
            .put(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ gameIds: [b, a] });
        await request(app)
            .delete(`/api/rooms/${roomId}/admin/leaderboard/card-order`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT action FROM audit_log WHERE target_id = ? ORDER BY id ASC`, roomId,
        ) as Array<{ action: string }>;
        expect(rows.map(r => r.action)).toEqual(['leaderboard.card_order_set', 'leaderboard.card_order_clear']);
    });

    it('refuses another room admin (403) on all three verbs', async () => {
        const { app, roomId, a, b } = await seed();
        const otherRoom = await createTestRoom('other-room', 'Other Room');
        const other = adminToken(otherRoom);

        expect((await request(app).get(`/api/rooms/${roomId}/admin/leaderboard/card-order`).set('Authorization', `Bearer ${other}`)).status).toBe(403);
        expect((await request(app).put(`/api/rooms/${roomId}/admin/leaderboard/card-order`).set('Authorization', `Bearer ${other}`).send({ gameIds: [b, a] })).status).toBe(403);
        expect((await request(app).delete(`/api/rooms/${roomId}/admin/leaderboard/card-order`).set('Authorization', `Bearer ${other}`)).status).toBe(403);
        expect(emitLeaderboardUpdated).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller', async () => {
        const { app, roomId } = await seed();
        expect((await request(app).get(`/api/rooms/${roomId}/admin/leaderboard/card-order`)).status).toBe(401);
        expect((await request(app).delete(`/api/rooms/${roomId}/admin/leaderboard/card-order`)).status).toBe(401);
    });
});
