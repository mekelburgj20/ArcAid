import { isEncryptedKey, isMask } from './secrets.js';

/**
 * G15 (v2.228.0, ADR 0037 §10 amendment) - what an admin edit CHANGED, for the
 * activity log's details panel.
 *
 * An admin edit records `{changes: [{key, label, from, to}]}`: only the keys
 * whose stored value actually changed, read BEFORE the save and compared with
 * what was sent. A secret (`isEncryptedKey`, or a key whose name says
 * password / secret / token / hash / private key / API key) records
 * `{key, label, secret: true}` - that it changed, never a value, not even
 * ciphertext. A save that changed nothing records nothing.
 */

export interface ActivityChange {
    key: string;
    label: string;
    /** Absent for a secret. `null` = the setting was not set. */
    from?: string | null;
    to?: string | null;
    secret?: true;
}

/** Longest value a change row stores; the rest is cut with a marker. */
const MAX_VALUE_CHARS = 4000;

/**
 * Human names for the common room and server setting keys. The Settings page
 * keeps its own labels for its form; this map is the server's copy for the log
 * only (not the whole page). An unknown key shows as the key itself.
 */
export const SETTING_LABELS: Record<string, string> = {
    // Room basics + access
    ROOM_TIMEZONE: 'Room timezone',
    JOIN_POLICY: 'Room visibility',
    ROOM_LISTED: 'Listed on Arcaid',
    AUTO_APPROVE_GUILD_MEMBERS: 'Auto-approve Discord server members',
    DISCORD_JOIN_ROLE_IDS: 'Discord roles that may join',
    DISCORD_LINK_REMINDERS: 'Discord link reminders',
    REQUIRE_SCORE_PHOTO: 'Require photo with score submission',
    GLOBAL_SCOREBOARD_ENABLED: 'Post scores to Global Scoreboard',
    THEME: 'Theme',
    // Discord
    DISCORD_ENABLED: 'Discord integration',
    DISCORD_MENTIONS_ENABLED: 'Discord @mentions',
    DISCORD_GUILD_ID: 'Discord server (guild) ID',
    DISCORD_ADMIN_ROLE_ID: 'Discord admin role',
    DISCORD_ANNOUNCEMENT_CHANNEL_ID: 'Default announcement channel',
    DISCORD_ANNOUNCE_ROUTES: 'Announcement channels by kind',
    DISCORD_COMMAND_POLICY: 'Slash-command policy',
    DISCORD_INVITE_URL: 'Discord invite URL',
    DISCORD_SCORE_POSTS_ENABLED: 'Post top scores to Discord',
    DISCORD_SCORE_POSTS_TOP_N: 'Top-score posts cutoff',
    CHAT_RESPONSES_ENABLED: 'Arcaid chat responses',
    CHAT_RESPONSES_CATEGORIES: 'Chat response categories',
    CHAT_RESPONSES_CHANNEL_IDS: 'Chat response channels',
    CHAT_RESPONSES_COOLDOWN_SEC: 'Chat response cooldown (seconds)',
    // iScored / AtGames
    ISCORED_ENABLED: 'iScored integration',
    ISCORED_ALLOW_DELETE: 'Allow Arcaid to delete games on iScored',
    ISCORED_USERNAME: 'iScored username',
    ISCORED_PASSWORD: 'iScored password',
    ISCORED_PUBLIC_URL: 'iScored public URL',
    ISCORED_API_ENABLED: 'iScored API',
    ISCORED_API_POLL_INTERVAL: 'iScored poll interval (seconds)',
    ATGAMES_ENABLED: 'AtGames score sync',
    ATGAMES_EMAIL: 'AtGames email',
    ATGAMES_PASSWORD: 'AtGames password',
    // Scoreboard look
    SCOREBOARD_MAX_SCORES: 'Scores per card',
    SCOREBOARD_ZOOM: 'Zoom level (%)',
    SCOREBOARD_TITLE: 'Leaderboard title',
    SCOREBOARD_TITLE_STYLE: 'Title style',
    SCOREBOARD_TITLE_SIZE: 'Title size',
    SCOREBOARD_CARD_OPACITY: 'Card transparency',
    SCOREBOARD_LAYOUT: 'Layout mode',
    SCOREBOARD_CARD_SIZE: 'Card size',
    SCOREBOARD_RANKINGS_POSITION: 'Rankings position',
    SCOREBOARD_GAME_COLUMNS: 'Game columns (grid)',
    SCOREBOARD_CARD_LAYOUT: 'Card layout',
    SCOREBOARD_BG_FILL: 'Card background fill (legacy)',
    SCOREBOARD_BG_SIZE: 'Card background sizing',
    SCOREBOARD_WHEEL_SCALE: 'Wheel icon size',
    SCOREBOARD_SCORE_STYLE: 'Score entry style',
    SCOREBOARD_GLASS_OPACITY: 'Glass panel opacity',
    SCOREBOARD_GAME_TITLE_STYLE: 'Game title style',
    SCOREBOARD_SCORE_COLUMNS: 'Score columns',
    SCOREBOARD_QR_MODE: 'QR codes',
    SCOREBOARD_BG_MODE: 'Background mode',
    SCOREBOARD_BG_OPACITY: 'Background opacity',
    SCOREBOARD_MOBILE_VERTICAL: 'Vertical layout on phones',
    SCOREBOARD_LOGO_ENABLED: 'Show logo',
    LOGO_POSITION: 'Logo position',
    LOGO_MAX_HEIGHT: 'Logo max height (px)',
    LEADERBOARD_CARD_ORDER: 'Leaderboard card order',
    // Kiosk
    KIOSK_ENABLED: 'Kiosk mode',
    KIOSK_AUTO_SCROLL: 'Kiosk auto-scroll',
    KIOSK_REFRESH_SECONDS: 'Kiosk auto-refresh (seconds)',
    KIOSK_ZOOM: 'Kiosk zoom (%)',
    // Server (super-admin)
    BOT_TIMEZONE: 'Server timezone',
    DISCORD_BOT_TOKEN: 'Discord bot token',
    DISCORD_CLIENT_ID: 'Discord client ID',
    DISCORD_CLIENT_SECRET: 'Discord client secret',
    GOOGLE_CLIENT_ID: 'Google client ID',
    GOOGLE_CLIENT_SECRET: 'Google client secret',
    OPDB_API_KEY: 'OPDB API key',
    TWITCH_CLIENT_ID: 'Twitch client ID',
    TWITCH_CLIENT_SECRET: 'Twitch client secret',
    RA_API_KEY: 'RetroAchievements API key',
    NOTIFY_HIGH_VALUE_DEFAULT_ON: 'High-value score notifications on by default',
};

