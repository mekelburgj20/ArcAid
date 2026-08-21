import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * `syncScoreToIScored` — telling a locked round apart from a broken gameroom.
 *
 * iScored answers **"Access Denied"** to two completely different situations:
 * the game is locked (the round closed), or Write access is switched off on the
 * gameroom. Same six characters, opposite operator actions — and until now both
 * landed as `iScored sync failed for "<game>" by <player>: Access Denied`, an
 * ERROR that reads like a broken integration even when nothing is wrong.
 *
 * Arcaid already knows which one it is. The pre-submit lookup requires
 * `status='ACTIVE'`, so a non-ACTIVE row at FAILURE time means the round closed
 * between the read and the write — rotation locking the game on iScored while a
 * submit was already in flight. That is routine, the score is safely in Arcaid
 * either way, and it belongs at WARN.
 *
 * The mocked client flips the game row inside `submitScore` precisely to
 * reproduce that race rather than to assert against a pre-arranged fixture.
 */

const warns: string[] = [];
const errors: string[] = [];

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return {
        ...actual,
        logWarn: (msg: unknown) => { warns.push(String(msg)); },
        logError: (msg: unknown) => { errors.push(String(msg)); },
        logInfo: () => {},
    };
});

/** Set by each test: what `submitScore` should do before it rejects. */
let beforeReject: (() => Promise<void>) | null = null;

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async submitScore(..._args: unknown[]) {
            if (beforeReject) await beforeReject();
            // Verbatim iScored behaviour: a plain-text rejection, surfaced by
            // IScoredApiClient as an Error.
            throw new Error('iScored rejected the submission: Access Denied');
        }
    },
}));

const { setupTestDb, createTestRoom, createTestTournament } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { syncScoreToIScored } = await import('../services/IScoredSubmitSync.js');

async function seedSyncableGame(slug: string) {
    const db = await getDatabase();
    const roomId = await createTestRoom(slug, slug);
    for (const [key, value] of [
        ['ISCORED_ENABLED', 'true'], ['ISCORED_USERNAME', 'acct'], ['ISCORED_PASSWORD', 'pw'],
        ['ISCORED_PUBLIC_URL', 'https://example.invalid/acct'],
    ]) {
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            roomId, key, value,
        );
    }
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
         VALUES (?, ?, 'WHO dunnit', '95570', 'ACTIVE', ?, datetime('now'))`,
        gameId, tournamentId, roomId,
    );
    return { db, roomId, gameId };
}

describe('syncScoreToIScored — Access Denied is two different problems', () => {
    beforeEach(async () => {
        await setupTestDb();
        warns.length = 0;
        errors.length = 0;
        beforeReject = null;
        delete process.env.ISCORED_API_ENABLED;
    });

    it('WARNs (not ERRORs) when the round closed underneath the submit', async () => {
        const { db, roomId, gameId } = await seedSyncableGame('lock-warn');
        // The race: rotation completes the game while this submit is in flight.
        beforeReject = async () => {
            await db.run(
                `UPDATE games SET status = 'COMPLETED', end_date = datetime('now') WHERE id = ?`, gameId);
        };

        await syncScoreToIScored({ roomId, gameName: 'WHO dunnit', username: 'DennisB', score: 1000 });

        expect(errors).toHaveLength(0);
        expect(warns.join('\n')).toContain(
            'iScored sync for "WHO dunnit" by DennisB was rejected by iScored — the game is locked (round closed); the score still counts in Arcaid.',
        );
    });

    it('ERRORs with the Write-access hint when the game is still live', async () => {
        const { roomId } = await seedSyncableGame('lock-error');

        await syncScoreToIScored({ roomId, gameName: 'WHO dunnit', username: 'DennisB', score: 1000 });

        expect(warns.filter((w) => w.includes('round closed'))).toHaveLength(0);
        const logged = errors.join('\n');
        // Existing text kept verbatim so log greps / alerting keep matching...
        expect(logged).toContain('iScored sync failed for "WHO dunnit" by DennisB:');
        // ...with the actionable half appended.
        expect(logged).toContain('(check that Write access is enabled on the iScored gameroom)');
    });

    it('treats a stamped end_date as closed even if the status column lags', async () => {
        const { db, roomId, gameId } = await seedSyncableGame('lock-enddate');
        beforeReject = async () => {
            await db.run(`UPDATE games SET end_date = datetime('now') WHERE id = ?`, gameId);
        };

        await syncScoreToIScored({ roomId, gameName: 'WHO dunnit', username: 'DennisB', score: 1000 });

        expect(errors).toHaveLength(0);
        expect(warns.join('\n')).toContain('the game is locked (round closed)');
    });
});
