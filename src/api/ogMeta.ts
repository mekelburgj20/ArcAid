import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { getDatabase } from '../database/database.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { normalizeImageUrl } from '../services/LeaderboardService.js';
import { logWarn } from '../utils/logger.js';

/**
 * S16 — Open Graph meta injection for link previews.
 *
 * When a link-preview crawler (Discord, Slack, Twitter, …) requests a shareable
 * SPA route (`/:slug/games/:name` or `/:slug/players/:id`), we serve the built
 * `index.html` shell with `og:*` / `twitter:*` tags injected into `<head>` so
 * the unfurl shows the game/player instead of a bare "Arcaid".
 *
 * Safety contract (a bug here must never break the app for humans):
 *   - Only fires for UAs matching the curated bot list — humans always get the
 *     unmodified shell via the normal `sendFile` path.
 *   - Any lookup/parse/read failure returns null → caller falls through to the
 *     unmodified shell.
 *   - Kill-switch: global setting `OG_META_ENABLED=false` disables injection
 *     entirely (settings hot-load into process.env via SettingsService).
 */

// Curated UA fragments: link-unfurl crawlers plus the three major search
// crawlers (googlebot/bingbot/applebot — better titles in search results is
// the same legitimate dynamic-rendering use case). Deliberately NOT a generic
// "bot" substring heuristic.
const BOT_UA_RE = new RegExp(
    [
        'discordbot',
        'twitterbot',
        'facebookexternalhit',
        'facebot',
        'slackbot',
        'slack-imgproxy',
        'telegrambot',
        'whatsapp',
        'linkedinbot',
        'pinterestbot',
        'redditbot',
        'skypeuripreview',
        'googlebot',
        'bingbot',
        'applebot',
        'embedly',
        'iframely',
        'vkshare',
        'mastodon',
        'bluesky',
        'snapchat',
        'viber',
    ].join('|'),
    'i',
);

export function isPreviewBot(userAgent: string | undefined): boolean {
    return !!userAgent && BOT_UA_RE.test(userAgent);
}

export interface ShareRoute {
    kind: 'game' | 'player';
    slug: string;
    name: string;
}

/** Parse a request path into a shareable route, or null if it isn't one. */
export function parseShareRoute(pathname: string): ShareRoute | null {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== 3) return null;
    const [rawSlug, section, rawName] = segments;
    if (!rawSlug || !rawName) return null;
    if (section !== 'games' && section !== 'players') return null;
    let slug: string;
    let name: string;
    try {
        slug = decodeURIComponent(rawSlug);
        name = decodeURIComponent(rawName);
    } catch {
        return null; // malformed percent-encoding
    }
    if (!slug.trim() || !name.trim()) return null;
    return { kind: section === 'games' ? 'game' : 'player', slug, name };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

interface OgMeta {
    title: string;
    description: string;
    url: string;
    image: string | null;
}

/** Render the meta block and splice it into the shell before `</head>`. */
export function injectOgTags(shell: string, meta: OgMeta): string | null {
    const headClose = shell.indexOf('</head>');
    if (headClose === -1) return null;
    const t = escapeHtml(meta.title);
    const d = escapeHtml(meta.description);
    const u = escapeHtml(meta.url);
    const lines = [
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="Arcaid" />',
        `<meta property="og:title" content="${t}" />`,
        `<meta property="og:description" content="${d}" />`,
        `<meta property="og:url" content="${u}" />`,
    ];
    if (meta.image) {
        const img = escapeHtml(meta.image);
        lines.push(`<meta property="og:image" content="${img}" />`);
        lines.push('<meta name="twitter:card" content="summary_large_image" />');
        lines.push(`<meta name="twitter:image" content="${img}" />`);
    } else {
        lines.push('<meta name="twitter:card" content="summary" />');
    }
    lines.push(`<meta name="twitter:title" content="${t}" />`);
    lines.push(`<meta name="twitter:description" content="${d}" />`);
    const block = `    ${lines.join('\n    ')}\n  `;
    let html = shell.slice(0, headClose) + block + shell.slice(headClose);
    // Mirror the og:title into the document title so crawlers that read
    // <title> (and any plain fetcher) see the page name too. Replacer FUNCTION,
    // not string — a name containing `$'`/`$&` would otherwise trigger
    // String.replace's special replacement patterns and corrupt the document.
    html = html.replace('<title>Arcaid</title>', () => `<title>${t} · Arcaid</title>`);
    return html;
}

