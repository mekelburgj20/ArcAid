import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import { ScoreSyncPoller } from '../engine/ScoreSyncPoller.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import type { IScoredCreds } from '../utils/iscoredCreds.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// S2 (Phase 0) — engine harness. These regression-lock the three documented
// prod incidents, exercising the real engine code via minimal seams (a fake
// client factory, an extracted static lookup, an injectable clock) so no live
// Playwright/Discord/cron is needed. With this in place the standing
// "engine-mutating sprints add regression tests" rule is honorable.

const fakeClient = { connect: async () => {}, disconnect: async () => {} } as unknown as IScoredClient;
const creds = (username: string): IScoredCreds => ({
    username, password: 'p', publicUrl: '', gameroomName: username, source: 'env',
});

describe('IScoredSessionRegistry — per-account serialization (v2.10)', () => {
    it('runs withSession callbacks one at a time for the same account', async () => {
        const reg = IScoredSessionRegistry.getInstance();
        reg.setClientFactoryForTests(() => fakeClient);
        try {
            let active = 0;
            let maxConcurrent = 0;
            const work = () => reg.withSession(creds('shared-acct'), async () => {
                active++;
                maxConcurrent = Math.max(maxConcurrent, active);
                await new Promise((r) => setTimeout(r, 15));
                active--;
            });
            await Promise.all([work(), work(), work(), work()]);
            expect(maxConcurrent).toBe(1); // serialized: never two fns in flight
        } finally {
            reg.setClientFactoryForTests(null);
            await reg.shutdown();
        }
    });

    it('allows different accounts to run concurrently', async () => {
        const reg = IScoredSessionRegistry.getInstance();
        reg.setClientFactoryForTests(() => fakeClient);
        try {
            let active = 0;
            let maxConcurrent = 0;
            const work = (acct: string) => reg.withSession(creds(acct), async () => {
                active++;
                maxConcurrent = Math.max(maxConcurrent, active);
                await new Promise((r) => setTimeout(r, 15));
                active--;
            });
            await Promise.all([work('a'), work('b'), work('c')]);
            expect(maxConcurrent).toBeGreaterThan(1); // distinct accounts don't block each other
        } finally {
            reg.setClientFactoryForTests(null);
            await reg.shutdown();
        }
    });
});

describe('ScoreSyncPoller.findLocalGameForIscoredId — deterministic row pick (v2.7.2)', () => {
    it('picks the ACTIVE row even when a newer COMPLETED row shares the iscored_id', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('poller-pick', 'Poller Pick');
        const tId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'T', 'DG', 'pinball', '{}', 1, ?)`,
            tId, roomId,
        );
        const sharedIscoredId = '95570';
        // The COMPLETED row is created LATER, so a naive `created_at DESC` would
        // pick it. The status-pref in the ORDER BY must override recency.
        const completedId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, iscored_id, status, created_at, game_room_id)
             VALUES (?, ?, 'WHO dunnit (old)', ?, 'COMPLETED', '2026-05-01T00:00:00Z', ?)`,
            completedId, tId, sharedIscoredId, roomId,
        );
        const activeId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, iscored_id, status, created_at, game_room_id)
             VALUES (?, ?, 'WHO dunnit', ?, 'ACTIVE', '2026-04-01T00:00:00Z', ?)`,
            activeId, tId, sharedIscoredId, roomId,
        );

        const row = await ScoreSyncPoller.findLocalGameForIscoredId(db, sharedIscoredId, [roomId]);
        expect(row).toBeTruthy();
        expect(row.id).toBe(activeId);
        expect(row.name).toBe('WHO dunnit');
    });

    it('returns undefined when no rooms are supplied', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const row = await ScoreSyncPoller.findLocalGameForIscoredId(db, '95570', []);
        expect(row).toBeUndefined();
    });
});

describe('TournamentEngine.cleanupCronMatchesNow — cron field matching (v2.9)', () => {
    // 2026-06-17 is a Wednesday (getDay() === 3); 22:00 UTC.
    const wed2200 = new Date(Date.UTC(2026, 5, 17, 22, 0, 0));
    const matchAt = (cron: string, now: Date): boolean =>
        (TournamentEngine.getInstance() as unknown as {
            cleanupCronMatchesNow(c: string, tz: string, n: Date): boolean;
        }).cleanupCronMatchesNow(cron, 'UTC', now);

    it('matches when minute and hour line up', () => {
        expect(matchAt('0 22 * * *', wed2200)).toBe(true);
    });
    it('does not match a different hour', () => {
        expect(matchAt('0 23 * * *', wed2200)).toBe(false);
    });
    it('does not match a different minute', () => {
        expect(matchAt('30 22 * * *', wed2200)).toBe(false);
    });
    it('matches an hour range on the right day-of-week', () => {
        expect(matchAt('0 21-23 * * 3', wed2200)).toBe(true);
    });
    it('does not match the wrong day-of-week', () => {
        expect(matchAt('0 22 * * 1', wed2200)).toBe(false);
    });
    it('returns false for a malformed (4-field) cron', () => {
        expect(matchAt('0 22 * *', wed2200)).toBe(false);
    });
});