export function settingLabel(key: string): string {
    return SETTING_LABELS[key] ?? key;
}

/** Keys whose VALUE never enters the log: the encryption allowlist, plus anything named like a secret. */
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|HASH|PRIVATE|API_KEY/i;
export function isSecretSetting(key: string): boolean {
    return isEncryptedKey(key) || SECRET_NAME.test(key);
}

function clip(v: string): string {
    return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}... (cut)` : v;
}

/**
 * The changed keys of a settings save. `before` is the stored map (plaintext,
 * as `getAll` returns it); `patch` is what the request sent. A mask sentinel
 * means "secret unchanged" and is skipped (the save skips it too). An empty
 * value deletes the row (both settings services), so it compares as unset,
 * except for keys in `emptyIsValue` (the global `SETUP_COMPLETE`).
 */
export function diffSettings(
    before: Record<string, string>,
    patch: Record<string, unknown>,
    opts: { emptyIsValue?: ReadonlySet<string> } = {},
): ActivityChange[] {
    const out: ActivityChange[] = [];
    for (const [key, raw] of Object.entries(patch)) {
        const value = raw == null ? '' : String(raw);
        if (isMask(value)) continue;
        const from = Object.prototype.hasOwnProperty.call(before, key) ? before[key]! : null;
        const to = value === '' && !opts.emptyIsValue?.has(key) ? null : value;
        if ((from ?? null) === (to ?? null)) continue;
        if (isSecretSetting(key)) {
            out.push({ key, label: settingLabel(key), secret: true });
        } else {
            out.push({ key, label: settingLabel(key), from: from == null ? null : clip(from), to: to == null ? null : clip(to) });
        }
    }
    return out;
}

/** Tournament columns as the log names them. Unknown columns show as the column name. */
export const TOURNAMENT_FIELD_LABELS: Record<string, string> = {
    name: 'Name',
    type: 'Type',
    mode: 'Mode',
    format: 'Format',
    'cadence.cron': 'Schedule (cron)',
    'cadence.timezone': 'Timezone',
    'cadence.autoRotate': 'Auto-rotate',
    'cadence.autoLock': 'Auto-lock',
    'cadence.announcementChannel': 'Announcement channel (schedule)',
    platform_rules: 'Platform rules',
    guild_id: 'Discord server',
    discord_channel_id: 'Announcement channel',
    discord_announce_routes: 'Announcement channels by kind',
    discord_role_id: 'Discord role',
    is_active: 'Active',
    display_order: 'Display order',
    max_active_games: 'Max active games',
    cleanup_rule: 'Cleanup rule',
    winner_picks: 'Winner picks next game',
    auto_pick: 'Auto-pick',
    eligibility_days: 'Repeat cooldown (days)',
    winner_pick_window_min: 'Winner pick window (min)',
    runnerup_pick_window_min: 'Runner-up pick window (min)',
    allow_dynasty: 'Same winner may pick again',
    integrity_mode: 'Integrity mode',
    sanctioned_rules: 'Sanctioned play rules',
    max_attempts: 'Attempts per table',
    require_attempt_start: 'Players press Start attempts first',
    witness_flag_mode: 'Flagged Witness scores',
    entry_mode: 'Who may play',
    entry_methods: 'Ways onto the roster',
    season_table_count: 'Season tables',
    poll_picks: 'Pick by poll',
    poll_opens_before_h: 'Poll opens (hours before)',
    poll_closes_before_h: 'Poll closes (hours before)',
    poll_tie_rule: 'Poll tie rule',
    start_date: 'Start',
    end_date: 'End',
    rounds: 'Rounds',
};

/**
 * Columns a tournament diff never shows: identity, bookkeeping, raw user ids,
 * join codes, and runtime state no edit writes.
 */
const TOURNAMENT_SKIP = /^(id|created_at|updated_at|game_room_id|invite_code|throwdown_code|atgames_invite_code|created_by_user_id|rematch_of_tournament_id|atgames_tournament_id)$|_user_id$|_code$|_at$/;

const JSON_COLUMNS = new Set(['platform_rules', 'cleanup_rule', 'sanctioned_rules', 'discord_announce_routes', 'entry_methods']);

function canonical(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return JSON.stringify(sortKeys(v));
    return String(v);
}

function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
            .map(k => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
}

function parseJson(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
}

/** A stored tournament row, flattened for the diff (cadence split into its fields). */
function flattenTournament(row: Record<string, unknown>): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const [k, v] of Object.entries(row)) {
        if (TOURNAMENT_SKIP.test(k)) continue;
        if (k === 'cadence') {
            const c = parseJson(v);
            if (c && typeof c === 'object' && !Array.isArray(c)) {
                for (const [ck, cv] of Object.entries(c as Record<string, unknown>)) out.set(`cadence.${ck}`, canonical(cv));
            }
            continue;
        }
        out.set(k, canonical(JSON_COLUMNS.has(k) ? parseJson(v) : v));
    }
    return out;
}

/**
 * The changed fields of a tournament edit: `before`/`after` are the stored
 * rows (`SELECT *`) read around the update, optionally carrying `rounds` (an
 * event's rounds as readable text). Only fields that differ are returned.
 */
export function diffTournament(before: Record<string, unknown>, after: Record<string, unknown>): ActivityChange[] {
    const a = flattenTournament(before);
    const b = flattenTournament(after);
    const keys = new Set([...a.keys(), ...b.keys()]);
    const out: ActivityChange[] = [];
    for (const key of keys) {
        const from = a.get(key) ?? null;
        const to = b.get(key) ?? null;
        if (from === to) continue;
        out.push({
            key, label: TOURNAMENT_FIELD_LABELS[key] ?? key,
            from: from == null ? null : clip(from), to: to == null ? null : clip(to),
        });
    }
    return out;
}

/** "Announcement channel, Timezone" / "A, B, C and 4 more". */
export function changeLabelList(labels: string[], max = 4): string {
    if (labels.length <= max) return labels.join(', ');
    return `${labels.slice(0, max).join(', ')} and ${labels.length - max} more`;
}

/** "changed 2 settings: Announcement channel, Timezone" (lower-case verb phrase). */
export function describeChanges(changes: Array<{ label: string }>, noun: string): string {
    const n = changes.length;
    return `changed ${n} ${noun}${n === 1 ? '' : 's'}: ${changeLabelList(changes.map(c => c.label))}`;
}

/**
 * A tournament as `diffTournament` compares it: the stored row plus, for an
 * event, its rounds as readable text (one line per round, UTC). Null when the
 * tournament does not exist.
 */
export async function tournamentSnapshotForDiff(tournamentId: string): Promise<Record<string, unknown> | null> {
    const { getDatabase } = await import('../database/database.js');
    const db = await getDatabase();
    const row = await db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
    if (!row) return null;
    if (row.format === 'event') {
        const rounds = await db.all<Array<{ round_no: number; name: string; scheduled_start_at: string | null; scheduled_end_at: string | null }>>(
            `SELECT round_no, name, scheduled_start_at, scheduled_end_at FROM games
              WHERE tournament_id = ? AND round_no IS NOT NULL ORDER BY round_no ASC`,
            tournamentId,
        );
        row.rounds = rounds.length === 0 ? null : rounds
            .map(r => `Round ${r.round_no}: ${r.name}, ${r.scheduled_start_at ?? '?'} -> ${r.scheduled_end_at ?? '?'} UTC`)
            .join('\n');
    }
    return row;
}
