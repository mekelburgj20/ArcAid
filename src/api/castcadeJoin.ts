import { randomBytes } from 'crypto';
import type { Express, Request, Response } from 'express';
import { castcadeJoinLimiter } from './rateLimit.js';

/**
 * The clickable join link for a Castcade match: `https://arcaid.app/castcade/join/<invite>`.
 *
 * The Castcade companion's own link is `castcade://join/<invite>`, which Discord and most chat apps show as plain
 * text. This page is the `https://` door to it: it validates the invite, shows a button whose href is the
 * `castcade://` link, and tries that link once on load.
 *
 * Rules this file keeps (W96):
 * - **Server-rendered, outside the SPA.** The React app would need its bundle, its service worker and its auth
 *   bootstrap to say one sentence, and a link-preview crawler runs no JavaScript.
 * - **Nothing about the invite is logged or stored.** An address invite carries the host's public IP. This module
 *   imports no logger and no database, on purpose.
 * - **Nothing from the request is written into the page unless it passed `parseJoinPath`**, and what passed is
 *   still HTML-escaped. The refusal page is a constant.
 * - **The link preview never names the host.** The Open Graph tags are the same for every invite.
 *
 * The two invite shapes mirror the companion's `companion/src/main/deep-link.ts` (`CODE`, `ADDRESS`, `LINK_MAX`),
 * except that a match code here is upper-case only, which is what the companion writes.
 */

export const JOIN_PATH_PREFIX = '/castcade/join/';
export const INVITE_MAX = 300;
/** Every character of an invite could be a three-character escape. */
const RAW_SEGMENT_MAX = INVITE_MAX * 3;
export const CASTCADE_RELEASES_URL = 'https://github.com/mekelburgj20/castcade/releases/latest';

/** What `encodeURIComponent` leaves of an invite: unreserved characters and escapes. No `/`, `:`, `#`, `?`. */
const RAW_SEGMENT = /^[A-Za-z0-9%._~-]+$/;
const CODE = /^[A-Z]{6}$/;
const ADDRESS = /^castcade:ws:\/\/(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})\/?#([A-Z]{6})$/;

export interface JoinInvite {
    /** The invite as the companion takes it: `ABCDEF` or `castcade:ws://host:port#ABCDEF`. */
    invite: string;
    /** The six-letter match code. */
    code: string;
    /** True for an address invite (it names the host's address). */
    isAddress: boolean;
    /** `castcade://join/<encoded invite>`: the companion's own link. */
    link: string;
}

/** The invite checked against the two shapes; null when it is neither. */
export function parseInvite(invite: string): JoinInvite | null {
    if (typeof invite !== 'string' || invite.length === 0 || invite.length > INVITE_MAX) return null;
    let code: string;
    let isAddress = false;
    if (CODE.test(invite)) {
        code = invite;
    } else {
        const m = ADDRESS.exec(invite);
        if (!m) return null;
        const port = Number(m[2]);
        if (port < 1 || port > 65535) return null;
        code = m[3]!;
        isAddress = true;
    }
    return { invite, code, isAddress, link: `castcade://join/${encodeURIComponent(invite)}` };
}

/**
 * The invite of a request URL (`req.originalUrl`, still percent-encoded), or null. Exactly
 * `/castcade/join/<one segment>`: no trailing slash, no second segment. A query string is ignored (chat apps and
 * browsers append their own) and is never read.
 */
