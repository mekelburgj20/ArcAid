/**
 * Arcaid Chat Responses — the bot's automatic replies to ordinary chat.
 *
 * NAMING: the feature is called "Arcaid Chat Responses" everywhere a human can
 * read it (v2.125.0). The internal identifiers stay `callout*` — the table,
 * the service, the API paths, the settings the DB already holds. Renaming
 * those would be a migration with no user-visible benefit; renaming the COPY
 * was the point. "Game callouts" survives as one CATEGORY label.
 *
 * This module is the PURE half: matching + shape validation, no DB, no disk,
 * no discord.js. `CalloutService` owns storage/caching and
 * `src/discord/callouts.ts` owns the per-room gate; both import from here so
 * the matching rules exist in exactly one place.
 *
 * Historical note: pre-v2.123.0 the whole feature lived inline in
 * `DiscordClient`'s MessageCreate handler, which re-read and re-parsed
 * `data/callouts.json` from disk on EVERY message in every guild the bot
 * could see, behind a single global `ENABLE_CALLOUTS` env switch.
 */

/**
 * Built-in responders that answer with LIVE data instead of a fixed string.
 * An entry names one of these in `action`; the reply is rendered at message
 * time by `src/discord/calloutActions.ts` against the rooms that opted in.
 *
 * Adding one means touching: this union, `CALLOUT_ACTIONS`, the renderer's
 * switch, and the FE mirror in `admin-ui/src/lib/callouts.ts`.
 */
export type CalloutAction =
    | 'active_games' | 'picks_link' | 'scores_link' | 'how_to_submit'
    | 'time_left' | 'leaders' | 'my_rank' | 'pick_status' | 'tournament_rules'
    | 'how_to_claim';

export const CALLOUT_ACTIONS: readonly CalloutAction[] = [
    'active_games', 'picks_link', 'scores_link', 'how_to_submit',
    'time_left', 'leaders', 'my_rank', 'pick_status', 'tournament_rules',
    'how_to_claim',
];

export function isCalloutAction(value: unknown): value is CalloutAction {
    return typeof value === 'string' && (CALLOUT_ACTIONS as readonly string[]).includes(value);
}

/**
 * What KIND of reply an entry is. Rooms enable categories individually
 * (v2.125.0), so a server that wants the bot to answer questions but never
 * crack a joke turns `banter` off and keeps `help` on.
 *
 *   help         — live answers and how-tos. The useful stuff; never rate
 *                  limited (see the cooldown in `src/discord/callouts.ts`).
 *   callouts     — the classic game/table callouts ("Troll! In the pantry!").
 *   banter       — replies about the bot itself.
 *   easter_eggs  — the deliberately obscure ones.
 */
export type CalloutCategory = 'help' | 'callouts' | 'banter' | 'easter_eggs';

export const CALLOUT_CATEGORIES: readonly CalloutCategory[] = [
    'help', 'callouts', 'banter', 'easter_eggs',
];

/** The category an entry lands in when it says nothing and nothing is inferred. */
export const DEFAULT_CALLOUT_CATEGORY: CalloutCategory = 'callouts';

/**
 * The categories a room gets when its master switch is turned on and it has
 * never chosen. The two that are useful-or-harmless; the room opts INTO being
 * joked at.
 */
export const DEFAULT_ENABLED_CATEGORIES: readonly CalloutCategory[] = ['help', 'callouts'];

export function isCalloutCategory(value: unknown): value is CalloutCategory {
    return typeof value === 'string' && (CALLOUT_CATEGORIES as readonly string[]).includes(value);
}

/** Trigger words that mark an entry as being ABOUT the bot rather than a game. */
const BANTER_TRIGGER_WORDS = ['bot', 'arcaid'];
/** The historical in-jokes, named explicitly because nothing else identifies them. */
const EASTER_EGG_TRIGGERS = ['seafood', 'dork cow', 'secret cow'];

