/**
 * Arcaid Chat Responses — FE-side upload parsing/validation.
 *
 * User-facing name is "Arcaid Chat Responses" (v2.125.0); the identifiers stay
 * `callout*` to match the API paths and the DB. See `src/utils/callouts.ts`.
 *
 * Deliberately mirrors `src/utils/callouts.ts`'s `validateCalloutEntries`
 * (same rules, same index-named error strings) so the upload card can show a
 * useful preview BEFORE hitting the network. The server re-validates through
 * the real implementation on PUT — this copy is a convenience, never the
 * authority. If the backend rules change, change them here too.
 */

/**
 * Built-in live-data responders — mirror of `CalloutAction` in
 * `src/utils/callouts.ts`. Adding one means touching both.
 */
export type CalloutAction =
  | 'active_games' | 'picks_link' | 'scores_link' | 'how_to_submit'
  | 'time_left' | 'leaders' | 'my_rank' | 'pick_status' | 'tournament_rules'
  | 'how_to_claim';

export const CALLOUT_ACTIONS: CalloutAction[] = [
  'active_games', 'picks_link', 'scores_link', 'how_to_submit',
  'time_left', 'leaders', 'my_rank', 'pick_status', 'tournament_rules',
  'how_to_claim',
];

/** What each action answers with, for the editor's select + badge tooltip. */
export const CALLOUT_ACTION_LABELS: Record<CalloutAction, string> = {
  active_games: "What's active now (live)",
  picks_link: 'Link to the Picks page',
  scores_link: 'Link to the scoreboard',
  how_to_submit: 'How to submit a score',
  time_left: 'Time left in the round (live)',
  leaders: 'Who leads each active game (live)',
  my_rank: "The asker's own rank (live)",
  pick_status: 'Who owes a pick, and how long they have (live)',
  tournament_rules: 'Platform rules and cooldown (live)',
  how_to_claim: 'How to claim your iScored name',
};

/**
 * Entry categories — mirror of `CalloutCategory` in `src/utils/callouts.ts`.
 * Rooms enable these individually, so the labels here are the same words the
 * room Settings sub-toggles use.
 */
export type CalloutCategory = 'help' | 'callouts' | 'banter' | 'easter_eggs';

export const CALLOUT_CATEGORIES: CalloutCategory[] = [
  'help', 'callouts', 'banter', 'easter_eggs',
];

export const CALLOUT_CATEGORY_LABELS: Record<CalloutCategory, string> = {
  help: 'Helpful answers',
  callouts: 'Game callouts',
  banter: 'Banter',
  easter_eggs: 'Easter eggs',
};

export function isCalloutCategory(value: unknown): value is CalloutCategory {
  return typeof value === 'string' && (CALLOUT_CATEGORIES as string[]).includes(value);
}

/** Mirror of the backend's `deriveCalloutCategory` — same order, same words. */
const BANTER_TRIGGER_WORDS = ['bot', 'arcaid'];
const EASTER_EGG_TRIGGERS = ['seafood', 'dork cow', 'secret cow'];

export function deriveCalloutCategory(entry: {
  triggers?: unknown; action?: unknown;
}): CalloutCategory {
  if (isCalloutAction(entry.action)) return 'help';
  const triggers = (Array.isArray(entry.triggers) ? entry.triggers : [])
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.toLowerCase());
  if (triggers.some(t => BANTER_TRIGGER_WORDS.some(w => t.includes(w)))) return 'banter';
  if (triggers.some(t => EASTER_EGG_TRIGGERS.some(w => t.includes(w)))) return 'easter_eggs';
  return 'callouts';
}

export function isCalloutAction(value: unknown): value is CalloutAction {
  return typeof value === 'string' && (CALLOUT_ACTIONS as string[]).includes(value);
}

export interface CalloutEntry {
  id?: number;
  triggers: string[];
  /** Optional ONLY when `action` is set. */
  responses?: string[];
  /** Live-data responder; wins over `responses` when set. */
  action?: CalloutAction;
  /** Absent on upload means "infer it" — see `deriveCalloutCategory`. */
  category?: CalloutCategory;
  enabled?: boolean;
}

