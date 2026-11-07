import { changeLabelList, settingLabel, type ActivityChange } from './activityDiff.js';

/**
 * G15 (v2.228.0, ADR 0037 §10 amendment) - how an activity row reads.
 *
 *  - `adminSummary`: a readable sentence for an admin row ("GamerDad89 changed
 *    2 settings: Announcement channel, Timezone") instead of a raw action name.
 *    Applied at READ time, so rows written before v2.228.0 (the backfill's
 *    "Admin action: room.settings_update", the middleware's "Admin ran
 *    tournaments/:id") read the same way.
 *  - `buildActivityDetail`: the curated details panel, a per-type ALLOWLIST of
 *    fields. It is what a room admin sees; it never carries an IP, a token, a
 *    hash, a raw user or device id, or anything about a play routed elsewhere
 *    (those rows are not in the room's log at all, ADR 0037 §5). Only the
 *    super-admin also gets the raw `details` JSON.
 */

export interface ActivityFact {
    label: string;
    value: string;
    /** `value` is a SQLite UTC stamp; the UI shows it in the row's timezone. */
    time?: true;
}

export interface ActivityDetail {
    facts: ActivityFact[];
    /** An admin edit's changed keys (v2.228.0+). */
    changes?: ActivityChange[];
    /** Setting names recorded before values were (pre-v2.228.0 rows). */
    recordedKeys?: string[];
    notes?: string[];
}

/** The version that started recording values; named in the past-row note. */
export const DIFF_SINCE_VERSION = 'v2.228.0';

const SOURCE_LABEL: Record<string, string> = {
    tournament: 'Typed on the web',
    community: 'Typed on the web (community)',
    sync: 'iScored sync',
    atgames: 'AtGames',
    vpx: 'Witness / Castcade',
    discord: 'Discord /submit-score',
};

const WITNESS_OUTCOME: Record<string, string> = {
    ingested: 'Landed',
    attempt_refused: 'Refused by Limited attempts',
    not_sanctioned: 'Refused by Sanctioned play',
    suppressed: 'Ignored (the player deleted this play)',
    global: 'Went to the Global Scoreboard',
    no_match: 'Matched no open game',
    invalid: 'Invalid',
};

