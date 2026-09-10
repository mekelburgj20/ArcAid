import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Channel copy for a rotation and for an interactive activation (v2.155.7).
 *
 * INCIDENT (rtx_pinball Daily Grind, 2026-09-07 20:00 PT). PeteG won Scared
 * Stiff. The channel got the Rotation record and the "Pick Needed" embed, both
 * carrying his `<@id>` INSIDE the embed — which pings nobody and rendered as
 * the raw snowflake on the owner's phone until a refresh. Eleven minutes later
 * PeteG picked Dr. Dude from the web Picks page, and the channel heard
 * nothing: the web route was the one activation path with no announcement.
 *
 * Three assertions, one per half of the fix:
 *   - the embed that ADDRESSES the winner (Pick Needed) pings them;
 *   - the embed that RECORDS the winner (Rotation) names them in bold — no
 *     bare mention, no second ping for one rotation;
 *   - `announceGameActivated` posts "picked by X after winning Y", pings
 *     nobody, and stays quiet when the invoking channel already saw a reply.
 */

const sent: Array<{ channelId: string; embed: any; opts: any }> = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        // Without a bot token every announcement is a silent no-op, so the
        // channel has to be forced open to see the copy at all.
        resolveAnnouncementChannelId: async () => 'announce-channel',
        sendChannelEmbed: async (channelId: string, embed: any, opts?: any) => {
            sent.push({ channelId, embed: embed.data ?? embed, opts });
        },
    };
});

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { PickAwardGate } = await import('../services/PickAwardGate.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');

// A real-shaped Discord snowflake, so the mention resolver treats it as
// mentionable (the incident's actual id).
const PETE = '1452664655334867070';

let roomCounter = 0;

async function seedWin() {
    const db = await getDatabase();
    const roomId = await createTestRoom(`announce-${++roomCounter}`, 'Announce Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    PickAwardGate.invalidate();
    const activeId = await createTestGame(tournamentId, { name: 'Scared Stiff', status: 'ACTIVE' });

    await db.run(
        `INSERT INTO user_profiles (discord_user_id, username, display_name) VALUES (?, 'peteg', 'PeteG')`,
        PETE,
    );
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, 'PeteG', 104264550, ?)`,
        `${activeId}-peteg`, activeId, PETE, PETE, new Date().toISOString(),
    );

    return { db, roomId, tournamentId, activeId };
}

const byTitle = (pred: (t: string) => boolean) => sent.find((s) => pred(String(s.embed?.title ?? '')));

describe('rotation copy — who gets pinged, who gets named', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        sent.length = 0;
    });

    it('pings the winner on the Pick Needed embed, and names them in bold on the Rotation record', async () => {
        const { tournamentId } = await seedWin();

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        const pick = byTitle((t) => t.startsWith('Pick Needed'));
        expect(pick, 'no Pick Needed embed was sent').toBeTruthy();
        expect(pick!.embed.description).toContain(`<@${PETE}>`);
        // The ping is what the incident was missing: PeteG has no DM opt-ins,
        // and an embed-only mention notifies nobody.
        expect(pick!.opts?.pingUserIds).toEqual([PETE]);

        const rotation = byTitle((t) => t.endsWith('— Rotation'));
        expect(rotation, 'no Rotation embed was sent').toBeTruthy();
        expect(rotation!.embed.description).toContain('**Winner:** **PeteG**');
        expect(rotation!.embed.description).not.toContain('<@');
        expect(rotation!.opts?.pingUserIds ?? []).toEqual([]);
    });
});

describe('announceGameActivated — the interactive activation embed', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        sent.length = 0;
    });

    it('names the picker and the game they won, and pings nobody', async () => {
        const { tournamentId, activeId } = await seedWin();

        await TournamentEngine.getInstance().announceGameActivated({
            tournamentId,
            gameName: 'Dr. Dude and His Excellent Ray',
            pickerId: PETE,
            pickerLabel: 'pete-login-name',
            wonGameId: activeId,
        });

        expect(sent).toHaveLength(1);
        const { channelId, embed, opts } = sent[0];
        expect(channelId).toBe('announce-channel');
        expect(embed.title).toBe('Now Active: Dr. Dude and His Excellent Ray');
        expect(embed.description).toBe(
            '**Dr. Dude and His Excellent Ray** is now active for **Daily Grind** — picked by **PeteG** after winning **Scared Stiff**. Get your scores in!',
        );
        expect(embed.footer?.text).toBe('Daily Grind');
        // Their own action — a name, not a buzz.
        expect(opts?.pingUserIds ?? []).toEqual([]);
    });

    it('falls back to the caller-supplied label when the picker has no profile name', async () => {
        const { tournamentId } = await seedWin();

        await TournamentEngine.getInstance().announceGameActivated({
            tournamentId,
            gameName: 'Swords of Fury',
            pickerId: '1000000000000000001',
            pickerLabel: 'newcomer',
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].embed.description).toBe(
            '**Swords of Fury** is now active for **Daily Grind** — picked by **newcomer**. Get your scores in!',
        );
    });

    it('names no picker for an admin activation', async () => {
        const { tournamentId } = await seedWin();

        await TournamentEngine.getInstance().announceGameActivated({
            tournamentId,
            gameName: 'PIN-BOT',
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].embed.description).toBe('**PIN-BOT** is now active for **Daily Grind**. Get your scores in!');
    });

    it('stays quiet when the invoking channel IS the announcement channel', async () => {
        const { tournamentId } = await seedWin();

        await TournamentEngine.getInstance().announceGameActivated({
            tournamentId,
            gameName: 'PIN-BOT',
            pickerId: PETE,
            skipChannelId: 'announce-channel',
        });

        expect(sent).toHaveLength(0);
    });

    it('posts when the invoking channel is somewhere else', async () => {
        const { tournamentId } = await seedWin();

        await TournamentEngine.getInstance().announceGameActivated({
            tournamentId,
            gameName: 'PIN-BOT',
            pickerId: PETE,
            skipChannelId: 'some-other-channel',
        });

        expect(sent).toHaveLength(1);
    });
});
