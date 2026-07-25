import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import {
    isPreviewBot,
    parseShareRoute,
    injectOgTags,
    maybeBuildOgShell,
    resetShellCacheForTests,
} from '../api/ogMeta.js';

// S16 — OG meta injection. The safety contract under test:
//   - only confirmed preview-bot UAs ever receive modified HTML,
//   - humans (and every failure mode) fall through to the unmodified shell,
//   - the OG_META_ENABLED=false kill-switch disables injection entirely,
//   - interpolated names are HTML-escaped.

const SHELL = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <title>ArcAid</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let frontendDir: string;

function createTestApp() {
    // Mirrors the server.ts SPA catch-all wiring: try OG injection, fall
    // through to the unmodified shell.
    const app = express();
    app.set('trust proxy', 1);
    app.get(/^(?!\/api).*/, async (req, res) => {
        const ogShell = await maybeBuildOgShell(req, frontendDir);
        if (ogShell) {
            res.type('html').send(ogShell);
            return;
        }
        res.sendFile(path.join(frontendDir, 'index.html'));
    });
    return app;
}

beforeEach(async () => {
    await setupTestDb();
    frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-shell-'));
    fs.writeFileSync(path.join(frontendDir, 'index.html'), SHELL);
    resetShellCacheForTests();
});

afterEach(() => {
    delete process.env.OG_META_ENABLED;
    fs.rmSync(frontendDir, { recursive: true, force: true });
});

