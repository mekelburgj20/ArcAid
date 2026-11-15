import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { cabinetText } from '../utils/witnessCabinetText.js';
import { isReleaseVersion } from '../utils/witnessVersion.js';
import type { WitnessDeviceType } from './WitnessService.js';

/**
 * W105 (v2.249.0, ADR 0040 addendum) - `GET /api/witness/tile`, the screen a
 * player sees when they open the Arcaid Witness tile: whose cabinet this is,
 * whether a newer build is offered, the last score it sent that was kept, and
 * the open cards its plays can land on right now (cabinet 1.1.1 reads it).
 *
 * The wire is binding with the cabinet app:
 *   - every field is a FLAT STRING; free text goes through the one cabinet
 *     sanitizer (`cabinetText`), so no value holds a quote, a backslash, a
 *     control character or a non-ASCII byte; a field that does not apply is
 *     OMITTED, never empty;
 *   - each block is best-effort and independent: a failure omits that block's
 *     fields and logs, the answer still goes out;
 *   - READ-ONLY: nothing here checks in, stamps last-seen or stores `v`.
 *
 * Nothing here re-derives a rule: the account is `cabinetAccountLabel`, the
 * update is the ONE offer rule (`WitnessReleaseService.offeredFor`), the open
 * cards are the ingest's own filters (`VpxScoreIngestService.openGamesForDevice`
 * - routing, entry, window, device exclusion) and the attempts are
 * `AttemptService.deviceAttemptsLeft` (what `/witness/attempt-start` would press).
 */

/** The most open cards one answer lists; `openCount` is always the true total. */
export const TILE_MAX_OPEN_CARDS = 6;
/** Field lengths (characters) the cabinet lays out for. */
export const TILE_NAME_MAX = 60;
export const TILE_TABLE_MAX = 48;
export const TILE_BOARD_MAX = 60;

/** The authenticated device (`requireWitnessDevice`). */
export interface TileDevice {
    deviceId: string;
    canonicalUserId: string;
    deviceType: WitnessDeviceType;
}

/** `<room> / <tournament>`; a Throwdown (no room) is its own name; null when neither is known. */
export function boardLabel(roomName: string | null | undefined, tournamentName: string | null | undefined): string | null {
    const room = (roomName ?? '').trim();
    const tournament = (tournamentName ?? '').trim();
    if (room && tournament) return `${room} / ${tournament}`;
    return room || tournament || null;
}

