import { createHash } from 'crypto';
import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { resolveTimezone, roomTimezonesFor, roomTimezone, serverTimezone } from '../utils/roomTimezone.js';
import { dotsString, DOT_SEPARATOR, type DotLine } from '../utils/cabinetDots.js';
import { normalizeCabinetScreens, parseCabinetScreens, type CabinetScreenPrefs } from '../utils/cabinetScreens.js';
import { CODE_ALPHABET, PAIRING_CODE_LEN, type WitnessDeviceType } from './WitnessService.js';
import {
    CABINET_DMD_DOT_RECT, CABINET_FRAME_STYLE_VERSION,
    type CabinetActivityData, type CabinetActivityItem, type CabinetAttractData, type CabinetBoardRow,
    type CabinetCardData, type CabinetEventData, type CabinetFrameInput, type CabinetFrameKind,
    type CabinetGlobalData, type CabinetPairData, type CabinetScreenKey, type CabinetStandingsData,
} from './cabinetFrameTypes.js';
import type { CabinetFrameScope } from './CabinetFrameRenderer.js';
import type { OpenDeviceGame } from './VpxScoreIngestService.js';
import type { DeviceAttemptsLeft } from './AttemptService.js';

/**
 * W132.2 (ADR 0046, docs/cabinet-frames-plan.md "Server") - what a Legends
 * Pinball's backglass and DMD show while the Witness tile is open: an ordered
 * list of screens, each one backglass picture + one DMD picture + the DMD's
 * live dot lines, for the device's CURRENT player (ADR 0045).
 *
 *   - The player is resolved ONCE per request (`WitnessPlaySessionService.
 *     playingAs`, or the caller on the preview) and that one id is threaded
 *     through every read: routing, open cards, attempts, "your row",
 *     standings, the feed, events. Never the pairing account by default.
 *   - Every read is an existing one (open cards = the ingest's own
 *     `openGamesForDevice` + `orderTileCards`; boards = `getForGame`; attempts
 *     = `deviceAttemptsLeft`; routed rooms = `ActivityLogService.roomsForDevice`;
 *     events = `EventLobbyService.eventIdsForDevice`). Nothing here writes.
 *   - Every string is display-ready (the contract, `cabinetFrameTypes.ts`):
 *     names resolved (`A PLAYER` when none, never an id), times in the room's
 *     zone, no running clock in a picture (hour-bucketed "ENDS IN 2D 4H" or a
 *     clock time); seconds tick only in the dot lines.
 *   - A picture's id is a hash of its input (`cabinetFrameId`): same data,
 *     same picture, rendered once (`CabinetFrameRenderer`).
 *   - Each screen is best-effort: a failed read drops that screen and logs.
 */

export const CABINET_MAX_CARDS = 6;
export const CABINET_MAX_GLOBAL = 2;
export const CABINET_MAX_STANDINGS = 2;
export const CABINET_ACTIVITY_ITEMS = 6;
export const CABINET_ACTIVITY_PER_ROOM = 8;
/** How often the cabinet fetches the manifest (seconds). */
export const CABINET_MANIFEST_REFRESH_SEC = 60;
/** A feed item this new is drawn hot. */
const HOT_WINDOW_SEC = 15 * 60;
/** The dot window, as the manifest's `s<i>Rect`. */
export const CABINET_DMD_RECT_TEXT =
    `${CABINET_DMD_DOT_RECT.x},${CABINET_DMD_DOT_RECT.y},${CABINET_DMD_DOT_RECT.w},${CABINET_DMD_DOT_RECT.h}`;
/** What a board row says for a player whose name cannot be resolved. */
export const UNKNOWN_PLAYER = 'A PLAYER';

/** One picture: its id (the file name) and what it is drawn from. */
export interface CabinetFrame { id: string; input: CabinetFrameInput }

export interface CabinetScreen {
    key: CabinetScreenKey;
    secs: number;
    backglass: CabinetFrame | null;
    dmd: CabinetFrame | null;
    /** The dot window on the DMD ("" = no dots). */
    rect: string;
    /** The dot lines in wire form ("" = none). */
    dots: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** sha256 over kind + screen + JSON(data) + the style version, first 32 hex chars. */
export function cabinetFrameId(input: CabinetFrameInput): string {
    return createHash('sha256')
        .update([input.kind, input.screen, JSON.stringify(input.data), String(CABINET_FRAME_STYLE_VERSION)].join('\n'))
        .digest('hex')
        .slice(0, 32);
}

/** A pairing code exactly as the tile shows it: 6 characters of its alphabet. */
export function isPairingCode(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== PAIRING_CODE_LEN) return false;
    return [...value].every(c => CODE_ALPHABET.includes(c));
}

