import { describe, it, expect, beforeEach } from 'vitest';
import { UserProfileService } from '../services/UserProfileService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';

/**
 * Coverage for the user-chosen display name layer (Part B):
 *   • setDisplayName accepts/rejects per validation rules
 *   • case-insensitive uniqueness against other users' display_names
 *   • case-insensitive uniqueness against other users' iScored aliases
 *   • the user's own iScored aliases are allowed as their display_name
 *   • clear path (null/empty)
 */

async function seedAlias(discordUserId: string, name: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)
         ON CONFLICT(iscored_username) DO NOTHING`,
        discordUserId, name,
    );
}

describe('UserProfileService.setDisplayName — uniqueness rules', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('accepts a valid name', async () => {
        const next = await UserProfileService.setDisplayName('user-1', 'Tommy');
        expect(next).toBe('Tommy');
        const got = await UserProfileService.getDisplayName('user-1');
        expect(got).toBe('Tommy');
    });

    it('rejects a name shorter than 2 characters', async () => {
        await expect(UserProfileService.setDisplayName('user-1', 'a'))
            .rejects.toMatchObject({ reason: 'too_short' });
    });

    it('rejects a name longer than 32 characters', async () => {
        await expect(UserProfileService.setDisplayName('user-1', 'x'.repeat(33)))
            .rejects.toMatchObject({ reason: 'too_long' });
    });

    it('rejects invalid characters', async () => {
        await expect(UserProfileService.setDisplayName('user-1', 'no/slash'))
            .rejects.toMatchObject({ reason: 'invalid_chars' });
    });

    it('rejects a name already used as another user\'s display name (case-insensitive)', async () => {
        await UserProfileService.setDisplayName('user-1', 'Champion');
        await expect(UserProfileService.setDisplayName('user-2', 'champion'))
            .rejects.toMatchObject({ reason: 'taken_display' });
    });

    it('rejects a name owned as another user\'s iScored alias (case-insensitive)', async () => {
        await seedAlias('user-1', 'PBW2023');
        await expect(UserProfileService.setDisplayName('user-2', 'pbw2023'))
            .rejects.toMatchObject({ reason: 'taken_alias' });
    });

    it('allows a name that matches the user\'s own iScored alias', async () => {
        await seedAlias('user-1', 'PBW2023');
        const next = await UserProfileService.setDisplayName('user-1', 'PBW2023');
        expect(next).toBe('PBW2023');
    });

    it('allows the same user to update their own display name', async () => {
        await UserProfileService.setDisplayName('user-1', 'OldName');
        const next = await UserProfileService.setDisplayName('user-1', 'NewName');
        expect(next).toBe('NewName');
        const got = await UserProfileService.getDisplayName('user-1');
        expect(got).toBe('NewName');
    });

    it('clears the display name when given null or empty', async () => {
        await UserProfileService.setDisplayName('user-1', 'ToBeCleared');
        const cleared = await UserProfileService.setDisplayName('user-1', null);
        expect(cleared).toBeNull();
        const got = await UserProfileService.getDisplayName('user-1');
        expect(got).toBeNull();
    });

    it('trims surrounding whitespace before validation', async () => {
        const next = await UserProfileService.setDisplayName('user-1', '   Spacey   ');
        expect(next).toBe('Spacey');
    });
});

describe('UserProfileService.checkDisplayNameAvailability — read-only mirror of setDisplayName', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('returns available for a fresh name', async () => {
        const result = await UserProfileService.checkDisplayNameAvailability('user-1', 'OpenName');
        expect(result).toEqual({ available: true });
    });

    it('returns unavailable + reason when an alias collides', async () => {
        await seedAlias('user-A', 'TakenName');
        const result = await UserProfileService.checkDisplayNameAvailability('user-B', 'takenname');
        expect(result.available).toBe(false);
        if (!result.available) expect(result.reason).toBe('taken_alias');
    });

    it('returns available when checking an alias the user already owns', async () => {
        await seedAlias('user-A', 'MineMine');
        const result = await UserProfileService.checkDisplayNameAvailability('user-A', 'MineMine');
        expect(result).toEqual({ available: true });
    });
});

describe('UserProfileService.getDisplayNameMap — batch lookup', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('returns a map only for users with non-null display_name', async () => {
        await UserProfileService.setDisplayName('user-1', 'Alpha');
        await UserProfileService.setDisplayName('user-2', 'Beta');
        // user-3 has no profile; user-4 has a row but cleared display_name
        await UserProfileService.ensureProfile('user-4');

        const map = await UserProfileService.getDisplayNameMap(['user-1', 'user-2', 'user-3', 'user-4']);
        expect(map.get('user-1')).toBe('Alpha');
        expect(map.get('user-2')).toBe('Beta');
        expect(map.has('user-3')).toBe(false);
        expect(map.has('user-4')).toBe(false);
    });
});
