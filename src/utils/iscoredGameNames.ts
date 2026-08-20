import { logWarn } from './logger.js';

export interface IScoredGameNameRow {
    id: string;
    name: string;
    hidden: boolean;
    locked: boolean;
    tags: string[];
}

/**
 * Parse the body of iScored's internal admin endpoint
 * `settingsCommands.php?c=getGameNames` into the client's game-summary rows.
 *
 * Live payload (prod, 2026-08-20):
 *   [{"GameID":103966,"GameName":"Mask, The","GameLogo":null,"ScoreType":null,
 *     "tags":"[\"DG\"]","Hidden":null,"Locked":"TRUE"}, ...]
 *
 * i.e. `GameID`/`GameName` are capitalised and `tags` is a JSON-encoded STRING.
 * The original mapper (v2.11, PR #32) read `gameID`/`gameName` and expected an
 * array, so every row lost its id and was filtered out — `getGamesOnIScored()`
 * returned `[]` on prod for two months, which silently confirmed every delete
 * and emptied the Reconcile plan. Hence: field reads are case-tolerant, `tags`
 * accepts array or JSON string, and a payload that had rows but yields none
 * WARNs with the first row's keys so a future shape change is loud.
 *
 * Returns [] on an empty/non-JSON/non-array body (the caller decides what that
 * means — see `IScoredSnapshotService.capture`'s double-read rule).
 */
export function parseGetGameNamesPayload(raw: string, context = 'getGamesOnIScored'): IScoredGameNameRow[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        logWarn(`${context}: getGameNames response was not JSON.`);
        return [];
    }
    if (!Array.isArray(parsed)) {
        logWarn(`${context}: getGameNames response was JSON but not an array (${typeof parsed}).`);
        return [];
    }

    const rows = (parsed as Array<Record<string, unknown>>)
        .filter((g) => g && typeof g === 'object')
        .map((g) => ({
            id: String(pick(g, 'gameID', 'GameID', 'gameId', 'id') ?? '').trim(),
            name: String(pick(g, 'gameName', 'GameName', 'name') ?? '').trim(),
            hidden: isTrue(pick(g, 'Hidden', 'hidden')),
            locked: isTrue(pick(g, 'Locked', 'locked')),
            tags: parseTags(pick(g, 'tags', 'Tags')),
        }))
        .filter((g) => g.id !== '');

    if (parsed.length > 0 && rows.length === 0) {
        const first = parsed[0];
        const keys = first && typeof first === 'object' ? Object.keys(first as object).join(', ') : typeof first;
        logWarn(`${context}: getGameNames returned ${parsed.length} row(s) but none carried a recognisable game id — payload shape changed? first row keys: ${keys}`);
    }
    return rows;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
}

function isTrue(v: unknown): boolean {
    if (v === true) return true;
    if (typeof v === 'number') return v !== 0;
    return String(v ?? '').trim().toUpperCase() === 'TRUE' || String(v ?? '').trim() === '1';
}

function parseTags(v: unknown): string[] {
    if (Array.isArray(v)) return v.map(String).filter((t) => t !== '');
    if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return [];
        if (s.startsWith('[')) {
            try {
                const arr = JSON.parse(s);
                return Array.isArray(arr) ? arr.map(String).filter((t) => t !== '') : [];
            } catch {
                /* fall through to the comma split */
            }
        }
        return s.split(',').map((t) => t.trim()).filter((t) => t !== '');
    }
    return [];
}