/**
 * The ONE inference rule for an entry with no explicit category — shared by
 * migration 156's backfill and by an upload that omits the field, so a
 * re-uploaded legacy file lands exactly where the migration put it.
 *
 * Order is significant and matches the owner's spec: a live-data action is
 * `help` no matter what it is triggered by; then bot-directed banter; then the
 * named Easter eggs; everything else is an ordinary game callout.
 */
export function deriveCalloutCategory(entry: {
    triggers?: unknown; action?: unknown;
}): CalloutCategory {
    if (isCalloutAction(entry.action)) return 'help';
    const triggers = (Array.isArray(entry.triggers) ? entry.triggers : [])
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.toLowerCase());
    if (triggers.some(t => BANTER_TRIGGER_WORDS.some(w => t.includes(w)))) return 'banter';
    if (triggers.some(t => EASTER_EGG_TRIGGERS.some(w => t.includes(w)))) return 'easter_eggs';
    return DEFAULT_CALLOUT_CATEGORY;
}

/** An entry's effective category: what it says, else what we infer. */
export function calloutCategoryOf(entry: CalloutEntry): CalloutCategory {
    return isCalloutCategory(entry.category) ? entry.category : deriveCalloutCategory(entry);
}

/**
 * Narrows a list to the categories a room has enabled. Applied BEFORE matching
 * (never after) so a `banter` trigger can't win first-match and silence the
 * `callouts` entry sitting behind it in a room with banter switched off.
 */
export function filterByCategories(
    entries: CalloutEntry[],
    allowed: ReadonlySet<CalloutCategory>,
): CalloutEntry[] {
    return entries.filter(e => allowed.has(calloutCategoryOf(e)));
}

/** Shape of one callout as it appears in the uploaded/exported JSON. */
export interface CalloutEntry {
    /** DB id — absent for entries that came straight off an upload. */
    id?: number;
    /**
     * Words/phrases that fire this entry. A leading `!` marks an EXCLUSION:
     * if any exclusion matches the message, the entry is skipped even when an
     * inclusion trigger matched. Matching is whole-word and case-insensitive
     * on both sides.
     */
    triggers: string[];
    /**
     * One is picked at random when the entry fires. Optional ONLY when
     * `action` is set — an entry must be able to produce a reply somehow.
     * May contain the `{room_name}` / `{room_url}` / `{picks_url}` /
     * `{scores_url}` placeholders, substituted at reply time.
     */
    responses?: string[];
    /**
     * Live-data responder. When set it WINS over `responses` — the whole point
     * of an action entry is that a fixed string cannot answer the question.
     */
    action?: CalloutAction;
    /**
     * Which room-toggleable bucket this entry belongs to (v2.125.0). Absent on
     * an upload means "infer it" — see `deriveCalloutCategory`, the same rule
     * migration 156 used to backfill the existing rows.
     */
    category?: CalloutCategory;
    /** Absent === enabled. Disabled entries are skipped by `matchCallout`. */
    enabled?: boolean;
}

/** Upload limits — enforced by `validateCalloutEntries`, mirrored in the FE. */
export const MAX_CALLOUT_ENTRIES = 500;
export const MAX_RESPONSE_LENGTH = 2000;
export const MAX_TRIGGER_LENGTH = 200;

/** Escapes regex metacharacters so triggers like `ac/dc` or `t2` are literal. */
export function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Folds the typographic apostrophes/quotes that phones and Discord insert
 * automatically down to their ASCII forms, so a trigger written
 * `what's the table` still matches a message that arrived with a curly
 * apostrophe. Applied to BOTH sides, so a curly-typed trigger works too.
 */
