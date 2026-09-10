import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `sendChannelEmbed` + `resolveUserMention` (v2.155.7).
 *
 * A `<@id>` that appears only inside an embed neither notifies the person nor
 * reliably renders — Discord pings on message CONTENT mentions alone, and a
 * client that has not cached the user shows the raw snowflake (owner's phone,
 * RTX_Pinball Daily Grind, 2026-09-07). The fix repeats the mention in the
 * content with an explicit `allowed_mentions`. These tests pin the request
 * body, and the two cases where a mention must NOT become a ping.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn(async () => ({})) }));

vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('discord.js')>();
    class REST {
        constructor(_opts?: unknown) {}
        setToken() { return this; }
        post = post;
    }
    return { ...actual, REST };
});

vi.mock('../services/GameRoomSettingsService.js', () => ({
    GameRoomSettingsService: {
        get: async (roomId: string, key: string) =>
            roomId === 'mentions-off-room' && key === 'DISCORD_MENTIONS_ENABLED' ? 'false' : null,
    },
}));

process.env.DISCORD_BOT_TOKEN = 'test-token';

const { sendChannelEmbed, resolveUserMention, formatUserMention } = await import('../utils/discord.js');
const { EmbedBuilder } = await import('discord.js');

const lastBody = () => (post.mock.calls.at(-1) as any[])[1].body;

describe('sendChannelEmbed', () => {
    beforeEach(() => post.mockClear());

    it('repeats pinged users in the content with an explicit allowed_mentions', async () => {
        await sendChannelEmbed('C1', new EmbedBuilder().setTitle('Pick Needed'), {
            pingUserIds: ['1452664655334867070', '1452664655334867070', '2000000000000000002'],
        });

        expect(post).toHaveBeenCalledTimes(1);
        const body = lastBody();
        expect(body.content).toBe('<@1452664655334867070> <@2000000000000000002>');
        expect(body.allowed_mentions).toEqual({ users: ['1452664655334867070', '2000000000000000002'] });
        expect(body.embeds).toHaveLength(1);
        expect(body.embeds[0].title).toBe('Pick Needed');
    });

    it('sends a bare embed — no content, no allowed_mentions — when nobody is pinged', async () => {
        await sendChannelEmbed('C1', new EmbedBuilder().setTitle('Rotation'));
        await sendChannelEmbed('C1', new EmbedBuilder().setTitle('Rotation'), { pingUserIds: [] });

        expect(post).toHaveBeenCalledTimes(2);
        for (const call of post.mock.calls as any[]) {
            expect(call[1].body).toEqual({ embeds: [expect.objectContaining({ title: 'Rotation' })] });
        }
    });
});

describe('resolveUserMention', () => {
    it('mentions and pings a Discord user', async () => {
        expect(await resolveUserMention('1452664655334867070', 'PeteG')).toEqual({
            text: '<@1452664655334867070>',
            pingIds: ['1452664655334867070'],
        });
        expect(await resolveUserMention('1452664655334867070', 'PeteG', 'ordinary-room')).toEqual({
            text: '<@1452664655334867070>',
            pingIds: ['1452664655334867070'],
        });
    });

    it('names, and never pings, a non-Discord identity', async () => {
        expect(await resolveUserMention('google:106194243289954434171', 'Pete G')).toEqual({
            text: '**Pete G**',
            pingIds: [],
        });
    });

    it('names, and never pings, in a room that has switched mentions off', async () => {
        expect(await resolveUserMention('1452664655334867070', 'PeteG', 'mentions-off-room')).toEqual({
            text: '**PeteG**',
            pingIds: [],
        });
    });

    it('formatUserMention is the text half of the same answer', async () => {
        expect(await formatUserMention('1452664655334867070', 'PeteG')).toBe('<@1452664655334867070>');
        expect(await formatUserMention('1452664655334867070', 'PeteG', 'mentions-off-room')).toBe('**PeteG**');
    });
});
