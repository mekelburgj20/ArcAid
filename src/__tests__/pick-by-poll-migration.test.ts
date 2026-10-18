import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { pickByPoll } from '../database/migrations/pickByPoll.js';

/**
 * Migration 182 — Pick by poll is a rotation method (ADR 0026).
 *
 * The test DB is already fully migrated, so each case first winds the
 * tournaments table back to its v2.161.x shape (no `poll_picks`, `season_`
 * prefixed poll columns), then runs the handler.
 */

async function rewindTo161(): Promise<void> {
    const db = await getDatabase();
    await db.exec('ALTER TABLE tournaments DROP COLUMN poll_picks');
    await db.exec('ALTER TABLE tournaments RENAME COLUMN poll_opens_before_h TO season_poll_opens_before_h');
    await db.exec('ALTER TABLE tournaments RENAME COLUMN poll_closes_before_h TO season_poll_closes_before_h');
    await db.exec('ALTER TABLE tournaments RENAME COLUMN poll_tie_rule TO season_tie_rule');
}

async function columns(): Promise<Set<string>> {
    const db = await getDatabase();
    return new Set((await db.all<Array<{ name: string }>>('PRAGMA table_info(tournaments)')).map(c => c.name));
}

describe('migration 182_pick_by_poll', () => {
    let seasonId: string;
    let plainId: string;

    beforeEach(async () => {
        await setupTestDb();
        const roomId = await createTestRoom(`m182-${crypto.randomUUID().slice(0, 6)}`, 'M182');
        seasonId = await createTestTournament(roomId);
        plainId = await createTestTournament(roomId);
        await rewindTo161();
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET season_table_count = 12, season_poll_opens_before_h = 72,
                    season_poll_closes_before_h = 6, season_tie_rule = 'first_nominated' WHERE id = ?`,
            seasonId,
        );
    });

    it('adds poll_picks, backfills it for every existing season, and renames the three poll columns with their values', async () => {
        const db = await getDatabase();
        await pickByPoll(db);

        const cols = await columns();
        for (const c of ['poll_picks', 'poll_opens_before_h', 'poll_closes_before_h', 'poll_tie_rule']) expect(cols.has(c)).toBe(true);
        for (const c of ['season_poll_opens_before_h', 'season_poll_closes_before_h', 'season_tie_rule']) expect(cols.has(c)).toBe(false);
        // The dead fallback column is left alone.
        expect(cols.has('season_tie_fallback')).toBe(true);

        expect(await db.get('SELECT poll_picks, poll_opens_before_h, poll_closes_before_h, poll_tie_rule FROM tournaments WHERE id = ?', seasonId))
            .toEqual({ poll_picks: 1, poll_opens_before_h: 72, poll_closes_before_h: 6, poll_tie_rule: 'first_nominated' });
        expect(await db.get('SELECT poll_picks, poll_opens_before_h, poll_tie_rule FROM tournaments WHERE id = ?', plainId))
            .toEqual({ poll_picks: 0, poll_opens_before_h: 96, poll_tie_rule: 'admin' });
    });

    it('is idempotent: a second run changes nothing and never re-ticks a poll an admin switched off', async () => {
        const db = await getDatabase();
        await pickByPoll(db);
        await db.run('UPDATE tournaments SET poll_picks = 0 WHERE id = ?', seasonId);
        const before = await columns();

        await expect(pickByPoll(db)).resolves.toBeUndefined();

        expect(await columns()).toEqual(before);
        expect((await db.get('SELECT poll_picks FROM tournaments WHERE id = ?', seasonId)).poll_picks).toBe(0);
    });
});
