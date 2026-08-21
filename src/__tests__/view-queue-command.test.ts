import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { viewqueue } from '../discord/commands/viewqueue.js';
import { DISCORD_GUILD_NOT_LINKED_MESSAGE } from '../utils/discordRoomFilter.js';

// ---------------------------------------------------------------------------
// `/view-queue` (v2.121.0) — replaces `/view-selection`.
//
// The old command dumped EVERY player's queued rows for the guild's rooms plus
// an "Available to Pick (Sample)" slice of the first 10 catalogue titles.
// Owner ask (2026-08-20): show only the caller's own queue, drop the sample,
// and link to the room's Picks page for the full pick list.
// ---------------------------------------------------------------------------

const GUILD = '1200000000000000001';
const GUILD_UNLINKED = '1200000000000000002';
const ME = 'viewqueue-me';
const SOMEONE_ELSE = 'viewqueue-them';

function makeInteraction(guildId: string | null, userId = ME) {
    const replies: unknown[] = [];
    const interaction = {
        user: { id: userId, tag: `${userId}#0000`, displayName: userId },
        guildId,
        options: { getString: () => null, getUser: () => null, getFocused: () => '' },
        deferReply: async () => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies };
}

const replyText = (replies: unknown[]) => JSON.stringify(replies);

async function queueRow(tournamentId: string, name: string, pickerId: string | null, queueOrder: number | null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
         VALUES (?, ?, ?, 'QUEUED', ?, ?)`,
        id, tournamentId, name, pickerId, queueOrder,
    );
    return id;
}

async function seedRoom(slug: string, guildId: string, tournamentName: string, type = 'DG') {
    const roomId = await createTestRoom(slug, slug);
    await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', guildId);
    const tournamentId = await createTestTournament(roomId, { name: tournamentName, type });
    return { roomId, tournamentId };
}

describe('/view-queue', () => {
    const savedEnv = process.env.DISCORD_GUILD_ID;
    const savedPublicUrl = process.env.PUBLIC_URL;

    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
        delete process.env.PUBLIC_URL;
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = savedEnv;
        if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedPublicUrl;
    });

    it('is registered under the new name and the old one is gone', async () => {
        expect(viewqueue.data.name).toBe('view-queue');
        await expect(import('../discord/commands/viewselection.js')).rejects.toThrow();
    });

    it("shows only the invoker's rows, never another player's", async () => {
        const { tournamentId } = await seedRoom('vq-mine', GUILD, 'My Cup');
        await queueRow(tournamentId, 'My Table', ME, 1);
        await queueRow(tournamentId, 'Their Table', SOMEONE_ELSE, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('My Table');
        expect(text).not.toContain('Their Table');
    });

    it('excludes [Pending Pick] placeholders', async () => {
        const { tournamentId } = await seedRoom('vq-placeholder', GUILD, 'Placeholder Cup');
        await queueRow(tournamentId, '[Pending Pick]', ME, null);
        await queueRow(tournamentId, 'Real Table', ME, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Real Table');
        expect(text).not.toContain('Pending Pick');
    });

    it('groups by tournament (name + tag) and lists each queue in queue order', async () => {
        const a = await seedRoom('vq-group-a', GUILD, 'Alpha Cup', 'DG');
        const bRoomTournament = await createTestTournament(a.roomId, { name: 'Beta Cup', type: 'WG-VPXS' });

        // Deliberately out of insertion order, and one NULL-order row which
        // the engine treats as front-of-queue.
        await queueRow(a.tournamentId, 'Alpha Third', ME, 3);
        await queueRow(a.tournamentId, 'Alpha Second', ME, 2);
        await queueRow(a.tournamentId, 'Alpha First', ME, null);
        await queueRow(bRoomTournament, 'Beta Only', ME, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = String(replies[0]);
        expect(text).toContain('**Alpha Cup** `DG`');
        expect(text).toContain('**Beta Cup** `WG-VPXS`');
        expect(text.indexOf('Alpha Cup')).toBeLessThan(text.indexOf('Beta Cup'));
        expect(text).toContain('1. Alpha First');
        expect(text).toContain('2. Alpha Second');
        expect(text).toContain('3. Alpha Third');
        // Numbering restarts per tournament.
        expect(text).toContain('1. Beta Only');
    });

    it('replies with the room Picks link and no catalogue sample', async () => {
        const { tournamentId } = await seedRoom('vq-link', GUILD, 'Link Cup');
        await queueRow(tournamentId, 'Linked Table', ME, 1);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, status) VALUES ('vq-cat-1', 'Catalogue Only Table', 'pinball', 'approved')`,
        );

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = String(replies[0]);
        expect(text).toContain('Visit your Arcaid game room here: https://arcaid.app/vq-link/picks to view all of the pick options for this tournament.');
        expect(text).not.toContain('Available to Pick');
        expect(text).not.toContain('Catalogue Only Table');
    });

    it('honours PUBLIC_URL for the link base', async () => {
        process.env.PUBLIC_URL = 'https://play.example.test/';
        const { tournamentId } = await seedRoom('vq-base', GUILD, 'Base Cup');
        await queueRow(tournamentId, 'Base Table', ME, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        expect(String(replies[0])).toContain('https://play.example.test/vq-base/picks');
    });

    it('says the queue is empty (with the link) when the invoker has queued nothing', async () => {
        const { tournamentId } = await seedRoom('vq-empty', GUILD, 'Empty Cup');
        await queueRow(tournamentId, 'Not Mine', SOMEONE_ELSE, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = String(replies[0]);
        expect(text).toContain('Your queue is empty.');
        expect(text).toContain('https://arcaid.app/vq-empty/picks');
    });

    it('emits one link per room when the guild links to several', async () => {
        await seedRoom('vq-multi-a', GUILD, 'Multi A');
        await seedRoom('vq-multi-b', GUILD, 'Multi B');

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = String(replies[0]);
        expect(text).toContain('https://arcaid.app/vq-multi-a/picks');
        expect(text).toContain('https://arcaid.app/vq-multi-b/picks');
    });

    it('replies not-linked in a guild with no Arcaid room', async () => {
        const { tournamentId } = await seedRoom('vq-linked', GUILD, 'Linked Cup');
        await queueRow(tournamentId, 'Hidden Table', ME, 1);

        const { interaction, replies } = makeInteraction(GUILD_UNLINKED);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(DISCORD_GUILD_NOT_LINKED_MESSAGE);
        expect(text).not.toContain('Hidden Table');
    });

    it('replies not-linked in a DM (no guild context)', async () => {
        const { tournamentId } = await seedRoom('vq-dm', GUILD, 'DM Cup');
        await queueRow(tournamentId, 'DM Table', ME, 1);

        const { interaction, replies } = makeInteraction(null);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain(DISCORD_GUILD_NOT_LINKED_MESSAGE);
        expect(text).not.toContain('DM Table');
    });

    it("does not show another guild's room in the invoker's queue", async () => {
        const mine = await seedRoom('vq-scope-mine', GUILD, 'Scoped Cup');
        const theirs = await seedRoom('vq-scope-theirs', '1200000000000000009', 'Other Cup');
        await queueRow(mine.tournamentId, 'Scoped Table', ME, 1);
        await queueRow(theirs.tournamentId, 'Foreign Table', ME, 1);

        const { interaction, replies } = makeInteraction(GUILD);
        await viewqueue.execute(interaction);

        const text = replyText(replies);
        expect(text).toContain('Scoped Table');
        expect(text).not.toContain('Foreign Table');
    });
});