/** Audit action names (the backfilled "Admin action: x" rows) as verb phrases. */
const AUDIT_ACTION_PHRASE: Record<string, string> = {
    'room.settings_update': 'changed room settings',
    'settings.update': 'changed server settings',
    'room.ban': 'banned a player from the room',
    'room.unban': 'lifted a room ban',
    'room.delete': 'deleted a room',
    'room.suspend': 'suspended a room',
    'room.unsuspend': 'unsuspended a room',
    'tournament.delete': 'deleted a tournament',
    'tournament.event_reverify': 're-checked an event\'s scores',
    'tournament.atgames_create': 'created an AtGames tournament',
    'tournament.atgames_sync': 'synced an AtGames tournament',
    'season.poll_create': 'created a pick poll',
    'season.poll_update': 'edited a pick poll',
    'season.poll_close': 'closed a pick poll',
    'season.poll_cancel': 'cancelled a pick poll',
    'season.poll_repost': 'reposted a pick poll',
    'season.poll_reorder': 'reordered a pick poll',
    'season.poll_choose': 'chose a pick poll winner',
    'season.pause': 'paused a season',
    'season.resume': 'resumed a season',
    'roster.add': 'added a player to a roster',
    'roster.remove': 'removed a player from a roster',
    'roster.invite_reset': 'reset a roster invite link',
    'roster.request_approve': 'approved a roster request',
    'roster.request_deny': 'denied a roster request',
    'pick.queue_on_behalf': 'queued a pick for a player',
    'pick.queue_remove_on_behalf': 'removed a queued pick for a player',
    'pick_disposition.set': 'set a pick disposition',
    'pick_disposition.clear': 'cleared a pick disposition',
    'pick_disposition.designate': 'designated a picker',
    'game.deactivate': 'deactivated a game',
    'game.delete': 'deleted a game',
    'game.remove': 'removed a game from the leaderboard',
    'game_state.iscored_recreate': 're-created a game on iScored',
    'score.correct': 'corrected a score',
    'score.delete': 'deleted a score',
    'score_verified': 'verified a score',
    'score_unverified': 'removed a score verification',
    'scores_bulk_imported': 'imported scores from CSV',
    'submission.wipe': 'removed a player\'s scores from a game',
    'submission.unsuppress': 'cleared a deleted-score tombstone',
    'attempt.void': 'voided an attempt',
    'attempt.reinstate': 'reinstated an attempt',
    'identity.merge': 'merged player identities',
    'identity.reverse': 'reversed an identity merge',
    'identity.atgames_link': 'linked an AtGames account',
    'identity.atgames_unlink': 'unlinked an AtGames account',
    'identity_claim.approved': 'approved a name claim',
    'identity_claim.rejected': 'rejected a name claim',
    'identity_claim.released': 'released a name claim',
    'player.merge': 'merged two players',
    'admin.discord_add': 'added a room admin (Discord)',
    'admin.discord_remove': 'removed a room admin (Discord)',
    'admin.local_add': 'added a room admin (password)',
    'admin.local_remove': 'removed a room admin (password)',
    'admin.local_reset_password': 'reset a room admin password',
    'leaderboard.card_order_set': 'changed the leaderboard card order',
    'leaderboard.card_order_clear': 'reset the leaderboard card order',
    'style_profile.apply': 'applied a style profile',
    'comment.delete': 'deleted a comment',
    'comment_report.dismiss': 'dismissed a comment report',
    'comment_report.remove': 'removed a reported comment',
    'content_report.dismiss': 'dismissed a content report',
    'content_report.resolve': 'resolved a content report',
    'score_report.ban': 'banned a player over a score report',
    'score_report.dismiss': 'dismissed a score report',
    'score_report.hard_delete': 'deleted a reported score',
    'score_report.soft_delete': 'hid a reported score',
    'user.ban': 'banned a user',
    'user.unban': 'lifted a user ban',
    'user.display_name_override': 'overrode a display name',
    'witness_target_change': 'changed a Witness device\'s target',
    'backup.config_update': 'changed backup settings',
    'backup.delete': 'deleted a backup',
    'backup.restore': 'restored a backup',
    'catalogue.merge': 'merged catalogue games',
    'catalogue.delete': 'deleted a catalogue game',
    'global_score.restore': 'restored a Global score',
    'global_score.hard_delete': 'deleted a Global score',
    'global_score.soft_delete': 'hid a Global score',
    'superadmin.add': 'added a super-admin',
    'superadmin.remove': 'removed a super-admin',
    'signing_key.add': 'added a signing key',
    'signing_key.retire': 'retired a signing key',
    'account.delete': 'deleted an account',
};

