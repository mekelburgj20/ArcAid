import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { foldSyntheticRoomMembers } from '../database/migrations/foldSyntheticRoomMembers.js';

/**
 * Migration 159 (v2.127.0) replayed over prod-shaped legacy rows.
 *
 * The migration runs on a FRESH test database with nothing to do, so — like
 * `engine-device-provenance.test.ts` does for 125 — this seeds the legacy
 * shapes afterwards and calls the handler directly. Everything it must decide
 * is represented: a synthetic member with a real twin, one without, one whose
 * name nobody linked, NULLed sync rows with and without a mapping, and one
 * sitting inside a COMPLETED tournament.
 */

const REAL = '123456789012345678';
const OTHER = '223456789012345678';

async function seedLegacy() {
    const db = await getDatabase();
    const roomA = await createTestRoom('m159-a', 'Room A');
    const roomB = await createTestRoom('m159-b', 'Room B');

    // Mappings: Wyo and DennisB are linked; StopNudgingMe is not.
    await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'Wyo')`, REAL);
    await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'DennisB')`, OTHER);

    // (1) synthetic member WITH a real twin — older synthetic joined_at, a
    //     display name the real row lacks.
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
         VALUES ('iscored:Wyo', ?, '2026-01-01 00:00:00', 'submission', 'Wyo')`, roomA);
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
         VALUES (?, ?, '2026-06-01 00:00:00', 'self_join', NULL)`, REAL, roomA);

    // (2) synthetic member with NO real twin — case-differing alias casing too.
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source, display_name)
         VALUES ('iscored:dennisb', ?, '2026-02-02 00:00:00', 'submission', 'dennisb')`, roomB);

    // (3) synthetic member for an UNLINKED board name — not a member at all.
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source)
         VALUES ('iscored:StopNudgingMe', ?, '2026-03-03 00:00:00', 'submission')`, roomA);

    const doneTournament = 't-done';
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Old Grind', 'DG', 'pinball', '{}', 0, ?)`, doneTournament, roomA);

    const sh = async (name: string, tournamentId: string | null) => {
        const res = await db.run(
            `INSERT INTO score_history
                (game_name, game_room_id, iscored_username, discord_user_id, score, source,
                 submitted_during_tournament_id, submitted_by_user_id, submitted_by_anonymous_name)
             VALUES ('WHO dunnit', ?, ?, ?, 1000, 'sync', ?, NULL, ?)`,
            roomA, name, `iscored:${name}`, tournamentId, name,
        );
        return res.lastID as number;
    };

    // (4) NULLed sync rows — migration 157's residue.
    const wyoLive = await sh('Wyo', null);
    const wyoFrozen = await sh('Wyo', doneTournament);
    const unlinked = await sh('StopNudgingMe', null);

    // (5) the same in `submissions`.
    await db.run(
        `INSERT INTO submissions
            (id, game_id, discord_user_id, iscored_username, score, timestamp,
             submitted_by_user_id, submitted_by_anonymous_name)
         VALUES ('sub-wyo', NULL, 'iscored:Wyo', 'Wyo', 2000, datetime('now'), NULL, 'Wyo')`);
    await db.run(
        `INSERT INTO submissions
            (id, game_id, discord_user_id, iscored_username, score, timestamp,
             submitted_by_user_id, submitted_by_anonymous_name)
         VALUES ('sub-nudge', NULL, 'iscored:StopNudgingMe', 'StopNudgingMe', 2000, datetime('now'), NULL, 'StopNudgingMe')`);

    return { roomA, roomB, wyoLive, wyoFrozen, unlinked };
}

describe('migration 159 — fold synthetic room_members + finish the 157 re-attribution', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('folds, purges and re-attributes exactly the legacy shapes', async () => {
        const { roomA, roomB, wyoLive, wyoFrozen, unlinked } = await seedLegacy();
        const db = await getDatabase();

        await foldSyntheticRoomMembers(db as any);

        // No synthetic identity survives anywhere.
        expect(await db.all(`SELECT user_id FROM room_members WHERE user_id LIKE 'iscored:%'`)).toHaveLength(0);

        // (1) real row kept, earlier joined_at pulled over, display name adopted.
        const a = await db.all(`SELECT user_id, joined_at, display_name, source FROM room_members WHERE room_id = ?`, roomA);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({
            user_id: REAL, joined_at: '2026-01-01 00:00:00', display_name: 'Wyo', source: 'self_join',
        });

        // (2) re-keyed onto the mapped account despite the casing difference.
        const b = await db.all(`SELECT user_id, joined_at, display_name FROM room_members WHERE room_id = ?`, roomB);
        expect(b).toHaveLength(1);
        expect(b[0]).toMatchObject({ user_id: OTHER, joined_at: '2026-02-02 00:00:00', display_name: 'dennisb' });

        // (4) mapped sync rows attributed; the frozen one and the unmapped one untouched.
        const live = await db.get(
            `SELECT submitted_by_user_id, discord_user_id, submitted_by_anonymous_name FROM score_history WHERE id = ?`,
            wyoLive);
        expect(live).toMatchObject({
            submitted_by_user_id: REAL, discord_user_id: REAL, submitted_by_anonymous_name: null,
        });

        const frozen = await db.get(
            `SELECT submitted_by_user_id, discord_user_id FROM score_history WHERE id = ?`, wyoFrozen);
        expect(frozen).toMatchObject({ submitted_by_user_id: null, discord_user_id: 'iscored:Wyo' });

        const nobody = await db.get(
            `SELECT submitted_by_user_id, discord_user_id FROM score_history WHERE id = ?`, unlinked);
        expect(nobody).toMatchObject({ submitted_by_user_id: null, discord_user_id: 'iscored:StopNudgingMe' });

        // (5) submissions follow the same rules.
        expect((await db.get(`SELECT submitted_by_user_id FROM submissions WHERE id = 'sub-wyo'`)).submitted_by_user_id)
            .toBe(REAL);
        expect((await db.get(`SELECT submitted_by_user_id FROM submissions WHERE id = 'sub-nudge'`)).submitted_by_user_id)
            .toBeNull();
    });

    it('is idempotent — a second run changes nothing', async () => {
        await seedLegacy();
        const db = await getDatabase();

        await foldSyntheticRoomMembers(db as any);
        const membersAfterFirst = await db.all(`SELECT user_id, room_id, joined_at, display_name FROM room_members ORDER BY room_id, user_id`);
        const historyAfterFirst = await db.all(`SELECT id, submitted_by_user_id, discord_user_id FROM score_history ORDER BY id`);

        await foldSyntheticRoomMembers(db as any);
        expect(await db.all(`SELECT user_id, room_id, joined_at, display_name FROM room_members ORDER BY room_id, user_id`))
            .toEqual(membersAfterFirst);
        expect(await db.all(`SELECT id, submitted_by_user_id, discord_user_id FROM score_history ORDER BY id`))
            .toEqual(historyAfterFirst);
    });

    it('is recorded in schema_migrations on a fresh database', async () => {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT name FROM schema_migrations WHERE name = '159_fold_synthetic_room_members'`);
        expect(row).toBeTruthy();
    });
});
