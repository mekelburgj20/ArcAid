import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { resolveProfiles } from '../services/PlayerProfileResolver.js';
import { setupTestDb } from './helpers.js';

/**
 * v2.125.2 — Wyo / DennisB on rtx_pinball (2026-08-21): their iScored scores
 * synced BEFORE they logged in, and the sync path stored the poller's
 * synthetic `iscored:<name>` id in submitted_by_user_id. Auto-link then wrote
 * the user_mappings row, but the resolver keyed user_profiles on the
 * (non-null, synthetic) submitted_by_user_id and never consulted the mapping
 * — generic avatar, no display name, while players whose mapping pre-dated
 * the sync rendered fine.
 */
describe('resolveProfiles — synthetic iscored:* ids', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seedWyo() {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES (?, ?, ?)`,
            '310966414196604928', 'Wyo', '20f720fe',
        );
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            '310966414196604928', 'Wyo',
        );
    }

    it('resolves a row whose submitted_by_user_id is the synthetic id through user_mappings', async () => {
        await seedWyo();
        const [row] = await resolveProfiles([
            { discord_user_id: 'iscored:Wyo', submitted_by_user_id: 'iscored:Wyo', iscored_username: 'Wyo' },
        ]);
        expect(row!.discord_user_id).toBe('310966414196604928');
        expect(row!.display_name).toBe('Wyo');
        expect(row!.avatar_hash).toBe('20f720fe');
    });

    it("still resolves the poller's NULL-style unowned row (discord_user_id synthetic, submitted_by_user_id NULL)", async () => {
        await seedWyo();
        const [row] = await resolveProfiles([
            { discord_user_id: 'iscored:wyo', submitted_by_user_id: null, iscored_username: 'wyo' },
        ]);
        expect(row!.avatar_hash).toBe('20f720fe');
    });

    it('does NOT let a community/anon row borrow a profile by name collision', async () => {
        await seedWyo();
        const [row] = await resolveProfiles([
            { discord_user_id: 'ANON', submitted_by_user_id: null, iscored_username: 'Wyo' },
        ]);
        expect(row!.avatar_hash).toBeNull();
        expect(row!.display_name).toBeNull();
    });

    it('a real submitted_by_user_id still wins over the alias mapping', async () => {
        await seedWyo();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES (?, ?, ?)`,
            '999', 'Other', 'aa',
        );
        const [row] = await resolveProfiles([
            { discord_user_id: 'iscored:Wyo', submitted_by_user_id: '999', iscored_username: 'Wyo' },
        ]);
        expect(row!.display_name).toBe('Other');
    });
});