describe('isPreviewBot', () => {
    it('matches known preview crawlers', () => {
        expect(isPreviewBot(DISCORD_UA)).toBe(true);
        expect(isPreviewBot('Twitterbot/1.0')).toBe(true);
        expect(isPreviewBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe(true);
        expect(isPreviewBot('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true);
        expect(isPreviewBot('WhatsApp/2.23.20.0')).toBe(true);
    });

    it('rejects human browsers and empty UAs', () => {
        expect(isPreviewBot(CHROME_UA)).toBe(false);
        expect(isPreviewBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')).toBe(false);
        expect(isPreviewBot(undefined)).toBe(false);
        expect(isPreviewBot('')).toBe(false);
    });
});

describe('parseShareRoute', () => {
    it('parses game and player routes with percent-decoding', () => {
        expect(parseShareRoute('/rtx_pinball/games/WHO%20dunnit')).toEqual({
            kind: 'game', slug: 'rtx_pinball', name: 'WHO dunnit',
        });
        expect(parseShareRoute('/rtx_pinball/players/._arcaid_.')).toEqual({
            kind: 'player', slug: 'rtx_pinball', name: '._arcaid_.',
        });
    });

    it('returns null for non-shareable paths', () => {
        expect(parseShareRoute('/')).toBeNull();
        expect(parseShareRoute('/rtx_pinball')).toBeNull();
        expect(parseShareRoute('/rtx_pinball/lobby')).toBeNull();
        expect(parseShareRoute('/games/abc-123')).toBeNull(); // global game detail — 2 segments
        expect(parseShareRoute('/rtx_pinball/compare/x')).toBeNull();
        expect(parseShareRoute('/a/games/b/c')).toBeNull();
        expect(parseShareRoute('/rtx_pinball/games/%E0%A4%A')).toBeNull(); // malformed encoding
    });
});

describe('injectOgTags', () => {
    it('returns null when the shell has no </head>', () => {
        expect(injectOgTags('<html><body></body></html>', {
            title: 't', description: 'd', url: 'u', image: null,
        })).toBeNull();
    });
});

describe('OG shell serving', () => {
    it('serves injected meta to a preview bot on a game route', async () => {
        const roomId = await createTestRoom('sharetest', 'Share Test Room');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, name, status, game_room_id) VALUES (?, 'Medieval Madness', 'ACTIVE', ?)`,
            crypto.randomUUID(), roomId,
        );
        const res = await request(createTestApp())
            .get('/sharetest/games/Medieval%20Madness')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toContain('og:title');
        expect(res.text).toContain('Medieval Madness · Share Test Room');
        expect(res.text).toContain('property="og:url"');
        expect(res.text).toContain('/sharetest/games/Medieval%20Madness');
        expect(res.text).toContain('twitter:card');
        // Still the SPA shell — the app must boot normally for any bot that executes it.
        expect(res.text).toContain('<div id="root">');
    });

    it('serves the unmodified shell to a human browser on the same route', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const res = await request(createTestApp())
            .get('/sharetest/games/Medieval%20Madness')
            .set('User-Agent', CHROME_UA);
        expect(res.status).toBe(200);
        expect(res.text).toBe(SHELL);
    });

    it('serves the unmodified shell to a bot when the slug matches no room', async () => {
        const res = await request(createTestApp())
            .get('/no-such-room/games/Whatever')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toBe(SHELL);
    });

    // v2.39.0 — approval rooms leak closure: a link-preview crawler is not a
    // "member", so an 'approval'-policy room must never unfurl.
    it('serves the unmodified shell to a bot on an approval-policy room', async () => {
        const roomId = await createTestRoom('approvaltest', 'Approval Test Room');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, name, status, game_room_id) VALUES (?, 'Medieval Madness', 'ACTIVE', ?)`,
            crypto.randomUUID(), roomId,
        );
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');

        const res = await request(createTestApp())
            .get('/approvaltest/games/Medieval%20Madness')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toBe(SHELL);
    });

    it('kill-switch OG_META_ENABLED=false disables injection even for bots', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        process.env.OG_META_ENABLED = 'false';
        const res = await request(createTestApp())
            .get('/sharetest/games/Medieval%20Madness')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toBe(SHELL);
    });

    it('player route resolves display_name per the display-resolution rule', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('111222333', 'CoolAlias')`,
        );
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('111222333', 'The Real Name')`,
        );
        const res = await request(createTestApp())
            .get('/sharetest/players/coolalias')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toContain('The Real Name · Share Test Room');
    });

    it('falls back to the URL name for players with no mapping', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const res = await request(createTestApp())
            .get('/sharetest/players/UnknownPlayer')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toContain('UnknownPlayer · Share Test Room');
    });

    it('HTML-escapes interpolated names', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const res = await request(createTestApp())
            .get('/sharetest/games/' + encodeURIComponent('Foo "bar" <baz>'))
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        expect(res.text).toContain('Foo &quot;bar&quot; &lt;baz&gt;');
        expect(res.text).not.toContain('content="Foo "bar"');
        expect(res.text).not.toContain('<baz>');
    });

    it('does not corrupt the shell when a name contains String.replace patterns', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const res = await request(createTestApp())
            .get('/sharetest/games/' + encodeURIComponent("Cash $' Grab"))
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        // `$'` in a replacement STRING splices the rest of the document into
        // <title>; the replacer-function form must render the literal name.
        expect(res.text).toContain('<title>Cash $&#39; Grab · Share Test Room · ArcAid</title>');
        expect(res.text.match(/<\/html>/g)?.length).toBe(1);
    });

    it('uses catalogue art as og:image when available, absolute-URL-ified', async () => {
        await createTestRoom('sharetest', 'Share Test Room');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, status, local_image_path)
             VALUES (?, 'Attack From Mars', 'approved', 'data/catalogue-images/vps/afm.jpg')`,
            crypto.randomUUID(),
        );
        const res = await request(createTestApp())
            .get('/sharetest/games/Attack%20From%20Mars')
            .set('User-Agent', DISCORD_UA);
        expect(res.status).toBe(200);
        const match = res.text.match(/property="og:image" content="([^"]+)"/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/^https?:\/\/.+\/api\/catalogue-images\/vps\/afm\.jpg$/);
        expect(res.text).toContain('summary_large_image');
    });
});
