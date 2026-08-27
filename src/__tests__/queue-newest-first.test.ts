import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';

/**
 * Newest-pick-inserts-at-#1 (owner ruling 2026-08-27, Picks-queue UX redesign).
 *
 * Pre-fix, `TournamentEngine.queueGame` allocated `MAX(queue_order)+1` — an
 * append. The owner's ruling flips that: "when I'm adding a table it's
 * because I'd rather play it sooner", so the newest pick always lands at
 * position 1 and everything the player already had queued shifts down one.
 */

let roomCounter = 0;

async function setup() {
    const roomId = await createTestRoom(`queue-newest-${++roomCounter}`, 'Queue Newest Room');
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    return { roomId, tournamentId };
}

async function queueOrderOf(id: string): Promise<number | null> {
    const db = await getDatabase();
    const row = await db.get('SELECT queue_order FROM games WHERE id = ?', id);
    return row?.queue_order ?? null;
}

describe('TournamentEngine.queueGame — newest-first', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('queuing three games in a row yields newest-first order (third has 1, first has 3)', async () => {
        const { tournamentId } = await setup();
        const engine = TournamentEngine.getInstance();

        const first = await engine.queueGame(tournamentId, 'First Game', undefined, undefined, 'PLAYER_A');
        const second = await engine.queueGame(tournamentId, 'Second Game', undefined, undefined, 'PLAYER_A');
        const third = await engine.queueGame(tournamentId, 'Third Game', undefined, undefined, 'PLAYER_A');

        // The returned object always reports the position it was inserted
        // at — always 1, since every insert happens at the front.
        expect(first.queueOrder).toBe(1);
        expect(second.queueOrder).toBe(1);
        expect(third.queueOrder).toBe(1);

        // The STORED positions are what matter after all three inserts.
        expect(await queueOrderOf(third.id)).toBe(1);
        expect(await queueOrderOf(second.id)).toBe(2);
        expect(await queueOrderOf(first.id)).toBe(3);
    });

    it('the shift skips NULL-order rows ([Pending Pick] placeholders)', async () => {
        const { tournamentId } = await setup();
        const db = await getDatabase();
        const engine = TournamentEngine.getInstance();

        // A pending-pick placeholder: queue_order NULL, sorts ahead of
        // everything via queueOrderSql, and must never be renumbered by the
        // shift (a NULL + 1 would turn it into a real, wrong position).
        const placeholderId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type)
             VALUES (?, ?, '[Pending Pick]', 'QUEUED', 'PLAYER_A', 'WINNER')`,
            placeholderId, tournamentId,
        );

        const one = await engine.queueGame(tournamentId, 'One', undefined, undefined, 'PLAYER_A');
        const two = await engine.queueGame(tournamentId, 'Two', undefined, undefined, 'PLAYER_A');

        expect(await queueOrderOf(placeholderId)).toBeNull();
        expect(await queueOrderOf(two.id)).toBe(1);
        expect(await queueOrderOf(one.id)).toBe(2);
    });

    it("other players' queues are unaffected — the shift is scoped per player", async () => {
        const { tournamentId } = await setup();
        const engine = TournamentEngine.getInstance();

        const bFirst = await engine.queueGame(tournamentId, 'B First', undefined, undefined, 'PLAYER_B');
        const bSecond = await engine.queueGame(tournamentId, 'B Second', undefined, undefined, 'PLAYER_B');

        // Player A queues twice — must not touch player B's positions.
        await engine.queueGame(tournamentId, 'A First', undefined, undefined, 'PLAYER_A');
        await engine.queueGame(tournamentId, 'A Second', undefined, undefined, 'PLAYER_A');

        expect(await queueOrderOf(bSecond.id)).toBe(1);
        expect(await queueOrderOf(bFirst.id)).toBe(2);
    });
});
