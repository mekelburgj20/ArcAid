import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffSettings, ROOM_TOGGLES_DEFAULT_ON } from '../utils/activityDiff.js';
import { channelDisplayName, registerGatewayChannelNameLookup } from '../utils/channelNames.js';
import { buildActivityDetail } from '../utils/activityPresentation.js';

/**
 * G16 (owner 2026-11-07): "(not set) -> the default the page already showed"
 * is not a change, and Discord channel ids read as names.
 */
describe('diffSettings toggle defaults (G16)', () => {
    const opts = { toggleDefaultsOn: ROOM_TOGGLES_DEFAULT_ON };

    it('ignores unset -> true on a default-on toggle and unset -> false on a default-off one', () => {
        expect(diffSettings({}, { DISCORD_ENABLED: 'true', REQUIRE_SCORE_PHOTO: 'false' }, opts)).toEqual([]);
    });

    it('ignores a default-matching value going back to unset', () => {
        expect(diffSettings({ ROOM_LISTED: 'true' }, { ROOM_LISTED: '' }, opts)).toEqual([]);
    });

    it('keeps a first save that moves away from the default', () => {
        const changes = diffSettings({}, { DISCORD_ENABLED: 'false', REQUIRE_SCORE_PHOTO: 'true' }, opts);
        expect(changes.map(c => [c.key, c.from, c.to])).toEqual([
            ['DISCORD_ENABLED', null, 'false'],
            ['REQUIRE_SCORE_PHOTO', null, 'true'],
        ]);
    });

    it('keeps ordinary changes and non-flag values', () => {
        const changes = diffSettings({ DISCORD_ENABLED: 'true' }, { DISCORD_ENABLED: 'false', ROOM_TIMEZONE: 'America/New_York' }, opts);
        expect(changes.map(c => c.key)).toEqual(['DISCORD_ENABLED', 'ROOM_TIMEZONE']);
    });

    it('without the option (global settings) behaves as before', () => {
        expect(diffSettings({}, { DISCORD_ENABLED: 'true' }).map(c => c.key)).toEqual(['DISCORD_ENABLED']);
    });
});

describe('ROOM_TOGGLES_DEFAULT_ON matches the Settings page', () => {
    it('lists exactly the toggles the page shows as on when unset', () => {
        const root = resolve(__dirname, '../../admin-ui/src');
        const settings = readFileSync(resolve(root, 'pages/Settings.tsx'), 'utf8');
        const display = readFileSync(resolve(root, 'lib/displaySettings.ts'), 'utf8');
        const found = new Set<string>();
        // `'KEY': { label..., description..., defaultOn: true }` in the toggle maps.
        // Entry bodies end at their own `\n  },` (descriptions may contain braces).
        const mapEntry = /'([A-Z][A-Z0-9_]+)':\s*\{([\s\S]*?)\n\s*\},/g;
        for (const text of [settings, display]) {
            for (const m of text.matchAll(mapEntry)) {
                if (/defaultOn:\s*true/.test(m[2]!)) found.add(m[1]!);
            }
        }
        // Inline `KEY: true,` literals inside TOGGLE_DEFAULTS.
        const block = settings.match(/const TOGGLE_DEFAULTS[^=]*=\s*\{([\s\S]*?)\n\};/);
        expect(block).not.toBeNull();
        for (const m of block![1]!.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*true,/gm)) found.add(m[1]!);
        expect([...found].sort()).toEqual([...ROOM_TOGGLES_DEFAULT_ON].sort());
    });
});

describe('Discord channel names (G16)', () => {
    afterEach(() => registerGatewayChannelNameLookup(null));

    it('shows #name when the bot knows the channel, the id otherwise', () => {
        registerGatewayChannelNameLookup(id => (id === '123456789012345678' ? 'lu-tourneys' : null));
        expect(channelDisplayName('123456789012345678')).toBe('#lu-tourneys');
        expect(channelDisplayName('999999999999999999')).toBe('999999999999999999');
        expect(channelDisplayName('none')).toBe('none');
    });

    it('falls back to the id when no client is registered or the lookup throws', () => {
        expect(channelDisplayName('123456789012345678')).toBe('123456789012345678');
        registerGatewayChannelNameLookup(() => { throw new Error('gateway down'); });
        expect(channelDisplayName('123456789012345678')).toBe('123456789012345678');
    });

    it('names the channel on a bot row and on a channel setting change', () => {
        registerGatewayChannelNameLookup(id => (id === '111111111111111111' ? 'lu-polls' : id === '222222222222222222' ? 'lu-tourneys' : null));
        const base = { summary: 's', score: null, source: null, tournament_name: null, game_name: null, table_name: null } as const;
        const bot = buildActivityDetail(
            { ...base, category: 'bot', event_type: 'bot_post_failed' } as never,
            { channelId: '111111111111111111', code: 50013 }, null,
        );
        expect(bot.facts.find(f => f.label === 'Discord channel')?.value).toBe('#lu-polls');
        const admin = buildActivityDetail(
            { ...base, category: 'admin', event_type: 'settings_change' } as never,
            { changes: [{ key: 'DISCORD_ANNOUNCE_CHANNEL_ID', label: 'Announcement channel', from: '111111111111111111', to: '222222222222222222' }] },
            null,
        );
        expect(admin.changes?.[0]).toMatchObject({ from: '#lu-polls', to: '#lu-tourneys' });
    });
});