/** A raw action name made readable: "season.poll_cancel" -> "season: poll cancel". */
function cleanActionName(action: string): string {
    return action.replace(/^(GET|POST|PUT|PATCH|DELETE) \/api\//, '').replace(/[._/-]+/g, ' ').trim();
}

/**
 * The admin middleware's generic rows ("Admin ran <path>"), by method + path
 * label (`adminPathLabel`: ids are `:id`). First match wins.
 */
const PATH_PHRASES: Array<[string, RegExp, string]> = [
    ['POST', /^tournaments$/, 'created a tournament'],
    ['PUT', /^tournaments\/:id$/, 'edited a tournament'],
    ['DELETE', /^tournaments\/:id$/, 'deleted a tournament'],
    ['PATCH', /^tournaments\/:id\/active$/, 'paused or resumed a tournament'],
    ['POST', /^tournaments\/:id\/activate-game$/, 'activated a game'],
    ['POST', /^tournaments\/reorder-lineup$/, 'reordered the lineup'],
    ['POST', /^tournaments\/:id\/season\/polls$/, 'created a pick poll'],
    ['PUT', /^tournaments\/:id\/season\/polls\/:id$/, 'edited a pick poll'],
    ['POST', /^tournaments\/:id\/season\/polls\/:id\/close$/, 'closed a pick poll'],
    ['POST', /^tournaments\/:id\/season\/polls\/:id\/cancel$/, 'cancelled a pick poll'],
    ['POST', /^tournaments\/:id\/season\/polls\/:id\/repost$/, 'reposted a pick poll'],
    ['POST', /^tournaments\/:id\/season\/polls\/:id\/reorder$/, 'reordered a pick poll'],
    ['POST', /^tournaments\/:id\/season\/polls\/:id\/choose$/, 'chose a pick poll winner'],
    ['POST', /^tournaments\/:id\/season\/pause$/, 'paused a season'],
    ['POST', /^tournaments\/:id\/season\/resume$/, 'resumed a season'],
    ['*', /^tournaments\/:id\/pick-disposition/, 'changed a pick disposition'],
    ['*', /^tournaments\/:id\/queue/, 'changed a pick queue'],
    ['*', /^tournaments\/:id\/atgames/, 'changed an AtGames link'],
    ['POST', /^tournaments\/:id\/reverify$/, 're-checked an event\'s scores'],
    ['POST', /^events\/:id\/participants$/, 'added an event participant'],
    ['DELETE', /^events\/:id\/participants/, 'removed an event participant'],
    ['POST', /^events\/:id\/rounds\/:id\/start-now$/, 'started an event round early'],
    ['POST', /^events\/:id\/rounds\/:id\/end-now$/, 'ended an event round early'],
    ['POST', /^games\/pin$/, 'pinned a game to the scoreboard'],
    ['DELETE', /^games\/pinned\//, 'unpinned a game'],
    ['POST', /^games\/:id\/deactivate$/, 'deactivated a game'],
    ['DELETE', /^games\/:id$/, 'deleted a game'],
    ['*', /^games\/.*tags?/, 'changed game tags'],
    ['*', /^game-states\/:id\/status$/, 'changed a game\'s status'],
    ['*', /^game-states\/:id\/clear-picker$/, 'cleared a game\'s picker'],
    ['*', /^game-states\/force-maintenance$/, 'forced maintenance'],
    ['*', /^game-states\/iscored-reconcile$/, 'reconciled with iScored'],
    ['*', /^game-states\/:id\/sync-iscored$/, 'synced a game with iScored'],
    ['DELETE', /^game-states\/:id$/, 'deleted a game'],
    ['*', /^games\/:id\/(style|image|framing|notes|display-name)/, 'changed a game\'s look or notes'],
    ['DELETE', /^games\/:id\/submissions\//, 'removed a player\'s scores from a game'],
    ['DELETE', /^games\/:id\/suppressions\//, 'cleared a deleted-score tombstone'],
    ['DELETE', /^games\/:id$/, 'removed a game'],
    ['POST', /^lobby\/announcements$/, 'posted a lobby announcement'],
    ['PUT', /^lobby\/announcements\//, 'edited a lobby announcement'],
    ['DELETE', /^lobby\/announcements\//, 'deleted a lobby announcement'],
    ['*', /^lobby\/(shelf|shelf-reorder)/, 'changed the lobby shelf'],
    ['*', /^lobby\/config$/, 'changed the lobby settings'],
    ['*', /^lobby\/feed$/, 'posted to the lobby feed'],
    ['POST', /^ranking-groups$/, 'created a ranking group'],
    ['DELETE', /^ranking-groups\//, 'deleted a ranking group'],
    ['*', /^ranking-groups\//, 'changed a ranking group'],
    ['*', /^score-history\/:id\/verify$/, 'verified a score'],
    ['*', /^score-history\/:id\/unverify$/, 'removed a score verification'],
    ['*', /^scores\/import-csv-commit$/, 'imported scores from CSV'],
    ['*', /^scores\/import-csv-preview$/, 'previewed a score CSV import'],
    ['*', /^game_library/, 'changed the game library'],
    ['POST', /^admins\/(discord|local)$/, 'added a room admin'],
    ['DELETE', /^admins\/(discord|local)\//, 'removed a room admin'],
    ['*', /^admins\/local\/:id\/reset-password$/, 'reset a room admin password'],
    ['*', /^admins\/invites/, 'changed admin invites'],
    ['*', /^scheduler\/reload$/, 'reloaded the scheduler'],
    ['*', /^iscored\/validate$/, 'checked the iScored login'],
    ['POST', /^bans$/, 'banned a player from the room'],
    ['*', /^bans\/:id\/lift$/, 'lifted a room ban'],
    ['*', /^join-requests\/:id\/approve$/, 'approved a join request'],
    ['*', /^join-requests\/:id\/deny$/, 'denied a join request'],
    ['*', /^identity\/merge$/, 'merged player identities'],
    ['*', /^identity\/preview$/, 'previewed an identity merge'],
    ['*', /^identity\/:id\/reverse$/, 'reversed an identity merge'],
    ['*', /^identity-claims\/:id\/approve$/, 'approved a name claim'],
    ['*', /^identity-claims\/:id\/reject$/, 'rejected a name claim'],
    ['*', /^merge-player$/, 'merged two players'],
    ['*', /^upload\/logo$/, 'changed the room logo'],
    ['*', /^upload\/background$/, 'changed the room background'],
    ['*', /^(style-profiles|styles)/, 'changed a style profile'],
    ['*', /^leaderboard\/card-order$/, 'changed the leaderboard card order'],
];

const METHOD_VERB: Record<string, string> = { POST: 'updated', PUT: 'changed', PATCH: 'changed', DELETE: 'deleted' };

function pathPhrase(method: string, path: string): string {
    for (const [m, re, phrase] of PATH_PHRASES) {
        if ((m === '*' || m === method) && re.test(path)) return phrase;
    }
    const cleaned = path.split('/').filter(p => p && p !== ':id').join(' ').replace(/[-_]+/g, ' ');
    return `${METHOD_VERB[method] ?? 'changed'} ${cleaned || 'something'}`;
}

/** A row as the presenter needs it. */
export interface PresentableRow {
    category: string;
    event_type: string;
    summary: string;
    game_room_id: string | null;
    tournament_name: string | null;
    game_name: string | null;
    table_name: string | null;
    source: string | null;
    score: number | null;
    device_id: string | null;
    device_model: string | null;
}

function keysList(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function changesList(v: unknown): ActivityChange[] | null {
    if (!Array.isArray(v)) return null;
    const out: ActivityChange[] = [];
    for (const c of v) {
        if (!c || typeof c !== 'object') continue;
        const o = c as Record<string, unknown>;
        if (typeof o.key !== 'string') continue;
        const label = typeof o.label === 'string' ? o.label : o.key;
        if (o.secret === true) out.push({ key: o.key, label, secret: true });
        else {
            out.push({
                key: o.key, label,
                from: typeof o.from === 'string' ? o.from : null,
                to: typeof o.to === 'string' ? o.to : null,
            });
        }
    }
    return out;
}

/** The audit action a backfilled row names ("Admin action: x"), or null. */
export function auditActionOf(summary: string): string | null {
    const m = /^Admin action: (.+)$/.exec(summary || '');
    return m ? m[1]!.trim() : null;
}

/**
 * The readable summary for an admin row (actor first), or `null` to keep the
 * stored one. `auditKeys`: the setting keys the audit row recorded, for a
 * backfilled settings row.
 */
export function adminSummary(
    row: PresentableRow, details: Record<string, unknown> | null, actor: string | null, auditKeys: string[] | null,
): string | null {
    if (row.category !== 'admin') return null;
    const who = actor ? actor.charAt(0).toUpperCase() + actor.slice(1) : 'An admin';
    const server = !row.game_room_id;
    const settingsNoun = server ? 'server setting' : 'setting';
    const keysPhrase = (keys: string[]) => keys.length > 0
        ? `saved ${keys.length} ${settingsNoun}${keys.length === 1 ? '' : 's'}: ${changeLabelList(keys.map(settingLabel))}`
        : `saved ${settingsNoun}s`;

    const changes = changesList(details?.changes);
    if (changes && changes.length > 0) {
        const n = changes.length;
        const noun = row.event_type === 'tournament_updated' ? 'tournament setting' : settingsNoun;
        const where = row.event_type === 'tournament_updated' && row.tournament_name ? ` on ${row.tournament_name}` : '';
        return `${who} changed ${n} ${noun}${n === 1 ? '' : 's'}${where}: ${changeLabelList(changes.map(c => c.label))}`;
    }
    if (row.event_type === 'settings_change') return `${who} ${keysPhrase(keysList(details?.keys))}`;
    if (row.event_type === 'admin_login') return `${who} signed in`;

    if (row.event_type === 'admin_action') {
        const action = auditActionOf(row.summary);
        if (action) {
            if (action === 'room.settings_update' || action === 'settings.update') {
                return `${who} ${keysPhrase(auditKeys ?? [])}`;
            }
            return `${who} ${AUDIT_ACTION_PHRASE[action] ?? `did "${cleanActionName(action)}"`}`;
        }
        const method = typeof details?.method === 'string' ? details.method : '';
        const path = typeof details?.path === 'string' ? details.path : '';
        if (method && path) {
            if (path === 'settings' && method === 'POST') return `${who} ${keysPhrase(keysList(details?.fields))}`;
            return `${who} ${pathPhrase(method, path)}`;
        }
    }
    return null;
}

function fmtInt(n: unknown): string | null {
    return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n).toLocaleString('en-US') : null;
}

/** Any stamp (ISO, SQLite UTC, epoch seconds) as SQLite UTC text, or null. */
function utcStamp(v: unknown): string | null {
    let ms: number;
    if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v;
    else if (typeof v === 'string' && v.trim()) {
        const s = v.trim();
        const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
        ms = Date.parse(iso);
    } else return null;
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function deviceKind(details: Record<string, unknown> | null, row: PresentableRow): string | null {
    const t = details?.deviceType;
    if (!row.device_id && !t) return null;
    return t === 'desktop' ? 'Castcade (PC)' : 'Witness cabinet';
}

/**
 * The curated details panel for one row. Every field is named here; nothing
 * from `details` passes through unnamed.
 */
export function buildActivityDetail(
    row: PresentableRow, details: Record<string, unknown> | null, auditKeys: string[] | null,
): ActivityDetail {
    const facts: ActivityFact[] = [];
    const notes: string[] = [];
    const add = (label: string, value: unknown) => {
        if (value === null || value === undefined || value === '') return;
        facts.push({ label, value: String(value) });
    };
    const addTime = (label: string, value: unknown) => {
        const s = utcStamp(value);
        if (s) facts.push({ label, value: s, time: true });
    };
    const d = details ?? {};
    const gameAndTable = () => {
        add('Game', row.game_name);
        if (row.table_name && row.table_name !== row.game_name) add('Table', row.table_name);
        add('Tournament', row.tournament_name);
    };
    const device = () => {
        add('Device', deviceKind(details, row));
        add('Device model', row.device_model);
    };

    switch (row.category) {
        case 'score': {
            if (row.event_type === 'score_corrected' && typeof d.oldScore === 'number' && typeof d.newScore === 'number') {
                add('Score', `${fmtInt(d.oldScore)} -> ${fmtInt(d.newScore)}`);
            } else {
                add('Score', fmtInt(row.score));
            }
            gameAndTable();
            if (row.event_type.startsWith('witness_')) {
                const outcome = row.event_type.slice('witness_'.length);
                add('Outcome', WITNESS_OUTCOME[outcome] ?? outcome.replace(/_/g, ' '));
            }
            add('Source', row.source ? (SOURCE_LABEL[row.source] ?? row.source) : null);
            add('Platform', typeof d.platform === 'string' ? d.platform : null);
            add('Refused by', typeof d.gate === 'string' ? d.gate.replace(/_/g, ' ') : null);
            add('Code', typeof d.code === 'string' ? d.code : null);
            add('Witness verdict', typeof d.verdict === 'string' ? d.verdict : null);
            add('ROM', typeof d.rom === 'string' ? d.rom : null);
            add('Previous status', typeof d.previousStatus === 'string' ? d.previousStatus : null);
            add('Rows removed', fmtInt(d.historyRowsRemoved));
            addTime('Played at', d.playedAt);
            device();
            break;
        }
        case 'device': {
            device();
            add('Table', row.table_name);
            addTime('Launched', d.launchTs);
            addTime('Exited', d.exitTs);
            if (typeof d.durationSec === 'number' && Number.isFinite(d.durationSec)) {
                add('Played for', `${Math.max(1, Math.round(d.durationSec / 60))} min`);
            }
            add('Reported via', typeof d.via === 'string' ? d.via : null);
            addTime('Last heartbeat', d.lastHeartbeat);
            break;
        }
        case 'bot': {
            add('Command', typeof d.command === 'string' ? `/${d.command}` : null);
            add('Discord channel', typeof d.channelId === 'string' ? d.channelId : null);
            add('Discord error code', typeof d.code === 'string' || typeof d.code === 'number' ? d.code : null);
            break;
        }
        case 'lifecycle': {
            add('Tournament', row.tournament_name);
            add('Game', row.game_name);
            add('Table', row.table_name && row.table_name !== row.game_name ? row.table_name : null);
            add('Ranked players', fmtInt(d.rankedPlayers));
            add('Pick window (min)', fmtInt(d.windowMin));
            add('Picker type', typeof d.pickerType === 'string' ? d.pickerType.replace(/_/g, ' ').toLowerCase() : null);
            add('Previous status', typeof d.previousStatus === 'string' ? d.previousStatus : null);
            break;
        }
        case 'admin': {
            add('Tournament', row.tournament_name);
            add('Game', row.game_name);
            const changes = changesList(d.changes);
            if (changes && changes.length > 0) return { facts, changes, notes };
            const action = auditActionOf(row.summary);
            const recorded = row.event_type === 'settings_change' ? keysList(d.keys)
                : action === 'room.settings_update' || action === 'settings.update' ? (auditKeys ?? [])
                : row.event_type === 'admin_action' && d.path === 'settings' ? keysList(d.fields)
                : [];
            if (recorded.length > 0) {
                notes.push(`Values weren't recorded before ${DIFF_SINCE_VERSION}; only the setting names were.`);
                if (recorded.length > 1) {
                    notes.push('A full Save sends every setting on the page, so this list may include settings that did not change.');
                }
                return { facts, recordedKeys: recorded.map(settingLabel), notes };
            }
            if (row.event_type === 'admin_action') {
                if (action) add('Action', cleanActionName(action));
                const fields = keysList(d.fields);
                if (fields.length > 0) add('Fields sent', fields.join(', '));
                if (action) notes.push(`Copied from the audit log when the activity log started: only the action name was kept.`);
            }
            break;
        }
        case 'server': {
            add('Imported', fmtInt(d.imported));
            add('Updated', fmtInt(d.updated));
            break;
        }
        default:
            break;
    }
    return { facts, ...(notes.length ? { notes } : {}) };
}
