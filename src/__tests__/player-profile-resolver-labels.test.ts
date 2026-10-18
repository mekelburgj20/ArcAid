import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { resolveProfiles, resolveUserLabels, labelForProfile } from '../services/PlayerProfileResolver.js';
import { setupTestDb } from './helpers.js';

/**
 * v2.162.2 — the admin Season panel rendered a voter as `1342178162058068048`
 * (owner report 2026-10-18): the account had a login username and an alias
 * but no chosen display name, and the id-keyed surfaces stopped at
 * display_name. `resolveUserLabels` is now THE rule for anything rendered
 * from a bare user id: display_name → username → earliest alias.
 */
describe('id-keyed label resolution', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('resolveProfiles ships username alongside display_name', async () => {
        const db = await getDatabase();
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, NULL, ?)', '111', 'LeonSpeegle');
        const [row] = await resolveProfiles([{ submitted_by_user_id: '111', discord_user_id: '111' }]);
        expect(row!.display_name).toBeNull();
        expect(row!.username).toBe('LeonSpeegle');
    });

    it('prefers display_name, then username, then the earliest alias; omits ids with none', async () => {
        const db = await getDatabase();
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)', 'd1', 'Chosen', 'login1');
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, NULL, ?)', 'd2', 'login2');
        await db.run('INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, NULL, NULL)', 'd3');
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username, created_at) VALUES ('d3', 'Later', '2026-06-01 00:00:00')`);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username, created_at) VALUES ('d3', 'Earliest', '2026-01-01 00:00:00')`);
        // An alias never overrides a profile label.
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('d2', 'AliasOfD2')`);

        const labels = await resolveUserLabels(['d1', 'd2', 'd3', 'nobody']);
        expect(labels).toEqual({ d1: 'Chosen', d2: 'login2', d3: 'Earliest' });
    });

    it('skips empty, system: and iscored: ids', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('iscored:Wyo', 'ShouldNotShow')`);
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('system:cron', 'AlsoShouldNotShow')`);
        const labels = await resolveUserLabels(['', '  ', 'system:cron', 'iscored:Wyo']);
        expect(labels).toEqual({});
    });

    it('labelForProfile is display_name || username || null', () => {
        expect(labelForProfile({ display_name: 'A', username: 'b' })).toBe('A');
        expect(labelForProfile({ display_name: null, username: 'b' })).toBe('b');
        expect(labelForProfile({ display_name: '', username: '' })).toBeNull();
        expect(labelForProfile(null)).toBeNull();
        expect(labelForProfile(undefined)).toBeNull();
    });
});