/** A stored callout as `GET /api/admin/callouts` returns it. */
export interface CalloutRow {
  id: number;
  triggers: string[];
  responses: string[];
  action: CalloutAction | null;
  category: CalloutCategory;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CalloutCounts {
  total: number;
  enabled: number;
  disabled: number;
  responses: number;
  /** How many entries answer with live data rather than a fixed string. */
  actions: number;
  /** Per-category totals; every category is present, 0 included. */
  byCategory: Record<CalloutCategory, number>;
}

export const MAX_CALLOUT_ENTRIES = 500;
export const MAX_RESPONSE_LENGTH = 2000;
export const MAX_TRIGGER_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CalloutParseResult =
  | { ok: true; entries: CalloutEntry[]; responseCount: number }
  | { ok: false; error: string };

/** Validates an already-parsed JSON value. */
export function validateCalloutEntries(input: unknown): CalloutParseResult {
  if (!Array.isArray(input)) return { ok: false, error: 'Expected a JSON array of callout entries' };
  if (input.length > MAX_CALLOUT_ENTRIES) {
    return { ok: false, error: `Too many entries: ${input.length} (max ${MAX_CALLOUT_ENTRIES})` };
  }

  const entries: CalloutEntry[] = [];
  let responseCount = 0;

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const where = `entry ${i}`;
    if (!isPlainObject(raw)) return { ok: false, error: `${where}: must be an object` };

    const { triggers, responses, enabled, action, category } = raw as {
      triggers?: unknown; responses?: unknown; enabled?: unknown; action?: unknown;
      category?: unknown;
    };

    if (!Array.isArray(triggers) || triggers.length === 0) {
      return { ok: false, error: `${where}: triggers must be a non-empty array` };
    }
    const cleanTriggers: string[] = [];
    for (let t = 0; t < triggers.length; t++) {
      const value = triggers[t];
      if (typeof value !== 'string') return { ok: false, error: `${where}: trigger ${t} must be a string` };
      const trimmed = value.trim();
      if (!trimmed) return { ok: false, error: `${where}: trigger ${t} is empty` };
      if (trimmed.length > MAX_TRIGGER_LENGTH) {
        return { ok: false, error: `${where}: trigger ${t} exceeds ${MAX_TRIGGER_LENGTH} characters` };
      }
      if (trimmed === '!') return { ok: false, error: `${where}: trigger ${t} is an empty exclusion` };
      cleanTriggers.push(trimmed);
    }
    if (!cleanTriggers.some(t => !t.startsWith('!'))) {
      return { ok: false, error: `${where}: needs at least one trigger that is not an exclusion` };
    }

    if (action !== undefined && !isCalloutAction(action)) {
      return { ok: false, error: `${where}: action must be one of ${CALLOUT_ACTIONS.join(', ')}` };
    }
    const hasAction = isCalloutAction(action);

    if (category !== undefined && !isCalloutCategory(category)) {
      return { ok: false, error: `${where}: category must be one of ${CALLOUT_CATEGORIES.join(', ')}` };
    }
    const cleanCategory: CalloutCategory = isCalloutCategory(category)
      ? category
      : deriveCalloutCategory({ triggers: cleanTriggers, action });

    // Responses are required UNLESS the entry answers with live data.
    if (responses === undefined && hasAction) {
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { ok: false, error: `${where}: enabled must be a boolean` };
      }
      const actionEntry: CalloutEntry = { triggers: cleanTriggers, action, category: cleanCategory };
      if (enabled === false) actionEntry.enabled = false;
      entries.push(actionEntry);
      continue;
    }
    if (!Array.isArray(responses) || responses.length === 0) {
      return {
        ok: false,
        error: hasAction
          ? `${where}: responses must be a non-empty array (omit it entirely to use the action alone)`
          : `${where}: responses must be a non-empty array`,
      };
    }
    const cleanResponses: string[] = [];
    for (let r = 0; r < responses.length; r++) {
      const value = responses[r];
      if (typeof value !== 'string') return { ok: false, error: `${where}: response ${r} must be a string` };
      const trimmed = value.trim();
      if (!trimmed) return { ok: false, error: `${where}: response ${r} is empty` };
      if (trimmed.length > MAX_RESPONSE_LENGTH) {
        return { ok: false, error: `${where}: response ${r} exceeds ${MAX_RESPONSE_LENGTH} characters` };
      }
      cleanResponses.push(trimmed);
    }
    responseCount += cleanResponses.length;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: `${where}: enabled must be a boolean` };
    }

    const entry: CalloutEntry = { triggers: cleanTriggers, responses: cleanResponses };
    if (hasAction) entry.action = action;
    entry.category = cleanCategory;
    if (enabled === false) entry.enabled = false;
    entries.push(entry);
  }

  return { ok: true, entries, responseCount };
}

/** Parses raw uploaded text, reporting a JSON syntax error as-is. */
export function parseCalloutsJson(text: string): CalloutParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON — ${(err as Error).message}` };
  }
  return validateCalloutEntries(parsed);
}

/** `["a", "!b"]` ⇄ `"a, !b"` for the inline editor's trigger field. */
export function triggersToText(triggers: string[]): string {
  return triggers.join(', ');
}
export function textToTriggers(text: string): string[] {
  return text.split(',').map(t => t.trim()).filter(Boolean);
}
/** Responses are one-per-line in the editor (they contain commas). */
export function responsesToText(responses: string[]): string {
  return responses.join('\n');
}
export function textToResponses(text: string): string[] {
  return text.split('\n').map(r => r.trim()).filter(Boolean);
}
