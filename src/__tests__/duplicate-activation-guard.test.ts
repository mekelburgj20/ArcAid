import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine, DuplicateActiveGameError } from '../engine/TournamentEngine.js';

/**
 * v2.103.0 — duplicate-activation guard (UAT field incident 2026-08-12).
 *
 * Two players held rotation-granted pick rights in WG-VPXS and picked "Tales
 * from the Crypt" five minutes apart; BOTH activations landed, creating twin
 * ACTIVE rows and twin iScored boards. Cooldown only inspects finished games,
 * so a live twin passed every existing check. `activateGame` is the one
 * chokepoint all four interactive surfaces route through (web pick, admin
 * activate, Discord /pick-game + /activate-game) — it now throws
 * `DuplicateActiveGameError` when a same-name ACTIVE row exists; the
 * queued-promotion loop in maintenance has a skip-and-stay-queued twin check.
 */
describe('duplicate-activation guard', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('activateGame (multi-slot mode) throws on a same-name ACTIVE twin', async () => {
        const roomId = await createTestRoom('dup-guard-room', 'Dup Guard');
        const tournamentId = await createTestTournament(roomId, { name: 'Dup Guard DG' });
        const engine = TournamentEngine.getInstance();

        await engine.activateGame(tournamentId, 'Tales from the Crypt', undefined, undefined, false);
        await expect(
            engine.activateGame(tournamentId, 'tales from the crypt', undefined, undefined, false),
        ).rejects.toBeInstanceOf(DuplicateActiveGameError);
    });

    it('single-slot rotation (completeExisting) still re-activates the same name — the incumbent completes first', async () => {
        const roomId = await createTestRoom('dup-guard-room-2', 'Dup Guard 2');
        const tournamentId = await createTestTournament(roomId, { name: 'Dup Guard DG 2' });
        const engine = TournamentEngine.getInstance();

        await engine.activateGame(tournamentId, 'Repeat Game', undefined, undefined, false);
        // completeExisting=true completes the incumbent before inserting, so
        // no live twin exists at check time — rotation replays are unaffected.
        const game = await engine.activateGame(tournamentId, 'Repeat Game', undefined, undefined, true);
        expect(game.status).toBe('ACTIVE');
    });
});

/**
 * A47 (v2.284.0) — the admin Activate paths pass `promoteQueued`: a table
 * already waiting in the queue goes live from its queued row instead of a
 * second row being inserted beside it (Mox's Game Room 2026-11-27: Activate on
 * a poll winner left the queued copy to run again the next week).
 */
describe('activateGame promoteQueued', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function rowsNamed(tournamentId: string, name: string) {
        const db = await getDatabase();
        return db.all('SELECT id, status, queue_order, queue_held_at, start_date FROM games WHERE tournament_id = ? AND LOWER(name) = LOWER(?) ORDER BY status', tournamentId, name);
    }

    it('promotes the queued row in place: same id, ACTIVE, out of the queue, no second row', async () => {
        const roomId = await createTestRoom('promote-room', 'Promote');
        const tournamentId = await createTestTournament(roomId, { name: 'Promote T' });
        const engine = TournamentEngine.getInstance();
        const queued = await engine.queueGame(tournamentId, "Viper Night Drivin'");

        const game = await engine.activateGame(tournamentId, "viper night drivin'", undefined, undefined, false,
            { actor: 'admin:1', source: 'admin_manual' }, { promoteQueued: true });

        expect(game.id).toBe(queued.id);
        expect(game.name).toBe("Viper Night Drivin'");
        const rows = await rowsNamed(tournamentId, "Viper Night Drivin'");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: queued.id, status: 'ACTIVE', queue_order: null, queue_held_at: null });
        expect(rows[0].start_date).toBeTruthy();
    });

    it("compacts the owner's queue after taking a picked row out of it", async () => {
        const roomId = await createTestRoom('promote-room-2', 'Promote 2');
        const tournamentId = await createTestTournament(roomId, { name: 'Promote T2' });
        const engine = TournamentEngine.getInstance();
        const picker = '200000000000000001';
        await engine.queueGame(tournamentId, 'Older Pick', undefined, undefined, picker);
        await engine.queueGame(tournamentId, 'Newer Pick', undefined, undefined, picker); // position 1, Older is 2

        await engine.activateGame(tournamentId, 'Newer Pick', undefined, undefined, false,
            { actor: 'admin:1', source: 'admin_manual' }, { promoteQueued: true });

        const [older] = await rowsNamed(tournamentId, 'Older Pick');
        expect(older).toMatchObject({ status: 'QUEUED', queue_order: 1 });
    });

    it('inserts as before when nothing of that name is queued, and without the option', async () => {
        const roomId = await createTestRoom('promote-room-3', 'Promote 3');
        const tournamentId = await createTestTournament(roomId, { name: 'Promote T3' });
        const engine = TournamentEngine.getInstance();

        const fresh = await engine.activateGame(tournamentId, 'Not Queued', undefined, undefined, false,
            { actor: 'admin:1', source: 'admin_manual' }, { promoteQueued: true });
        expect((await rowsNamed(tournamentId, 'Not Queued')).map((r: any) => r.id)).toEqual([fresh.id]);

        // A player pick (no option) leaves another queue's row alone.
        const queued = await engine.queueGame(tournamentId, 'Someone Elses Pick');
        const picked = await engine.activateGame(tournamentId, 'Someone Elses Pick', undefined, undefined, false);
        expect(picked.id).not.toBe(queued.id);
        expect((await rowsNamed(tournamentId, 'Someone Elses Pick')).map((r: any) => r.status)).toEqual(['ACTIVE', 'QUEUED']);
    });
});
