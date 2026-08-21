/**
 * Callouts — FE-side upload parsing/validation.
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
export type CalloutAction = 'active_games' | 'picks_link' | 'scores_link' | 'how_to_submit';

export const CALLOUT_ACTIONS: CalloutAction[] = [
  'active_games', 'picks_link', 'scores_link', 'how_to_submit',
];

/** What each action answers with, for the editor's select + badge tooltip. */
export const CALLOUT_ACTION_LABELS: Record<CalloutAction, string> = {
  active_games: "What's active now (live)",
  picks_link: 'Link to the Picks page',
  scores_link: 'Link to the scoreboard',
  how_to_submit: 'How to submit a score',
};

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
  enabled?: boolean;
}

/** A stored callout as `GET /api/admin/callouts` returns it. */
export interface CalloutRow {
  id: number;
  triggers: string[];
  responses: string[];
  action: CalloutAction | null;
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

    const { triggers, responses, enabled, action } = raw as {
      triggers?: unknown; responses?: unknown; enabled?: unknown; action?: unknown;
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

    // Responses are required UNLESS the entry answers with live data.
    if (responses === undefined && hasAction) {
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { ok: false, error: `${where}: enabled must be a boolean` };
      }
      const actionEntry: CalloutEntry = { triggers: cleanTriggers, action };
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