/** `135930` -> `135,930`. Non-negative integers only; null otherwise. */
export function scoreWithCommas(value: unknown): string | null {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** SQLite UTC text (`YYYY-MM-DD HH:MM:SS`) -> unix seconds, or null. */
function sqliteUtcToSec(value: string | null | undefined): number | null {
    if (!value) return null;
    const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** One card as the tile prints it, before numbering. */
interface TileCard {
    name: string | null;
    table: string | null;
    closes: number | null;
    attempts: string | null;
    gameId: string;
}

/**
 * Soonest `Closes` first, cards with no end last, then by name (then table and
 * id, so the order never depends on the database's).
 */
export function compareTileCards(a: Pick<TileCard, 'name' | 'table' | 'closes' | 'gameId'>, b: Pick<TileCard, 'name' | 'table' | 'closes' | 'gameId'>): number {
    if (a.closes != null && b.closes != null && a.closes !== b.closes) return a.closes - b.closes;
    if (a.closes != null && b.closes == null) return -1;
    if (a.closes == null && b.closes != null) return 1;
    const byText = (x: string | null, y: string | null) => {
        const p = x ?? '';
        const q = y ?? '';
        return p < q ? -1 : p > q ? 1 : 0;
    };
    return byText(a.name, b.name) || byText(a.table, b.table) || byText(a.gameId, b.gameId);
}

export class WitnessTileService {
    /** The whole answer minus `ok`: `now` always, every other field only when it applies. */
    static async build(device: TileDevice, rawVersion: unknown, nowSec: number = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
        const out: Record<string, string> = { now: String(Math.floor(nowSec)) };
        Object.assign(out, await WitnessTileService.accountBlock(device));
        Object.assign(out, await WitnessTileService.updateBlock(device, rawVersion));
        Object.assign(out, await WitnessTileService.lastScoreBlock(device));
        Object.assign(out, await WitnessTileService.openBlock(device, Math.floor(nowSec)));
        return out;
    }

    /** `account`: the paired player's label, the pair answer's own rule (`cabinetAccountLabel`, max 24). */
    private static async accountBlock(device: TileDevice): Promise<Record<string, string>> {
        try {
            const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
            const { cabinetAccountLabel } = await import('./WitnessService.js');
            const label = (await resolveUserLabels([device.canonicalUserId]))[device.canonicalUserId];
            const account = cabinetAccountLabel(label);
            return account ? { account } : {};
        } catch (err) {
            logError('Witness tile: account step failed (the answer still went out)', err);
            return {};
        }
    }

    /** `update`: the ONE offer rule, judged on the build the tile says it is (`v`). */
    private static async updateBlock(device: TileDevice, rawVersion: unknown): Promise<Record<string, string>> {
        try {
            const { parseAppVersion } = await import('./WitnessService.js');
            const { WitnessReleaseService } = await import('./WitnessReleaseService.js');
            const version = await WitnessReleaseService.offeredFor(device.deviceId, parseAppVersion(rawVersion));
            return isReleaseVersion(version) ? { update: version } : {};
        } catch (err) {
            logError('Witness tile: update offer step failed (the answer still went out)', err);
            return {};
        }
    }

    /**
     * `lastScore*`: the newest score this device sent on this account that was
     * KEPT, from the trail the devices list reads (`witness_evidence`, W103):
     * landed on a board (`ingested`), on the Global Scoreboard (`global`), or
     * refused by a tournament and kept on Global instead (a refusal row with a
     * `global_score_id`). Repeats (`duplicate` / `global_duplicate`) are not a
     * new score. One play can land in several tournaments (one row each); the
     * newest play wins and, inside it, a board landing beats a Global row. All
     * four fields or none.
     */
    private static async lastScoreBlock(device: TileDevice): Promise<Record<string, string>> {
        try {
            const db = await getDatabase();
            const rows = await db.all<Array<{
                outcome: string; table_name: string; score: number; played_at: string; created_at: string;
                tournament_name: string | null; room_name: string | null;
            }>>(
                `SELECT e.outcome, e.table_name, e.score, e.played_at, e.created_at,
                        t.name AS tournament_name, gr.name AS room_name
                   FROM witness_evidence e
                   LEFT JOIN tournaments t ON t.id = e.tournament_id
                   LEFT JOIN game_rooms gr ON gr.id = e.game_room_id
                  WHERE e.device_id = ? AND e.canonical_user_id = ?
                    AND (e.outcome IN ('ingested', 'global')
                         OR (e.outcome IN ('not_sanctioned', 'attempt_refused') AND e.global_score_id IS NOT NULL))
                  ORDER BY e.created_at DESC, e.id DESC
                  LIMIT 12`,
                device.deviceId, device.canonicalUserId,
            );
            if (rows.length === 0) return {};
            const first = rows[0]!;
            const play = rows.filter(r =>
                r.played_at === first.played_at && r.score === first.score && r.table_name === first.table_name);
            const row = play.find(r => r.outcome === 'ingested') ?? first;
            const board = row.outcome === 'ingested'
                ? cabinetText(boardLabel(row.room_name, row.tournament_name), TILE_BOARD_MAX)
                : 'Global Scoreboard';
            const table = cabinetText(row.table_name, TILE_TABLE_MAX);
            const value = scoreWithCommas(row.score);
            const at = sqliteUtcToSec(row.created_at);
            if (!board || !table || !value || at == null) return {};
            return { lastScoreTable: table, lastScoreValue: value, lastScoreAt: String(at), lastScoreBoard: board };
        } catch (err) {
            logError('Witness tile: last score step failed (the answer still went out)', err);
            return {};
        }
    }

    /**
     * `openCount`, `open<N>*` and `needsStart`. The cards are
     * `openGamesForDevice` (the ingest's filters at `now`, no table named);
     * the attempts are `deviceAttemptsLeft` over the same filters. A card
     * that needs Start attempts and has none reads `press start`; an
     * unlimited one has no `Attempts`. `needsStart` = a table
     * `/witness/attempt-start` would start now (one not pressed yet).
     */
    private static async openBlock(device: TileDevice, nowSec: number): Promise<Record<string, string>> {
        try {
            const { WitnessService } = await import('./WitnessService.js');
            const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
            const { AttemptService } = await import('./AttemptService.js');
            const target = await WitnessService.getDeviceTarget(device.deviceId);
            const games = await VpxScoreIngestService.openGamesForDevice({
                canonicalUserId: device.canonicalUserId, target, deviceType: device.deviceType, nowTs: nowSec,
            });
            const attempts = await AttemptService.deviceAttemptsLeft({
                deviceId: device.deviceId, canonicalUserId: device.canonicalUserId, nowTs: nowSec,
                deviceType: device.deviceType,
            });
            const attemptsOf = new Map(attempts.map(a => [a.gameId, a]));

            const cards: TileCard[] = games.map((g) => {
                const a = attemptsOf.get(g.gameId);
                return {
                    name: cabinetText(boardLabel(g.roomName, g.tournamentName), TILE_NAME_MAX),
                    table: cabinetText(g.gameName, TILE_TABLE_MAX),
                    closes: g.endsTs,
                    attempts: a ? (a.notStarted ? 'press start' : `${a.left} of ${a.limit} left`) : null,
                    gameId: g.gameId,
                };
            }).sort(compareTileCards);

            const out: Record<string, string> = { openCount: String(cards.length) };
            cards.slice(0, TILE_MAX_OPEN_CARDS).forEach((card, i) => {
                const n = i + 1;
                if (card.name) out[`open${n}Name`] = card.name;
                if (card.table) out[`open${n}Table`] = card.table;
                if (card.closes != null) out[`open${n}Closes`] = String(card.closes);
                if (card.attempts) out[`open${n}Attempts`] = card.attempts;
            });
            if (attempts.some(a => a.notStarted)) out.needsStart = '1';
            return out;
        } catch (err) {
            logError('Witness tile: open cards step failed (the answer still went out)', err);
            return {};
        }
    }
}