export function normalizeCalloutText(value: string): string {
    return value.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Whole-word, case-insensitive containment test for one trigger. */
function triggerMatches(trigger: string, content: string): boolean {
    if (!trigger) return false;
    return new RegExp(`\\b${escapeRegexLiteral(normalizeCalloutText(trigger))}\\b`, 'i')
        .test(normalizeCalloutText(content));
}

/**
 * First entry whose inclusion triggers match `content` and whose exclusion
 * triggers do not. Disabled entries are skipped. Order is significant —
 * first match wins, exactly as the file-backed loop did.
 *
 * ONE deliberate behavioural change from the pre-v2.123.0 inline loop: the
 * exclusion test is now case-INSENSITIVE. The old code lowercased the content
 * for inclusions but tested exclusions against the raw message with no `i`
 * flag, so `!got` failed to suppress "Got". The shipped `data/callouts.json`
 * documents the bug by listing BOTH `!got` and `!Got` on the Game of Thrones
 * entry; that duplication is now redundant (and harmless).
 */
export function findCalloutEntry(content: string, entries: CalloutEntry[]): CalloutEntry | null {
    for (const entry of entries) {
        if (entry.enabled === false) continue;
        if (!Array.isArray(entry.triggers)) continue;
        // An entry must be able to produce a reply: a live-data action, or at
        // least one static response.
        const hasResponses = Array.isArray(entry.responses) && entry.responses.length > 0;
        if (!isCalloutAction(entry.action) && !hasResponses) continue;

        const inclusions = entry.triggers.filter(t => typeof t === 'string' && !t.startsWith('!'));
        const exclusions = entry.triggers
            .filter(t => typeof t === 'string' && t.startsWith('!'))
            .map(t => t.slice(1));

        if (!inclusions.some(t => triggerMatches(t, content))) continue;
        if (exclusions.some(t => triggerMatches(t, content))) continue;
        return entry;
    }
    return null;
}

/**
 * `findCalloutEntry` plus the random response pick. `rng` is injectable so
 * tests can pin the choice; production passes nothing.
 */
export function matchCallout(
    content: string,
    entries: CalloutEntry[],
    rng: () => number = Math.random,
): { entry: CalloutEntry; response: string | null } | null {
    const entry = findCalloutEntry(content, entries);
    if (!entry) return null;
    const responses = entry.responses ?? [];
    if (responses.length === 0) {
        // Action-only entry — `response` is null and the caller renders it.
        return { entry, response: null };
    }
    const idx = Math.min(responses.length - 1, Math.floor(rng() * responses.length));
    const response = responses[idx] ?? responses[0];
    if (response === undefined) return null;
    return { entry, response };
}

/**
 * Room facts a `{placeholder}` can reference. Resolved from the FIRST room in
 * the guild's scope — a Discord server linked to several rooms gets that
 * room's links. Documented behaviour rather than a guess at which room the
 * asker meant.
 */
export interface CalloutRoomContext {
    roomName: string;
    roomUrl: string;
    picksUrl: string;
    scoresUrl: string;
}

/**
 * Substitutes `{room_name}`, `{room_url}`, `{picks_url}` and `{scores_url}`.
 * Unknown braces are left verbatim — a response is free text, and silently
 * eating `{like this}` would be worse than printing it.
 */
export function applyCalloutPlaceholders(text: string, room: CalloutRoomContext | null): string {
    if (!room) return text;
    return text
        .split('{room_name}').join(room.roomName)
        .split('{room_url}').join(room.roomUrl)
        .split('{picks_url}').join(room.picksUrl)
        .split('{scores_url}').join(room.scoresUrl);
}

/** Successful validation result — entries normalized (trimmed, deduped-free). */
export interface CalloutValidationOk { entries: CalloutEntry[] }
/** Failure — `error` names the offending index, e.g. `entry 3: ...`. */
export interface CalloutValidationErr { error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates + normalizes an uploaded callout list.
 *
 * Rules: an array of at most `MAX_CALLOUT_ENTRIES`; every entry needs a
 * non-empty `triggers` array with at least one INCLUSION trigger (an
 * exclusion-only entry can never fire, so it is a silent no-op and rejected),
 * and a way to REPLY — either a non-empty `responses` array or a recognised
 * `action`. Only strings are allowed in both arrays. Strings are trimmed;
 * `enabled` defaults to true; `category` is optional and defaults through
 * `deriveCalloutCategory` (the migration-156 rule), never to a bare constant.
 *
 * Errors are single-string and index-named on purpose — both the API 400 and
 * the FE upload preview show the FIRST problem with its position.
 */
export function validateCalloutEntries(input: unknown): CalloutValidationOk | CalloutValidationErr {
    if (!Array.isArray(input)) return { error: 'Expected a JSON array of callout entries' };
    if (input.length > MAX_CALLOUT_ENTRIES) {
        return { error: `Too many entries: ${input.length} (max ${MAX_CALLOUT_ENTRIES})` };
    }

    const out: CalloutEntry[] = [];
    for (let i = 0; i < input.length; i++) {
        const raw = input[i];
        const where = `entry ${i}`;
        if (!isPlainObject(raw)) return { error: `${where}: must be an object` };

        const { triggers, responses, enabled, action, category } = raw as {
            triggers?: unknown; responses?: unknown; enabled?: unknown; action?: unknown;
            category?: unknown;
        };

        if (!Array.isArray(triggers) || triggers.length === 0) {
            return { error: `${where}: triggers must be a non-empty array` };
        }
        const cleanTriggers: string[] = [];
        for (let t = 0; t < triggers.length; t++) {
            const value = triggers[t];
            if (typeof value !== 'string') return { error: `${where}: trigger ${t} must be a string` };
            const trimmed = value.trim();
            if (!trimmed) return { error: `${where}: trigger ${t} is empty` };
            if (trimmed.length > MAX_TRIGGER_LENGTH) {
                return { error: `${where}: trigger ${t} exceeds ${MAX_TRIGGER_LENGTH} characters` };
            }
            if (trimmed === '!') return { error: `${where}: trigger ${t} is an empty exclusion` };
            cleanTriggers.push(trimmed);
        }
        if (!cleanTriggers.some(t => !t.startsWith('!'))) {
            return { error: `${where}: needs at least one trigger that is not an exclusion` };
        }

        if (action !== undefined && !isCalloutAction(action)) {
            return { error: `${where}: action must be one of ${CALLOUT_ACTIONS.join(', ')}` };
        }
        const hasAction = isCalloutAction(action);

        // Category is OPTIONAL on upload and resolved through the same
        // inference migration 156 used, so a legacy file re-uploaded after the
        // migration lands each entry back in the bucket it was backfilled into
        // rather than dumping everything into the default.
        if (category !== undefined && !isCalloutCategory(category)) {
            return { error: `${where}: category must be one of ${CALLOUT_CATEGORIES.join(', ')}` };
        }
        const cleanCategory: CalloutCategory = isCalloutCategory(category)
            ? category
            : deriveCalloutCategory({ triggers: cleanTriggers, action });

        // Responses are required UNLESS the entry answers with live data.
        if (responses === undefined && hasAction) {
            const actionEntry: CalloutEntry = {
                triggers: cleanTriggers, action: action as CalloutAction, category: cleanCategory,
            };
            if (enabled !== undefined && typeof enabled !== 'boolean') {
                return { error: `${where}: enabled must be a boolean` };
            }
            if (enabled === false) actionEntry.enabled = false;
            out.push(actionEntry);
            continue;
        }
        if (!Array.isArray(responses) || responses.length === 0) {
            return {
                error: hasAction
                    ? `${where}: responses must be a non-empty array (omit it entirely to use the action alone)`
                    : `${where}: responses must be a non-empty array`,
            };
        }
        const cleanResponses: string[] = [];
        for (let r = 0; r < responses.length; r++) {
            const value = responses[r];
            if (typeof value !== 'string') return { error: `${where}: response ${r} must be a string` };
            const trimmed = value.trim();
            if (!trimmed) return { error: `${where}: response ${r} is empty` };
            if (trimmed.length > MAX_RESPONSE_LENGTH) {
                return { error: `${where}: response ${r} exceeds ${MAX_RESPONSE_LENGTH} characters` };
            }
            cleanResponses.push(trimmed);
        }

        if (enabled !== undefined && typeof enabled !== 'boolean') {
            return { error: `${where}: enabled must be a boolean` };
        }

        const entry: CalloutEntry = { triggers: cleanTriggers, responses: cleanResponses };
        if (hasAction) entry.action = action as CalloutAction;
        entry.category = cleanCategory;
        if (enabled === false) entry.enabled = false;
        out.push(entry);
    }

    return { entries: out };
}