// The built shell only changes on deploy (container restart), so one read is
// enough for the process lifetime.
let shellCache: { file: string; html: string } | null = null;

async function loadShell(frontendPath: string): Promise<string> {
    const file = path.join(frontendPath, 'index.html');
    if (shellCache?.file === file) return shellCache.html;
    const html = await fs.promises.readFile(file, 'utf8');
    shellCache = { file, html };
    return html;
}

/** Test hook: drop the cached shell so a new temp dir can be read. */
export function resetShellCacheForTests(): void {
    shellCache = null;
}

function toAbsoluteUrl(origin: string, url: string | null): string | null {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Build the injected shell for a preview-bot request, or null when the request
 * should be served the unmodified shell. Never throws.
 */
export async function maybeBuildOgShell(req: Request, frontendPath: string): Promise<string | null> {
    try {
        if (process.env.OG_META_ENABLED === 'false') return null;
        if (!isPreviewBot(req.get('user-agent'))) return null;
        const route = parseShareRoute(req.path);
        if (!route) return null;

        const room = await GameRoomService.getBySlug(route.slug);
        if (!room) return null;

        // S22 Phase 2 (v2.44.0) — a suspended room is hidden pending review;
        // a link-preview crawler must see the generic unmodified shell, same
        // as the approval-room leak closure below.
        if (room.suspended_at) return null;

        // v2.39.0 (approval rooms) leak closure — a link-preview crawler is
        // not a "member", so an 'approval'-policy room must never unfurl its
        // game/player content. Early-return to the generic unmodified shell.
        const { RoomAccessService } = await import('../services/RoomAccessService.js');
        if ((await RoomAccessService.getJoinPolicy(room.id)) === 'approval') return null;

        const host = req.get('host');
        if (!host) return null; // no Host header → can't build absolute og:url/og:image

        const db = await getDatabase();
        const origin = `${req.protocol}://${host}`;
        const canonicalUrl = `${origin}/${encodeURIComponent(room.slug)}/${route.kind === 'game' ? 'games' : 'players'}/${encodeURIComponent(route.name)}`;

        let title: string;
        let description: string;
        let image: string | null = null;

        if (route.kind === 'game') {
            // Canonical casing from the room's games row when it exists.
            const gameRow = await db.get<{ name: string }>(
                'SELECT name FROM games WHERE game_room_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
                room.id, route.name,
            );
            const gameName = gameRow?.name ?? route.name;
            const art = await db.get<{ image_url: string | null; local_image_path: string | null }>(
                `SELECT image_url, local_image_path FROM global_games
                  WHERE LOWER(name) = LOWER(?) AND status = 'approved'
                    AND (local_image_path IS NOT NULL OR image_url IS NOT NULL)
                  ORDER BY created_at ASC LIMIT 1`,
                route.name,
            );
            title = `${gameName} · ${room.name}`;
            description = `Leaderboard and top scores for ${gameName} at ${room.name} on Arcaid.`;
            image = normalizeImageUrl(art?.local_image_path || art?.image_url);
        } else {
            // Display resolution rule: display_name ?? iscored_username.
            const profile = await db.get<{ display_name: string | null }>(
                `SELECT up.display_name FROM user_mappings um
                  LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
                  WHERE LOWER(um.iscored_username) = LOWER(?) LIMIT 1`,
                route.name,
            );
            const playerName = profile?.display_name || route.name;
            title = `${playerName} · ${room.name}`;
            description = `Scores, stats and trophies for ${playerName} at ${room.name} on Arcaid.`;
        }

        if (!image) image = normalizeImageUrl(room.logo_url) || '/arcaid-logo-v2.png';

        const shell = await loadShell(frontendPath);
        return injectOgTags(shell, {
            title,
            description,
            url: canonicalUrl,
            image: toAbsoluteUrl(origin, image),
        });
    } catch (err) {
        logWarn('[og-meta] injection failed; serving unmodified shell', err);
        return null;
    }
}
