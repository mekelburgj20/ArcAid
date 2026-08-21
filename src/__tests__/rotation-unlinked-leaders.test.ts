import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Rotation copy when the pick cascade skips unlinked leaders.
 *
 * INCIDENT (rtx_pinball Daily Grind, 2026-08-20 22:00 CDT). StopNudgingMe took
 * the board and DennisB was second, both unclaimed iScored names.
 * `resolveLeaderboardPlaces` strips unattributed rows, so the cascade walked
 * past both and activated fourth-place BrickShotBobes's queued game. The
 * channel was told two things, and only one of them was true:
 *
 *   "**StopNudgingMe** wins! **<game>** is now active from the queue."
 *
 * StopNudgingMe did win. It was not their queue, and nothing anywhere said the
 * top two had been skipped or how to fix it.
 *
 * Two assertions, matching the two halves of the bug: the rotation now NARRATES
 * every stripped leader (with one claim link), and the activation copy NAMES
 * whose queue actually fired.
 */

const sentEmbeds: any[] = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        // Without a bot token every announcement is a silent no-op, so the
        // channel has to be forced open to see the copy at all.
        resolveAnnouncementChannelId: async () => 'test-channel',
        sendChannelEmbed: async (_channelId: string, embed: any) => { sentEmbeds.push(embed.data ?? embed); },
        formatUserMention: async (_id: string, label: string) => label,
    };
});

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { PickAwardGate } = await import('../services/PickAwardGate.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');

let roomCounter = 0;

async function seedRotation() {
    const db = await getDatabase();
    const roomId = await createTestRoom(`unlinked-${++roomCounter}`, 'Unlinked Leaders Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    PickAwardGate.invalidate();
    const activeId = await createTestGame(tournamentId, { name: 'Blackbelt 2018', status: 'ACTIVE' });

    // 1st + 2nd: iScored-only names nobody has claimed. `iscored:<name>` in
    // discord_user_id is the poller's own signature for "unattributed".
    for (const [name, score] of [['StopNudgingMe', 99999], ['DennisB', 88888]] as const) {
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`,
            `${activeId}-${name.toLowerCase()}`, activeId, `iscored:${name}`, name, score,
            new Date().toISOString(),
        );
    }
    // 3rd: a real account, with a queue.
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, username, display_name) VALUES ('U_BRICK', 'brick', 'BrickShotBobes')`,
    );
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'COMMUNITY', 'U_BRICK', 'BrickShotBobes', 77777, ?)`,
        `${activeId}-brickshotbobes`, activeId, new Date().toISOString(),
    );

    return { db, roomId, tournamentId, activeId };
}

function descriptions(): string[] {
    return sentEmbeds.map((e) => String(e?.description ?? ''));
}

describe('rotation — leaders the cascade could not reach', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        sentEmbeds.length = 0;
    });

    it('narrates every stripped leader, winner first, with one claim link', async () => {
        const { tournamentId } = await seedRotation();
        const engine = TournamentEngine.getInstance();
        await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'U_BRICK');

        await engine.runMaintenance(tournamentId);

        const narrated = descriptions().find((d) => d.includes('topped the board'));
        expect(narrated, 'no rotation embed explained the skipped leaders').toBeTruthy();
        expect(narrated).toContain("**StopNudgingMe** topped the board but isn't linked to an Arcaid account");
        expect(narrated).toContain('so the pick passes to the next linked player');
        expect(narrated).toContain("**DennisB** was next and isn't linked either.");
        // One link, not one per leader.
        expect(narrated!.match(/Claim your name:/g)).toHaveLength(1);
        expect(narrated).toContain('/account/settings');
        // The linked third-place player is not a "stripped leader".
        expect(narrated).not.toContain('**BrickShotBobes** was next');
    });

    it('names whose queue actually fired, instead of implying the top scorer queued it', async () => {
        const { tournamentId } = await seedRotation();
        const engine = TournamentEngine.getInstance();
        await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'U_BRICK');

        await engine.runMaintenance(tournamentId);

        const activation = descriptions().find((d) => d.includes('Bad Cats'));
        expect(activation, 'nothing announced the activated game').toBeTruthy();
        expect(activation).toContain("**Bad Cats** is now active from BrickShotBobes's queue.");
        // The old copy, which read as the winner's own queue.
        expect(activation).not.toContain('is now active from the queue.');
    });

    it('says nothing about stripped leaders when every place is linked', async () => {
        // Guard against the narrative becoming ambient noise on a normal rotation.
        const { db, tournamentId, activeId } = await seedRotation();
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
             VALUES ('U_STOP', 'StopNudgingMe', datetime('now')), ('U_DEN', 'DennisB', datetime('now'))`,
        );
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, username) VALUES ('U_STOP', 'stopnudgingme'), ('U_DEN', 'dennisb')`,
        );
        const engine = TournamentEngine.getInstance();
        await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'U_STOP');

        await engine.runMaintenance(tournamentId);

        expect(descriptions().some((d) => d.includes('topped the board'))).toBe(false);
        // The winner used their OWN queue, so no owner is named.
        const activation = descriptions().find((d) => d.includes('Bad Cats'));
        expect(activation).toContain('is now active from the queue.');
        expect(activeId).toBeTruthy();
    });
});