/** Upper case, whitespace collapsed (a picture's chips and titles). */
export function shout(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** A raw user id or synthetic identity that must never be drawn as a name. */
function looksLikeId(value: string): boolean {
    return /^\d{15,22}$/.test(value) || /^(iscored|atgames|anon|google|system|discord):/i.test(value);
}

/** A board row's name: the resolved label, else "A PLAYER"; never an id. */
export function boardName(displayName: string | null | undefined, username: string | null | undefined): string {
    for (const candidate of [displayName, username]) {
        const name = (candidate ?? '').replace(/\s+/g, ' ').trim();
        if (name && !looksLikeId(name)) return name.toUpperCase().slice(0, 40);
    }
    return UNKNOWN_PLAYER;
}

/** 1 -> "1ST", 22 -> "22ND", 13 -> "13TH". */
export function ordinal(n: number): string {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' } as Record<number, string>)[n % 10] ?? 'TH';
    return `${n}${suffix}`;
}

/** 1234560 -> "1,234,560" (non-negative whole numbers; anything else "0"). */
export function grouped(value: number): string {
    const n = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A footer amount: grouped under a million, else "1.2 MILLION" / "1.2 BILLION". */
export function compactAmount(value: number): string {
    const n = Math.max(0, Math.floor(value));
    const scale = n >= 1e9 ? { d: 1e9, w: 'BILLION' } : n >= 1e6 ? { d: 1e6, w: 'MILLION' } : null;
    if (!scale) return grouped(n);
    return `${(Math.floor((n / scale.d) * 10) / 10).toFixed(1).replace(/\.0$/, '')} ${scale.w}`;
}

/** "9:00 PM" in `tz`. */
export function clockText(epochSec: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
        .format(new Date(epochSec * 1000)).replace(/\s+/g, ' ').toUpperCase();
}

/** The calendar day in `tz`, as YYYY-MM-DD. */
function dayKey(epochSec: number, tz: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(epochSec * 1000));
}

/**
 * When a card closes, as a picture may say it: no running clock. Under a day
 * a clock time ("ENDS TODAY 9:00 PM"), else whole days and hours ("ENDS IN 2D
 * 4H"), which changes at most once an hour, so the picture is redrawn hourly.
 */
export function endsText(closesTs: number | null, nowSec: number, tz: string): string | null {
    if (closesTs == null) return null;
    const left = closesTs - nowSec;
    if (left <= 0) return 'ENDS SOON';
    if (left < 86_400) {
        const day = dayKey(closesTs, tz) === dayKey(nowSec, tz) ? 'TODAY' : 'TOMORROW';
        return `ENDS ${day} ${clockText(closesTs, tz)}`;
    }
    const days = Math.floor(left / 86_400);
    const hours = Math.floor((left % 86_400) / 3_600);
    return hours > 0 ? `ENDS IN ${days}D ${hours}H` : `ENDS IN ${days}D`;
}

/** A feed item's time: today a clock time, yesterday "YESTERDAY", older "NOV 26". */
export function feedWhenText(epochSec: number, nowSec: number, tz: string): string {
    const day = dayKey(epochSec, tz);
    if (day === dayKey(nowSec, tz)) return clockText(epochSec, tz);
    if (day === dayKey(nowSec - 86_400, tz)) return 'YESTERDAY';
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' })
        .format(new Date(epochSec * 1000)).toUpperCase();
}

/** "1 PLAYER" / "14 PLAYERS". */
function count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** SQLite UTC text or ISO -> unix seconds, or null. */
function toSec(value: string | null | undefined): number | null {
    if (!value) return null;
    const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** One screen: the same data drawn for both panels, ids hashed, dots in wire form. */
export function makeScreen<K extends CabinetScreenKey>(
    key: K, data: Extract<CabinetFrameInput, { screen: K }>['data'], secs: number, dots: DotLine[] | null,
): CabinetScreen {
    const frame = (kind: CabinetFrameKind): CabinetFrame => {
        const input = { kind, screen: key, data } as CabinetFrameInput;
        return { id: cabinetFrameId(input), input };
    };
    const dotText = dots ? dotsString(dots) : '';
    return {
        key, secs, backglass: frame('backglass'), dmd: frame('dmd'),
        rect: dotText ? CABINET_DMD_RECT_TEXT : '', dots: dotText,
    };
}

/** A screen's name in the player's preview strip: "Attract", the card's table, "Global: AC/DC", the group, the event. */
export function screenLabel(screen: CabinetScreen): string {
    const input = (screen.backglass ?? screen.dmd)?.input;
    if (!input) return screen.key;
    switch (input.screen) {
        case 'attract': return 'Attract';
        case 'card': return input.data.table;
        case 'global': return `Global: ${input.data.table}`;
        case 'standings': return input.data.title;
        case 'activity': return 'Activity';
        case 'event': return input.data.eventName;
        case 'pair': return 'Pair';
    }
}

/** A ranked list's rows for a picture: the top `top`, plus the player's own row when it is below them. */
function boardRows<T>(
    board: readonly T[], top: number, mine: T | undefined,
    toRow: (row: T) => Omit<CabinetBoardRow, 'me'>,
): CabinetBoardRow[] {
    const shown = board.slice(0, top);
    if (mine && !shown.includes(mine)) shown.push(mine);
    return shown.map(row => ({ ...toRow(row), me: row === mine }));
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/** Everything one request has resolved, threaded through every screen. */
interface ScreenContext {
    deviceId: string;
    deviceType: WitnessDeviceType;
    playerId: string;
    playerLabel: string | null;
    nowSec: number;
    prefs: CabinetScreenPrefs;
    target: { roomId: string | null; tournamentId: string | null; globalOnly: boolean; globalFallback: boolean };
    /** Open cards in the tile's order. */
    cards: OpenDeviceGame[];
    attempts: Map<string, DeviceAttemptsLeft>;
    routedRooms: string[];
    roomNames: Map<string, string>;
    lastScore: Record<string, string>;
}

export class CabinetFrameService {
    /**
     * The device's screens for its current player, in show order: attract,
     * open cards (up to 6), global boards (up to 2), standings (up to 2),
     * activity, live event; only those the player switched on and that have
     * something to show. `playerId` overrides who is playing (the player's
     * preview on arcaid.app: "what my cabinet shows when I play").
     */
    static async screensFor(
        deviceId: string, opts: { playerId?: string | null; nowSec?: number } = {},
    ): Promise<{ playerId: string | null; screens: CabinetScreen[] }> {
        const ctx = await CabinetFrameService.context(deviceId, opts);
        if (!ctx) return { playerId: null, screens: [] };
        const on = new Set<CabinetScreenKey>(ctx.prefs.screens);
        const screens: CabinetScreen[] = [];
        const add = async (key: CabinetScreenKey, build: () => Promise<CabinetScreen[]>) => {
            if (!on.has(key)) return;
            try {
                screens.push(...await build());
            } catch (err) {
                logError(`Cabinet frames: the ${key} screen failed (the others still went out)`, err);
            }
        };
        await add('attract', async () => [await CabinetFrameService.attractScreen(ctx)]);
        await add('card', () => CabinetFrameService.cardScreens(ctx));
        await add('global', () => CabinetFrameService.globalScreens(ctx));
        await add('standings', () => CabinetFrameService.standingsScreens(ctx));
        await add('activity', () => CabinetFrameService.activityScreens(ctx));
        await add('event', () => CabinetFrameService.eventScreens(ctx));
        return { playerId: ctx.playerId, screens };
    }

    /** The one pair screen an unpaired cabinet shows: only the code (and its QR link). */
    static pairScreens(code: string): CabinetScreen[] {
        const base = (process.env.PUBLIC_URL || 'https://arcaid.app').replace(/\/+$/, '');
        const data: CabinetPairData = { code, url: `${base}/pair/${code}` };
        return [makeScreen('pair', data, parseCabinetScreens(null).seconds, null)];
    }

    /**
     * Which pictures are on disk; every missing one is queued for rendering
     * (never awaited: the manifest answers at once and says `Ready "0"`).
     */
    static async readiness(screens: readonly CabinetScreen[], scope: CabinetFrameScope): Promise<Set<string>> {
        const { CabinetFrameRenderer } = await import('./CabinetFrameRenderer.js');
        const ready = new Set<string>();
        for (const frame of screens.flatMap(s => [s.backglass, s.dmd])) {
            if (!frame || ready.has(frame.id)) continue;
            if (await CabinetFrameRenderer.has(frame.id, scope)) ready.add(frame.id);
            else CabinetFrameRenderer.enqueue(frame.id, frame.input, scope);
        }
        return ready;
    }

    /**
     * The manifest for the tile's naive `"key":"value"` reader: flat strings,
     * no URL, no `"` or `\` (ids are hex, dots are sanitised, the rest is
     * digits and fixed words). `ok` is the one boolean, as on every device answer.
     */
    static manifest(screens: readonly CabinetScreen[], ready: ReadonlySet<string>, nowSec: number): Record<string, string | boolean> {
        const out: Record<string, string | boolean> = {
            ok: true, now: String(Math.floor(nowSec)), refresh: String(CABINET_MANIFEST_REFRESH_SEC), count: String(screens.length),
        };
        screens.forEach((screen, i) => {
            const n = i + 1;
            const bg = screen.backglass?.id ?? '';
            const dmd = screen.dmd?.id ?? '';
            out[`s${n}Kind`] = screen.key;
            out[`s${n}Secs`] = String(screen.secs);
            out[`s${n}Bg`] = bg;
            out[`s${n}Dmd`] = dmd;
            out[`s${n}Ready`] = (!bg || ready.has(bg)) && (!dmd || ready.has(dmd)) ? '1' : '0';
            out[`s${n}Rect`] = screen.rect;
            out[`s${n}Dots`] = screen.dots;
        });
        return out;
    }

    /** A player's screen choices on a device (defaults when they never chose, or are not on it). */
    static async preferencesFor(deviceId: string, playerId: string): Promise<CabinetScreenPrefs> {
        const db = await getDatabase();
        const row = await db.get<{ cabinet_screens: string | null }>(
            `SELECT cabinet_screens FROM witness_device_players
              WHERE device_id = ? AND canonical_user_id = ? AND removed_at IS NULL`,
            deviceId, playerId,
        );
        return parseCabinetScreens(row?.cabinet_screens ?? null);
    }

    /** Store a player's choices (normalised first); null when they are not on the device. */
    static async setPreferences(deviceId: string, playerId: string, body: unknown): Promise<CabinetScreenPrefs | null> {
        const prefs = normalizeCabinetScreens(body);
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE witness_device_players SET cabinet_screens = ?
              WHERE device_id = ? AND canonical_user_id = ? AND removed_at IS NULL`,
            JSON.stringify(prefs), deviceId, playerId,
        );
        return (result.changes ?? 0) > 0 ? prefs : null;
    }

    // -- context --------------------------------------------------------------

    /** Resolve the player once and read what several screens share. Null for an unknown or unpaired device. */
    private static async context(
        deviceId: string, opts: { playerId?: string | null; nowSec?: number },
    ): Promise<ScreenContext | null> {
        const db = await getDatabase();
        const device = await db.get<{ device_type: string | null; revoked_at: string | null }>(
            'SELECT device_type, revoked_at FROM witness_devices WHERE atgames_unique_id = ?', deviceId,
        );
        if (!device || device.revoked_at) return null;
        const deviceType: WitnessDeviceType = device.device_type === 'desktop' ? 'desktop' : 'atgames';
        const nowSec = Math.floor(opts.nowSec ?? Date.now() / 1000);

        const { WitnessPlaySessionService } = await import('./WitnessPlaySessionService.js');
        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        let playerId = opts.playerId ?? null;
        let playerLabel: string | null = null;
        if (playerId) {
            playerLabel = (await resolveUserLabels([playerId]))[playerId] ?? null;
        } else {
            const playing = await WitnessPlaySessionService.playingAs(deviceId);
            if (!playing) return null;
            playerId = playing.userId;
            playerLabel = playing.label;
        }

        const { WitnessService } = await import('./WitnessService.js');
        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const { AttemptService } = await import('./AttemptService.js');
        const { ActivityLogService } = await import('./ActivityLogService.js');
        const { WitnessTileService, orderTileCards, boardLabel } = await import('./WitnessTileService.js');

        const target = await WitnessService.getDeviceTarget(deviceId, playerId);
        const games = await VpxScoreIngestService.openGamesForDevice({ canonicalUserId: playerId, target, deviceType, nowTs: nowSec });
        const cards = orderTileCards(games.map(g => ({
            name: boardLabel(g.roomName, g.tournamentName), table: g.gameName,
            closes: g.endsTs ?? g.nextRotationTs, gameId: g.gameId, tournamentId: g.tournamentId, game: g,
        }))).map(c => c.game);
        const attempts = await AttemptService.deviceAttemptsLeft({ deviceId, canonicalUserId: playerId, nowTs: nowSec, deviceType });
        const routedRooms = await ActivityLogService.roomsForDevice(deviceId, playerId);
        const roomNames = await CabinetFrameService.roomNames([...routedRooms, ...cards.map(c => c.roomId)]);
        const lastScore = await WitnessTileService.lastScoreBlock({ deviceId, canonicalUserId: playerId, deviceType });
        return {
            deviceId, deviceType, playerId, playerLabel, nowSec,
            prefs: await CabinetFrameService.preferencesFor(deviceId, playerId),
            target, cards, attempts: new Map(attempts.map(a => [a.gameId, a])),
            routedRooms, roomNames, lastScore,
        };
    }

    private static async roomNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
        const unique = [...new Set(ids.filter((id): id is string => !!id))];
        if (unique.length === 0) return new Map();
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string; name: string }>>(
            `SELECT id, name FROM game_rooms WHERE id IN (${unique.map(() => '?').join(',')})`, ...unique,
        );
        return new Map(rows.map(r => [r.id, r.name]));
    }

    // -- attract --------------------------------------------------------------

    /** "Mox Game Room + 2 rooms", "All my rooms", "Global only", a pinned tournament's own line. */
    private static async sendingTo(ctx: ScreenContext): Promise<string> {
        if (ctx.target.globalOnly && !ctx.target.roomId) return 'Global only';
        if (ctx.target.tournamentId) {
            const { WitnessService } = await import('./WitnessService.js');
            return WitnessService.describeTarget(ctx.deviceId, ctx.playerId);
        }
        const names = ctx.routedRooms.map(id => ctx.roomNames.get(id)).filter((n): n is string => !!n);
        if (names.length === 0) return 'All my rooms';
        if (names.length === 1) return names[0]!;
        return `${names[0]} + ${count(names.length - 1, 'room', 'rooms')}`;
    }

    private static async attractScreen(ctx: ScreenContext): Promise<CabinetScreen> {
        const player = ctx.playerLabel && !looksLikeId(ctx.playerLabel) ? shout(ctx.playerLabel) : null;
        const ls = ctx.lastScore;
        const rank = /^(\d+) of (\d+)$/.exec(ls.lastScoreRank ?? '');
        const data: CabinetAttractData = {
            player,
            sendingTo: await CabinetFrameService.sendingTo(ctx),
            lastScore: ls.lastScoreTable && ls.lastScoreValue
                ? {
                    table: ls.lastScoreTable, value: ls.lastScoreValue,
                    rankText: rank ? `${ordinal(Number(rank[1])).toLowerCase()} of ${rank[2]}` : null,
                }
                : null,
            openCount: ctx.cards.length,
        };
        const dots: DotLine[] = [{ type: 'logo' }];
        if (player) dots.push({ type: 'text', small: 'PLAYING AS', big: player });
        dots.push({ type: 'text', small: 'OPEN TABLES', big: String(ctx.cards.length) });
        if (data.lastScore) dots.push({ type: 'text', small: 'LAST SCORE', big: data.lastScore.value });
        return makeScreen('attract', data, ctx.prefs.seconds, dots);
    }

    // -- open cards -----------------------------------------------------------

    /**
     * A card's picture background, as the room board draws it: the game's
     * style background when it has one, else the table's catalogue art.
     * Keyed by game id; one query for every card.
     */
    private static async cardArt(cards: readonly OpenDeviceGame[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        if (cards.length === 0) return out;
        const db = await getDatabase();
        const ids = cards.map(c => c.gameId);
        const styles = await db.all<Array<{
            id: string; bg_style_id: string | null; catalogue_style_id: string | null;
            bg_has_bg: number | null; cat_has_bg: number | null;
        }>>(
            `SELECT g.id, g.bg_style_id, g.catalogue_style_id,
                    sc_bg.has_background AS bg_has_bg, sc_cat.has_background AS cat_has_bg
               FROM games g
               LEFT JOIN style_catalogue sc_bg ON sc_bg.id = g.bg_style_id
               LEFT JOIN style_catalogue sc_cat ON sc_cat.id = g.catalogue_style_id
              WHERE g.id IN (${ids.map(() => '?').join(',')})`,
            ...ids,
        );
        for (const s of styles) {
            const bg = s.bg_style_id && s.bg_has_bg !== 0 ? s.bg_style_id
                : s.catalogue_style_id && s.cat_has_bg !== 0 ? s.catalogue_style_id : null;
            if (bg) out.set(s.id, `/api/styles/images/backgrounds/${encodeURIComponent(bg)}.png`);
        }
        const { GameArtService } = await import('./GameArtService.js');
        const art = await GameArtService.artForNames(cards.map(c => c.gameName));
        for (const c of cards) {
            const url = art.get(GameArtService.key(c.gameName));
            if (!out.has(c.gameId) && url && url.startsWith('/')) out.set(c.gameId, url);
        }
        return out;
    }

    private static async cardScreens(ctx: ScreenContext): Promise<CabinetScreen[]> {
        const cards = ctx.cards.slice(0, CABINET_MAX_CARDS);
        if (cards.length === 0) return [];
        const { LeaderboardService } = await import('./LeaderboardService.js');
        const art = await CabinetFrameService.cardArt(cards);
        const zones = await roomTimezonesFor(cards.map(c => c.roomId).filter((id): id is string => !!id));
        const out: CabinetScreen[] = [];
        for (const card of cards) {
            const board = await LeaderboardService.getForGame(card.gameId);
            const mine = board.find(r => r.submitted_by_user_id === ctx.playerId)
                ?? board.find(r => r.discord_user_id === ctx.playerId);
            const idx = mine ? board.indexOf(mine) : -1;
            const table = shout(card.gameName);
            const attempts = ctx.attempts.get(card.gameId);
            const closes = card.endsTs ?? card.nextRotationTs;
            const tz = resolveTimezone(null, card.roomId ? zones.get(card.roomId) : null);
            const above = idx > 0 ? board[idx - 1] : undefined;
            const below = idx === 0 ? board[1] : undefined;

            const data: CabinetCardData = {
                roomName: card.roomId ? shout(card.roomName ?? ctx.roomNames.get(card.roomId) ?? '') || 'ROOM' : 'THROWDOWN',
                kindLabel: shout(card.tournamentName) || 'TOURNAMENT',
                table,
                artUrl: art.get(card.gameId) ?? null,
                endsText: endsText(closes, ctx.nowSec, tz),
                attemptsText: !attempts ? null
                    : attempts.notStarted ? 'PRESS START'
                        : attempts.practice ? 'PRACTICE'
                            : `${attempts.left} OF ${attempts.limit} ATTEMPTS LEFT`,
                practice: !!attempts?.practice,
                rows: boardRows(board, 5, mine, r => ({
                    rank: String(r.rank), name: boardName(r.display_name, r.iscored_username), score: grouped(r.score),
                })),
                playersText: count(board.length, 'PLAYER', 'PLAYERS'),
                footerRight: !mine ? 'NO SCORE FROM YOU YET'
                    : above ? `YOU NEED ${compactAmount(above.score - mine.score)} FOR ${ordinal(above.rank)}`
                        : below ? `YOU LEAD BY ${compactAmount(mine.score - below.score)}` : 'YOU LEAD',
            };

            const dots: DotLine[] = [];
            if (above && mine) dots.push({ type: 'text', small: `TO TAKE ${ordinal(above.rank)} ON ${table}`, big: `+${grouped(above.score - mine.score)}` });
            else if (mine && below) dots.push({ type: 'text', small: `YOU LEAD ON ${table}`, big: `+${grouped(mine.score - below.score)}` });
            else if (mine) dots.push({ type: 'text', small: `YOU LEAD ON ${table}`, big: grouped(mine.score) });
            else if (board[0]) dots.push({ type: 'text', small: `SCORE TO BEAT ON ${table}`, big: grouped(board[0].score) });
            else dots.push({ type: 'text', small: `NO SCORES YET ON ${table}`, big: 'BE THE FIRST' });
            if (closes != null) dots.push({ type: 'count', small: `${data.kindLabel} ENDS IN`, endTs: closes });
            if (attempts?.practice) dots.push({ type: 'text', small: 'PRACTICE', big: 'NO ATTEMPT USED' });
            else if (attempts?.notStarted) dots.push({ type: 'text', small: 'ATTEMPTS', big: 'PRESS START' });
            else if (attempts) dots.push({ type: 'text', small: 'ATTEMPTS LEFT', big: `${attempts.left} OF ${attempts.limit}` });
            out.push(makeScreen('card', data, ctx.prefs.seconds, dots));
        }
        return out;
    }

    // -- global boards --------------------------------------------------------

    /**
     * The first tables of the carousel (else the table of the last score) on
     * the Global Scoreboard: the table's main category board (`getForCard`),
     * or its whole board when it has one category (`getForGame`).
     */
    private static async globalScreens(ctx: ScreenContext): Promise<CabinetScreen[]> {
        const names = [...new Set([...ctx.cards.map(c => c.gameName), ctx.lastScore.lastScoreTable].filter((n): n is string => !!n))];
        if (names.length === 0) return [];
        const { catalogueIdForName } = await import('../utils/ratingTarget.js');
        const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
        const { GameArtService } = await import('./GameArtService.js');
        const db = await getDatabase();
        const out: CabinetScreen[] = [];
        for (const name of names) {
            if (out.length >= CABINET_MAX_GLOBAL) break;
            const globalGameId = await catalogueIdForName(db, name);
            if (!globalGameId) continue;
            const categories = await GlobalLeaderboardService.getCardCategories(globalGameId);
            if (categories.length === 0) continue;
            const board = categories.length === 1
                ? await GlobalLeaderboardService.getForGame(globalGameId)
                : await GlobalLeaderboardService.getForCard(globalGameId, categories[0]!.category);
            if (board.length === 0) continue;
            const mine = board.find(r => r.discord_user_id === ctx.playerId);
            const idx = mine ? board.indexOf(mine) : -1;
            const above = idx > 0 ? board[idx - 1] : undefined;
            const table = shout(name);
            const art = (await GameArtService.artForNames([name])).get(GameArtService.key(name)) ?? null;
            const data: CabinetGlobalData = {
                table,
                artUrl: art && art.startsWith('/') ? art : null,
                playersText: `${count(board.length, 'PLAYER', 'PLAYERS')}, EVERY ROOM`,
                rows: boardRows(board, 4, mine, r => ({
                    rank: String(r.rank), name: boardName(r.display_name, r.iscored_username), score: grouped(r.score), region: '',
                })),
                footerRight: mine ? `YOU ARE #${mine.rank} OF ${board.length}` : 'NO GLOBAL SCORE FROM YOU YET',
            };
            const dots: DotLine[] = mine
                ? [{ type: 'text', small: `GLOBAL RANK ON ${table}`, big: `#${mine.rank} OF ${board.length}` }]
                : [{ type: 'text', small: `GLOBAL HIGH SCORE ON ${table}`, big: grouped(board[0]!.score) }];
            if (above && mine) dots.push({ type: 'text', small: `TO TAKE #${above.rank}`, big: `+${grouped(above.score - mine.score)}` });
            out.push(makeScreen('global', data, ctx.prefs.seconds, dots));
        }
        return out;
    }

    // -- standings ------------------------------------------------------------

    private static async standingsScreens(ctx: ScreenContext): Promise<CabinetScreen[]> {
        const { RankingService } = await import('./RankingService.js');
        const out: CabinetScreen[] = [];
        for (const roomId of ctx.routedRooms) {
            if (out.length >= CABINET_MAX_STANDINGS) break;
            for (const { group, rankings } of await RankingService.getActiveWithRankings(roomId)) {
                if (out.length >= CABINET_MAX_STANDINGS) break;
                if (rankings.length === 0) continue;
                const mine = rankings.find(r => r.discord_user_id === ctx.playerId);
                const idx = mine ? rankings.indexOf(mine) : -1;
                const above = idx > 0 ? rankings[idx - 1] : undefined;
                const below = idx === 0 ? rankings[1] : undefined;
                const nameOf = (r: typeof rankings[number]) => boardName(r.display_name, r.iscored_username);
                const tables = new Set(rankings.flatMap(r => r.breakdown.map(b => b.game_name.toLowerCase()))).size;
                const data: CabinetStandingsData = {
                    roomName: shout(ctx.roomNames.get(roomId)) || 'ROOM',
                    title: shout(group.name) || 'STANDINGS',
                    subtitle: null,
                    rows: boardRows(rankings, 10, mine, r => ({
                        rank: String(r.rank), name: nameOf(r), score: grouped(r.total_points),
                    })),
                    footerLeft: `POINTS FROM ${count(tables, 'TABLE', 'TABLES')}`,
                    footerRight: !mine ? 'NO POINTS FROM YOU YET'
                        : above ? `YOU: ${ordinal(mine.rank)}, ${grouped(above.total_points - mine.total_points)} BEHIND ${nameOf(above)}`
                            : below ? `YOU: ${ordinal(mine.rank)}, ${grouped(mine.total_points - below.total_points)} AHEAD OF ${nameOf(below)}`
                                : `YOU: ${ordinal(mine.rank)}`,
                };
                const ticker = rankings.slice(0, 5).map(r => `${r.rank} ${nameOf(r)} ${grouped(r.total_points)}`);
                if (mine && idx >= 5) ticker.push(`YOU ${ordinal(mine.rank)} ${grouped(mine.total_points)}`);
                const dots: DotLine[] = [{ type: 'ticker', small: data.title, text: ticker.join(` ${DOT_SEPARATOR} `) }];
                if (mine) dots.push({ type: 'text', small: 'YOUR STANDING', big: `${ordinal(mine.rank)} OF ${rankings.length}` });
                out.push(makeScreen('standings', data, ctx.prefs.seconds, dots));
            }
        }
        return out;
    }

    // -- activity -------------------------------------------------------------

    private static async activityScreens(ctx: ScreenContext): Promise<CabinetScreen[]> {
        if (ctx.routedRooms.length === 0) return [];
        const { LobbyFeedService } = await import('./LobbyFeedService.js');
        const { GameArtService } = await import('./GameArtService.js');
        const feeds = await Promise.all(ctx.routedRooms.map(roomId =>
            LobbyFeedService.getFeed(roomId, { limit: CABINET_ACTIVITY_PER_ROOM, viewerUserId: ctx.playerId })));
        const items = feeds.flat()
            .map(e => ({ e, at: toSec(e.created_at) ?? 0 }))
            .filter(({ e }) => !!e.title?.trim())
            .sort((a, b) => b.at - a.at || b.e.id - a.e.id)
            .slice(0, CABINET_ACTIVITY_ITEMS);
        if (items.length === 0) return [];
        const zones = await roomTimezonesFor(ctx.routedRooms);
        const art = await GameArtService.artForNames(items.map(({ e }) => e.game_name));
        const list: CabinetActivityItem[] = items.map(({ e, at }) => {
            const url = e.game_name ? art.get(GameArtService.key(e.game_name)) : undefined;
            return {
                whenText: feedWhenText(at, ctx.nowSec, resolveTimezone(null, zones.get(e.game_room_id))),
                text: e.title.replace(/\s+/g, ' ').trim(),
                roomName: shout(ctx.roomNames.get(e.game_room_id)),
                artUrl: url && url.startsWith('/') ? url : null,
                hot: e.player_id === ctx.playerId || e.target_user_id === ctx.playerId || ctx.nowSec - at < HOT_WINDOW_SEC,
            };
        });
        const data: CabinetActivityData = {
            roomCountText: count(ctx.routedRooms.length, 'ROOM', 'ROOMS'),
            items: list,
        };
        const dots: DotLine[] = [{ type: 'ticker', small: 'LATEST', text: list.map(i => i.text).join(` ${DOT_SEPARATOR} `) }];
        return [makeScreen('activity', data, ctx.prefs.seconds, dots)];
    }

    // -- live event -----------------------------------------------------------

    /**
     * The first event this device's plays reach (the lobby's own event list)
     * that is upcoming, open for check-in, live or between rounds: its current
     * round, else its next one. Read-only: never checks anyone in.
     */
    private static async eventScreens(ctx: ScreenContext): Promise<CabinetScreen[]> {
        const { EventLobbyService } = await import('./EventLobbyService.js');
        const { EventService } = await import('./EventService.js');
        const now = new Date(ctx.nowSec * 1000);
        for (const eventId of await EventLobbyService.eventIdsForDevice(ctx.deviceId, ctx.playerId)) {
            const event = await EventService.getEvent(eventId);
            if (!event) continue;
            const rounds = await EventService.getRounds(event.id);
            const state = EventService.deriveState(event, rounds, now);
            if (state === 'finished' || state === 'cancelled') continue;
            const live = state === 'live'
                ? rounds.find(r => now.getTime() >= Date.parse(r.scheduled_start_at) && now.getTime() < Date.parse(r.scheduled_end_at))
                : undefined;
            const round = live ?? rounds.find(r => Date.parse(r.scheduled_start_at) > now.getTime());
            if (!round) continue;
            return [await CabinetFrameService.eventScreen(ctx, event, rounds, round, state, !!live)];
        }
        return [];
    }

    private static async eventScreen(
        ctx: ScreenContext,
        event: import('./EventService.js').EventTournamentRow,
        rounds: import('./EventService.js').EventRoundRow[],
        round: import('./EventService.js').EventRoundRow,
        state: import('./EventService.js').EventState,
        live: boolean,
    ): Promise<CabinetScreen> {
        const { EventService } = await import('./EventService.js');
        const { GameArtService } = await import('./GameArtService.js');
        const tz = event.game_room_id ? resolveTimezone(null, await roomTimezone(event.game_room_id)) : serverTimezone();
        const startSec = Math.floor(Date.parse(round.scheduled_start_at) / 1000);
        const endSec = Math.floor(Date.parse(round.scheduled_end_at) / 1000);
        const art = (await GameArtService.artForNames([round.name])).get(GameArtService.key(round.name)) ?? null;
        const checkedIn = !!(await EventService.isParticipant(event.id, ctx.playerId));
        const players = await EventService.participantCount(event.id);
        const stateLabel = live ? 'LIVE'
            : state === 'checkin' ? 'CHECK-IN OPEN'
                : state === 'between_rounds' ? 'BETWEEN ROUNDS' : 'STARTS SOON';
        const data: CabinetEventData = {
            eventName: shout(event.name),
            stateLabel,
            roundLabel: `ROUND ${round.round_no}`,
            table: shout(round.name),
            artUrl: art && art.startsWith('/') ? art : null,
            startText: clockText(startSec, tz),
            endText: clockText(endSec, tz),
            checkedIn,
            footerLeft: await CabinetFrameService.afterRoundText(event.id, rounds, ctx),
            footerRight: players > 0 ? `${count(players, 'PLAYER', 'PLAYERS')} CHECKED IN` : '',
        };
        const dots: DotLine[] = [
            { type: 'text', small: stateLabel, big: data.eventName },
            live
                ? { type: 'count', small: `ROUND ${round.round_no} ENDS IN`, endTs: endSec }
                : { type: 'count', small: `ROUND ${round.round_no} STARTS IN`, endTs: startSec },
        ];
        return makeScreen('event', data, ctx.prefs.seconds, dots);
    }

    /** "AFTER ROUND 1: YOU ARE 4TH OF 11" once a round has ended and the player is in the standings; else "". */
    private static async afterRoundText(
        eventId: string, rounds: import('./EventService.js').EventRoundRow[], ctx: ScreenContext,
    ): Promise<string> {
        const ended = rounds.filter(r => Date.parse(r.scheduled_end_at) <= ctx.nowSec * 1000);
        const last = ended[ended.length - 1];
        if (!last) return '';
        const { EventResultService } = await import('./EventResultService.js');
        const standings = await EventResultService.computeStandings(eventId);
        const rows = standings?.standings ?? [];
        const mine = rows.find(r => r.discord_user_id === ctx.playerId);
        return mine ? `AFTER ROUND ${last.round_no}: YOU ARE ${ordinal(mine.rank)} OF ${rows.length}` : '';
    }
}
