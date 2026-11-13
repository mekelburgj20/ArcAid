import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// The page must say nothing about an invite to any log. Every logger entry
// point is a spy, and so is the console, for the whole file.
vi.mock('../utils/logger.js', () => ({
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logDebug: vi.fn(),
}));

import * as logger from '../utils/logger.js';
import {
    parseInvite,
    parseJoinPath,
    renderJoinPage,
    mountCastcadeJoin,
    CASTCADE_RELEASES_URL,
    INVITE_MAX,
} from '../api/castcadeJoin.js';

// W96 - https://arcaid.app/castcade/join/<invite>, the clickable door to
// castcade://join/<invite>. Addresses below are documentation ranges
// (RFC 5737 / RFC 3849), never a real host.
const CODE = 'JHDFEF';
const ADDRESS = 'castcade:ws://203.0.113.7:27401#ABCDEF';
const ADDRESS_V6 = 'castcade:ws://[2001:db8::1]:27401#ABCDEF';
const NAMED = 'castcade:ws://host.example:27401#ABCDEF';

const url = (invite: string) => `/castcade/join/${encodeURIComponent(invite)}`;

function createTestApp() {
    // The same mount server.ts uses, with an SPA-like catch-all behind it.
    const app = express();
    app.set('trust proxy', 1);
    mountCastcadeJoin(app);
    app.get(/^(?!\/api).*/, (_req, res) => { res.type('html').send('SPA SHELL'); });
    return app;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeEach(() => {
    vi.clearAllMocks();
    for (const m of CONSOLE_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

function expectNothingLogged() {
    for (const fn of [logger.logInfo, logger.logWarn, logger.logError]) expect(fn).not.toHaveBeenCalled();
    for (const m of CONSOLE_METHODS) expect(console[m]).not.toHaveBeenCalled();
}

describe('parseInvite', () => {
    it('takes a six-letter upper-case match code', () => {
        expect(parseInvite(CODE)).toEqual({
            invite: CODE, code: CODE, isAddress: false, link: 'castcade://join/JHDFEF',
        });
    });

    it('takes an address invite (IPv4, IPv6, host name) and encodes it as the companion does', () => {
        expect(parseInvite(ADDRESS)).toEqual({
            invite: ADDRESS, code: 'ABCDEF', isAddress: true,
            link: 'castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23ABCDEF',
        });
        expect(parseInvite(ADDRESS_V6)?.link)
            .toBe('castcade://join/castcade%3Aws%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%3A27401%23ABCDEF');
        expect(parseInvite(NAMED)?.code).toBe('ABCDEF');
    });

    it('refuses everything else', () => {
        for (const bad of [
            '', 'JHDFE', 'JHDFEF1', 'jhdfef', 'JHDFEf', 'JHDFEF ', ' JHDFEF', 'JHDFEF\n',
            'castcade:ws://203.0.113.7:27401',            // no code
            'castcade:ws://203.0.113.7:27401#abcdef',     // lower-case code
            'castcade:ws://203.0.113.7:27401#ABCDE',
            'castcade:ws://203.0.113.7#ABCDEF',           // no port
            'castcade:ws://203.0.113.7:0#ABCDEF',
            'castcade:ws://203.0.113.7:65536#ABCDEF',
            'castcade:wss://203.0.113.7:27401#ABCDEF',
            'castcade:ws://203.0.113.7:27401/path#ABCDEF',
            'castcade:ws://user@203.0.113.7:27401#ABCDEF',
            'castcade:ws://203.0.113.7:27401#ABCDEF#ABCDEF',
            'ws://203.0.113.7:27401#ABCDEF',
            'https://example.com/#ABCDEF',
            'javascript:alert(1)',
            '<script>alert(1)</script>',
            `castcade:ws://${'a'.repeat(254)}:27401#ABCDEF`,
        ]) {
            expect(parseInvite(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('holds the length cap', () => {
        const long = `castcade:ws://${'a'.repeat(253)}:27401#ABCDEF`;
        expect(long.length).toBeLessThanOrEqual(INVITE_MAX);
        expect(parseInvite(long)).not.toBeNull();
        expect(parseInvite('A'.repeat(INVITE_MAX + 1))).toBeNull();
    });
});

describe('parseJoinPath', () => {
    it('takes exactly /castcade/join/<one encoded segment>', () => {
        expect(parseJoinPath('/castcade/join/JHDFEF')?.invite).toBe(CODE);
        expect(parseJoinPath(url(ADDRESS))?.invite).toBe(ADDRESS);
    });

    it('ignores a query string and never reads it', () => {
        expect(parseJoinPath('/castcade/join/JHDFEF?utm_source=chat')?.invite).toBe(CODE);
        expect(parseJoinPath('/castcade/join/?x=JHDFEF')).toBeNull();
    });

    it('refuses every other path', () => {
        for (const bad of [
            '/castcade/join',
            '/castcade/join/',
            '/castcade/join/JHDFEF/',
            '/castcade/join/JHDFEF/extra',
            '/castcade/join//JHDFEF',
            '/Castcade/Join/JHDFEF',
            '/castcade/joinJHDFEF',
            '/castcade/join/jhdfef',
            '/castcade/join/JHDFEF%',                       // malformed escape
            '/castcade/join/%E0%A4%A',                      // malformed escape
            '/castcade/join/JHDFEF%00',
            '/castcade/join/JHDFEF%0A',
            '/castcade/join/JHDFEF%2F',                     // an encoded trailing slash
            '/castcade/join/..%2F..%2Fapi%2Fversion',
            '/castcade/join/castcade:ws://203.0.113.7:27401',            // unencoded: slashes make segments
            '/castcade/join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401',  // the #CODE was cut off by a browser
            '/castcade/join/castcade%253Aws%253A%252F%252F203.0.113.7%253A27401%2523ABCDEF', // double-encoded
            '/castcade/join/%3Cscript%3Ealert(1)%3C%2Fscript%3E',
            `/castcade/join/${'A'.repeat(901)}`,
            `/castcade/join/${'%41'.repeat(301)}`,          // 301 characters once decoded
        ]) {
            expect(parseJoinPath(bad), bad).toBeNull();
        }
    });
});

describe('GET /castcade/join/<invite>', () => {
    it('a match code: the button, the code in plain text, the install line', async () => {
        const res = await request(createTestApp()).get('/castcade/join/JHDFEF');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.text).toContain('<h1>Join this Castcade match</h1>');
        expect(res.text).toContain('<a class="open" id="open" href="castcade://join/JHDFEF">Open in Castcade</a>');
        expect(res.text).toContain('<code class="code" id="invite">JHDFEF</code>');
        expect(res.text).toContain(`href="${CASTCADE_RELEASES_URL}"`);
        expect(res.text).not.toContain('SPA SHELL');
        expectNothingLogged();
    });

    it('an address invite: the encoded link in the button, the invite and the code in plain text', async () => {
        const res = await request(createTestApp()).get(url(ADDRESS));
        expect(res.status).toBe(200);
        expect(res.text).toContain('href="castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23ABCDEF"');
        expect(res.text).toContain('<code class="code long" id="invite">castcade:ws://203.0.113.7:27401#ABCDEF</code>');
        expect(res.text).toContain('Match code: <strong>ABCDEF</strong>');
        expectNothingLogged();
    });

    it('tries the link once from a nonce-carrying script that holds nothing of the request', async () => {
        const res = await request(createTestApp()).get(url(ADDRESS));
        const csp = res.headers['content-security-policy'] as string;
        const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
        expect(nonce).toBeTruthy();
        const open = `<script nonce="${nonce}">`;
        const start = res.text.indexOf(open);
        expect(start).toBeGreaterThan(-1);
        const script = res.text.slice(start + open.length, res.text.indexOf('</script>', start));
        expect(script).toContain("document.getElementById('open')");
        expect(script).toContain('window.location.href = a.href');
        expect(script).not.toContain('203.0.113.7');
        expect(script).not.toContain('ABCDEF');
        expect(res.text.match(/<script/g)).toHaveLength(1);
    });

    it('a fresh nonce on every response', async () => {
        const app = createTestApp();
        const a = await request(app).get('/castcade/join/JHDFEF');
        const b = await request(app).get('/castcade/join/JHDFEF');
        expect(a.headers['content-security-policy']).not.toBe(b.headers['content-security-policy']);
    });

    it('headers: noindex, no-store, no referrer, a locked-down CSP, a rate limit, no cookie', async () => {
        const res = await request(createTestApp()).get('/castcade/join/JHDFEF');
        expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        const csp = res.headers['content-security-policy'] as string;
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).not.toContain('unsafe-inline');
        expect(res.text).toContain('<meta name="robots" content="noindex, nofollow" />');
        expect(res.headers['ratelimit-limit']).toBe('60');
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('the link preview reads "Join a Castcade match" and never names the host of an address invite', async () => {
        const res = await request(createTestApp())
            .get(url(ADDRESS))
            .set('User-Agent', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)');
        expect(res.status).toBe(200);
        const head = res.text.slice(0, res.text.indexOf('</head>'));
        expect(head).toContain('<meta property="og:title" content="Join a Castcade match" />');
        expect(head).toContain('<meta name="twitter:title" content="Join a Castcade match" />');
        expect(head).toContain('<meta property="og:description"');
        expect(head).toContain('<title>Join a Castcade match · Arcaid</title>');
        expect(head).not.toContain('og:url');
        expect(head).not.toContain('203.0.113.7');
        expect(head).not.toContain('27401');
        expect(head).not.toContain('ABCDEF');
    });

    it('og:image uses the request host only when it is a plain host name', async () => {
        const app = createTestApp();
        const ok = await request(app).get('/castcade/join/JHDFEF')
            .set('Host', 'arcaid.example').set('X-Forwarded-Proto', 'https');
        expect(ok.text).toContain('<meta property="og:image" content="https://arcaid.example/arcaid-logo-v2.png" />');
        const odd = await request(app).get('/castcade/join/JHDFEF').set('Host', 'evil_host!example');
        expect(odd.status).toBe(200);
        expect(odd.text).not.toContain('og:image');
        expect(odd.text).not.toContain('evil_host');
    });

    it('answers HEAD', async () => {
        const res = await request(createTestApp()).head('/castcade/join/JHDFEF');
        expect(res.status).toBe(200);
        expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    });
});

describe('refusals', () => {
    const REFUSED = [
        '/castcade/join',
        '/castcade/join/',
        '/castcade/join/JHDFEF/',
        '/castcade/join/JHDFEF/extra',
        '/castcade/join/jhdfef',
        '/castcade/join/JHDFE',
        '/castcade/join/JHDFEF1',
        '/castcade/join/JHDFEF%',
        '/castcade/join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401',
        '/castcade/join/castcade%3Awss%3A%2F%2F203.0.113.7%3A27401%23ABCDEF',
        '/castcade/join/castcade%3Aws%3A%2F%2F203.0.113.7%3A99999%23ABCDEF',
        '/castcade/join/%3Cscript%3Ealert(%22x%22)%3C%2Fscript%3E',
        '/castcade/join/%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
        `/castcade/join/${'%41'.repeat(301)}`,
    ];
    const withoutNonce = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce=""');

    it('each refused shape is the same constant 404 page, with nothing of the input in it', async () => {
        const app = createTestApp();
        const baseline = withoutNonce((await request(app).get('/castcade/join/').set('Host', 'arcaid.example')).text);
        for (const path of REFUSED) {
            const res = await request(app).get(path).set('Host', 'arcaid.example');
            expect(res.status, path).toBe(404);
            expect(res.headers['content-type'], path).toMatch(/^text\/html/);
            expect(res.text, path).toContain('<h1>Not a Castcade invite</h1>');
            expect(withoutNonce(res.text), path).toBe(baseline);
            expect(res.text, path).not.toContain('<script');
            expect(res.text, path).not.toContain('castcade://');
            expect(res.headers['x-robots-tag'], path).toBe('noindex, nofollow');
            expect(res.headers['cache-control'], path).toBe('no-store');
        }
        expectNothingLogged();
    });

    it('never reaches the SPA catch-all, and a POST is refused the same way', async () => {
        const app = createTestApp();
        expect((await request(app).get('/castcade/join/nope')).text).not.toContain('SPA SHELL');
        const post = await request(app).post('/castcade/join/JHDFEF');
        expect(post.status).toBe(404);
        expect(post.text).toContain('Not a Castcade invite');
        // A path outside the mount is still the SPA's.
        expect((await request(app).get('/castcadex')).text).toBe('SPA SHELL');
    });
});

describe('HTML escaping', () => {
    it('escapes what it writes, even for a value the parser would never pass', () => {
        const html = renderJoinPage(
            { invite: `"><script>alert('x')</script>&`, code: '<b>X</b>', isAddress: true, link: 'castcade://join/"onmouseover="x' },
            { nonce: 'n', origin: null },
        );
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('<b>X</b>');
        expect(html).toContain('&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;');
        expect(html).toContain('href="castcade://join/&quot;onmouseover=&quot;x"');
        expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
    });

    it('a valid invite holds no character that needs escaping in the link', () => {
        for (const invite of [CODE, ADDRESS, ADDRESS_V6, NAMED]) {
            expect(parseInvite(invite)!.link).toMatch(/^castcade:\/\/join\/[A-Za-z0-9%._~-]+$/);
        }
    });
});

describe('rate limit', () => {
    it('caps one address at 60 a minute with a constant plain-text 429', async () => {
        const app = createTestApp();
        const ip = '198.51.100.23';
        let last = await request(app).get(url(ADDRESS)).set('X-Forwarded-For', ip);
        for (let i = 0; i < 60; i++) last = await request(app).get(url(ADDRESS)).set('X-Forwarded-For', ip);
        expect(last.status).toBe(429);
        expect(last.text).toBe('Too many requests. Please try again in a minute.');
        // Another address is unaffected.
        const other = await request(app).get('/castcade/join/JHDFEF').set('X-Forwarded-For', '198.51.100.24');
        expect(other.status).toBe(200);
        expectNothingLogged();
    });
});
