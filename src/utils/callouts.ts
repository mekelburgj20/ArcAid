/**
 * Callouts — the Easter-egg bot replies.
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
export type CalloutAction = 'active_games' | 'picks_link' | 'scores_link' | 'how_to_submit';

export const CALLOUT_ACTIONS: readonly CalloutAction[] = [
    'active_games', 'picks_link', 'scores_link', 'how_to_submit',
];

export function isCalloutAction(value: unknown): value is CalloutAction {
    return typeof value === 'string' && (CALLOUT_ACTIONS as readonly string[]).includes(value);
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
 * `enabled` defaults to true.
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

        const { triggers, responses, enabled, action } = raw as {
            triggers?: unknown; responses?: unknown; enabled?: unknown; action?: unknown;
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

        // Responses are required UNLESS the entry answers with live data.
        if (responses === undefined && hasAction) {
            const actionEntry: CalloutEntry = { triggers: cleanTriggers, action: action as CalloutAction };
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
        if (enabled === false) entry.enabled = false;
        out.push(entry);
    }

    return { entries: out };
}