export function parseJoinPath(originalUrl: string): JoinInvite | null {
    if (typeof originalUrl !== 'string') return null;
    const end = originalUrl.search(/[?#]/);
    const pathname = end === -1 ? originalUrl : originalUrl.slice(0, end);
    if (!pathname.startsWith(JOIN_PATH_PREFIX)) return null;
    const raw = pathname.slice(JOIN_PATH_PREFIX.length);
    if (raw.length === 0 || raw.length > RAW_SEGMENT_MAX || !RAW_SEGMENT.test(raw)) return null;
    let invite: string;
    try {
        invite = decodeURIComponent(raw);
    } catch {
        return null; // malformed percent-encoding
    }
    return parseInvite(invite);
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: #0d1017; color: #e6e9ef; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 460px; padding: 28px; border: 1px solid #262c3a; border-radius: 14px; background: #151a24; }
h1 { margin: 0 0 16px; font-size: 1.4rem; line-height: 1.25; }
p { margin: 14px 0 0; color: #b4bccb; }
a { color: #8ab4ff; }
.open { display: block; margin: 4px 0 0; padding: 14px 18px; border-radius: 10px; background: #3b82f6; color: #fff;
  font-weight: 600; font-size: 1.05rem; text-align: center; text-decoration: none; }
.open:hover, .open:focus-visible { background: #2f6fe0; }
.code { display: block; margin: 6px 0 0; padding: 10px 12px; border-radius: 8px; background: #0d1017; color: #e6e9ef;
  border: 1px solid #262c3a; font: 1.25rem/1.3 ui-monospace, Consolas, monospace; letter-spacing: 0.18em;
  overflow-wrap: anywhere; user-select: all; }
.code.long { font-size: 0.85rem; letter-spacing: 0; }
.foot { font-size: 0.9rem; }
`;

/** Runs once per page load. It reads the link from the button, so no part of the request is ever inside a script. */
const SCRIPT = `
(function () {
  var a = document.getElementById('open');
  if (!a) return;
  try { window.location.href = a.href; } catch (e) { /* the button is still there */ }
})();
`;

const OG_TITLE = 'Join a Castcade match';
const OG_DESCRIPTION = 'Open this link on the PC where Castcade is installed to join the match.';

interface PageOptions {
    nonce: string;
    /** `https://host` for the preview image, or null when the Host header is not a plain host name. */
    origin: string | null;
}

function head(title: string, opts: PageOptions): string {
    const lines = [
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        '<meta name="robots" content="noindex, nofollow" />',
        '<meta name="referrer" content="no-referrer" />',
        `<title>${escapeHtml(title)}</title>`,
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="Arcaid" />',
        `<meta property="og:title" content="${escapeHtml(OG_TITLE)}" />`,
        `<meta property="og:description" content="${escapeHtml(OG_DESCRIPTION)}" />`,
        '<meta name="twitter:card" content="summary" />',
        `<meta name="twitter:title" content="${escapeHtml(OG_TITLE)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(OG_DESCRIPTION)}" />`,
    ];
    if (opts.origin) {
        lines.push(`<meta property="og:image" content="${escapeHtml(opts.origin)}/arcaid-logo-v2.png" />`);
    }
    lines.push(`<style nonce="${opts.nonce}">${STYLE}</style>`);
    return `<head>\n${lines.join('\n')}\n</head>`;
}

/** The page for a valid invite. */
export function renderJoinPage(join: JoinInvite, opts: PageOptions): string {
    const link = escapeHtml(join.link);
    const code = escapeHtml(join.code);
    const byHand = join.isAddress
        ? `<p>Or copy this invite, then in Castcade press Match, Paste, Join:</p>
<code class="code long" id="invite">${escapeHtml(join.invite)}</code>
<p>Match code: <strong>${code}</strong></p>`
        : `<p>Or type this code in Castcade (Match, then Join):</p>
<code class="code" id="invite">${code}</code>`;
    return `<!doctype html>
<html lang="en">
${head(`${OG_TITLE} · Arcaid`, opts)}
<body>
<main>
<h1>Join this Castcade match</h1>
<a class="open" id="open" href="${link}">Open in Castcade</a>
${byHand}
<p class="foot">Nothing happened? Castcade is not installed on this PC yet.
<a href="${CASTCADE_RELEASES_URL}" rel="noopener noreferrer">Install Castcade</a>, then press the button again.</p>
</main>
<script nonce="${opts.nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

/** The refusal. A constant: nothing of the request is in it. */
export function renderNotInvitePage(opts: PageOptions): string {
    return `<!doctype html>
<html lang="en">
${head('Not a Castcade invite · Arcaid', opts)}
<body>
<main>
<h1>Not a Castcade invite</h1>
<p>This link is not a Castcade match invite. Ask the host to send the link again, or type the six-letter match
code in Castcade (Match, then Join).</p>
<p class="foot"><a href="${CASTCADE_RELEASES_URL}" rel="noopener noreferrer">Get Castcade</a></p>
</main>
</body>
</html>
`;
}

/** `https://host` when the Host header is a plain host (it goes into a meta tag), else null. */
function requestOrigin(req: Request): string | null {
    const host = req.get('host');
    if (!host || host.length > 255 || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
    return `${req.protocol === 'http' ? 'http' : 'https'}://${host}`;
}

export function castcadeJoinHandler(req: Request, res: Response): void {
    const nonce = randomBytes(16).toString('base64');
    const opts: PageOptions = { nonce, origin: requestOrigin(req) };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // The path holds the invite; a click on the releases link must not carry it to another site.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; ` +
        `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const join = req.method === 'GET' || req.method === 'HEAD' ? parseJoinPath(req.originalUrl) : null;
    if (!join) {
        res.status(404).type('html').send(renderNotInvitePage(opts));
        return;
    }
    res.status(200).type('html').send(renderJoinPage(join, opts));
}

/**
 * Mounts the page. Call it before the SPA's static files and catch-all: everything at or under `/castcade/join`
 * is answered here (a room cannot be named `castcade`, `RESERVED_ROOM_SLUGS`).
 */
export function mountCastcadeJoin(app: Express): void {
    app.use('/castcade/join', castcadeJoinLimiter, castcadeJoinHandler);
}
