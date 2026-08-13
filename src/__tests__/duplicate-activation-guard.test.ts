import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
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
