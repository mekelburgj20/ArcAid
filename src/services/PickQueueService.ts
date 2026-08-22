import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { catalogueTypeMatchesTournamentMode } from '../utils/tournamentMode.js';
import { passesplatformRules, parsePlatformsList, parseTournamentRules } from '../utils/platformRules.js';
import { RoomGameTagsService } from './RoomGameTagsService.js';
import { PickAwardGate } from './PickAwardGate.js';
import { QUEUE_ORDER_SQL } from '../utils/queueOrder.js';

/**
 * The ONE eligibility pipeline behind every "put this game in a player's
 * queue" path (v2.121.0).
 *
 * Extracted verbatim from `POST /:roomId/pick-game`'s pre-branch checks so
 * the admin queue-on-behalf endpoint + the `/nominate-picker queue` slash
 * subcommand cannot drift from what a player picking for themselves gets.
 * Step order, wording and HTTP statuses are preserved exactly — the web
 * route now calls this and keeps its own membership/placeholder/activation
 * branch below it.
 *
 * NOT folded in here on purpose:
 *   - `RoomMembershipService.addMember` — a side effect of a PLAYER acting,
 *     not of a game becoming queued. It stays in the player route, in its
 *     original position.
 *   - the already-ACTIVE twin guard — `findActiveTwin` below is exported
 *     separately because the player route runs it AFTER that membership
 *     write, and folding it in would reorder the side effect.
 */

/**
 * Max games one player may hold in one tournament's queue.
 *
 * Raised 5 → 30 in v2.126.0 (owner ask): with the hold model a queued pick is
 * never dropped for cooldown, so a deep queue is now a "set it and forget it"
 * plan rather than a list that quietly erodes. Every enforcement AND display
 * site imports this — no path may hardcode the number again.
 */
export const PICK_QUEUE_MAX = 30;

/** Re-exported so queue call sites have one import for "the queue rules". */
export { QUEUE_ORDER_SQL, queueOrderSql } from '../utils/queueOrder.js';

export type PickQueueRejectionReason =
    | 'TOURNAMENT_NOT_FOUND'
    | 'PICK_AWARD_DISABLED'
    | 'GAME_NOT_FOUND'
    | 'MODE_MISMATCH'
    | 'PLATFORM_RESTRICTED'
    | 'COOLDOWN'
    | 'QUEUE_FULL'
    | 'DUPLICATE_IN_QUEUE'
    | 'ALREADY_ACTIVE';

export interface PickEligibilityFailure {
    ok: false;
    reason: PickQueueRejectionReason;
    /** Ready-to-render copy — the exact strings the web route already replied with. */
    message: string;
    /** HTTP status the web routes answer with (unchanged by the extraction). */
    status: number;
}

export interface PickEligibilitySuccess {
    ok: true;
    /** Tournament row: id, name, type, mode, max_active_games, platform_rules, game_room_id, eligibility_days. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tournament: any;
    /** Catalogue-canonical spelling of the requested game. */
    gameName: string;
    styleId: string | undefined;
}

export type PickEligibilityResult = PickEligibilitySuccess | PickEligibilityFailure;

export interface PickEligibilityInput {
    roomId: string;
    tournamentId: string;
    gameName: string;
    /** Whose queue this lands in — the invoker for self-picks, the target for on-behalf. */
    forUserId: string;
    /**
     * Reject when `forUserId` already holds this game in this tournament's
     * queue. OFF for the player route: pre-v2.121.0 `POST /pick-game` had no
     * such guard and "behaviour unchanged" is the extraction's contract. ON
     * for the admin on-behalf paths, where silently double-queueing someone
     * else's pick is the failure mode an admin would actually hit.
     */
    rejectDuplicateInQueue?: boolean;
}

/**
 * Days until `gameName` clears its cooldown in `tournamentId`, given the date
 * it was last played.
 *
 * Pure so the batched availability endpoint (which resolves last-played dates
 * for the whole pick list in ONE query) can share the arithmetic without
 * degenerating into a query per game.
 *
 * `minDays` is the floor: the availability list wants 0 ("available now"),
 * the rejection/held copy wants 1 ("one more day"), and that one-character
 * difference is the whole reason the two copies drifted.
 */
export function cooldownDaysFromLastPlayed(
    lastPlayedIso: string | null | undefined,
    eligibilityDays: number,
    opts: { minDays?: number; now?: number } = {},
): number {
    const minDays = opts.minDays ?? 0;
    const now = opts.now ?? Date.now();
    if (!lastPlayedIso) return minDays;
    const availableDate = new Date(lastPlayedIso);
    availableDate.setDate(availableDate.getDate() + eligibilityDays);
    return Math.max(minDays, Math.ceil((availableDate.getTime() - now) / (1000 * 60 * 60 * 24)));
}

/**
 * The per-game form: resolves the last non-QUEUED run of `gameName` in this
 * tournament, then applies `cooldownDaysFromLastPlayed`. Used for the single
 * game a caller is asking about (a rejected pick, a held queue row) — never in
 * a loop over the catalogue.
 */
export async function cooldownDaysRemaining(
    tournamentId: string,
    gameName: string,
    opts: { eligibilityDays?: number; minDays?: number } = {},
): Promise<number> {
    const db = await getDatabase();
    let eligibilityDays = opts.eligibilityDays;
    if (eligibilityDays === undefined) {
        const t = await db.get('SELECT eligibility_days FROM tournaments WHERE id = ?', tournamentId);
        eligibilityDays = t?.eligibility_days ?? 120;
    }
    const lastPlayed = await db.get(
        `SELECT start_date FROM games
         WHERE tournament_id = ? AND name = ? COLLATE NOCASE AND status != 'QUEUED'
         ORDER BY start_date DESC LIMIT 1`,
        tournamentId, gameName,
    );
    // No prior run at all → the full window is the honest answer for the
    // rejection copy, and the caller only asks when eligibility already failed.
    if (!lastPlayed?.start_date) return eligibilityDays as number;
    return cooldownDaysFromLastPlayed(lastPlayed.start_date, eligibilityDays as number, { minDays: opts.minDays });
}

/**
 * Renumber one player's queue in one tournament to a gapless 1..N.
 *
 * Called from every path that REMOVES or PROMOTES a queued row — the player
 * and admin deletes, and all three engine consumption sites. Pre-v2.126.0 only
 * the reorder endpoint renumbered, so deleting position 2 of [1,2,3] left
 * [1,3] and the next add landed at 4; positions displayed as an array index
 * hid it, but the stored numbers drifted further apart on every edit.
 *
 * Ordering is `queue_order ASC, rowid ASC` — the STORED positions, not the
 * hold-aware activation order. Compaction is bookkeeping: it must never
 * silently rewrite a player's intended sequence just because one row is
 * currently held.
 */
export async function compactQueue(tournamentId: string, pickerDiscordId: string | null | undefined): Promise<void> {
    if (!pickerDiscordId) return;
    const db = await getDatabase();
    const rows = await db.all(
        `SELECT id FROM games
         WHERE tournament_id = ? AND status = 'QUEUED' AND name != '[Pending Pick]'
           AND picker_discord_id = ?
         ORDER BY queue_order ASC, rowid ASC`,
        tournamentId, pickerDiscordId,
    ) as Array<{ id: string }>;
    let next = 1;
    for (const row of rows) {
        await db.run('UPDATE games SET queue_order = ? WHERE id = ?', next++, row.id);
    }
}

/**
 * Steps 1-6 of the player pick flow: tournament resolution, pick-award gate,
 * catalogue lookup, mode match, platform rules, cooldown, queue cap
 * (+ the optional duplicate guard).
 */
export async function checkPickQueueEligibility(input: PickEligibilityInput): Promise<PickEligibilityResult> {
    const { roomId, tournamentId, gameName, forUserId } = input;
    const db = await getDatabase();

    // 1. Verify tournament belongs to this room and is active
    const tournament = await db.get(
        'SELECT id, name, type, mode, max_active_games, platform_rules, game_room_id, eligibility_days FROM tournaments WHERE id = ? AND game_room_id = ? AND is_active = 1',
        tournamentId, roomId,
    );
    if (!tournament) {
        return { ok: false, reason: 'TOURNAMENT_NOT_FOUND', status: 404, message: 'Tournament not found or inactive' };
    }

    // 1a. Pick-award gate — mirrors the Discord-command gate so no path can
    //     re-enable a flow admins have opted out of.
    const pickEnabled = await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id);
    if (!pickEnabled) {
        return { ok: false, reason: 'PICK_AWARD_DISABLED', status: 403, message: 'Winner picks is turned off for this tournament' };
    }

    // 2. Look up game in catalogue.
    const gameLibEntry = await db.get(
        `SELECT name, type AS mode, platforms, features FROM global_games
         WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
        gameName,
    );
    if (!gameLibEntry) {
        return { ok: false, reason: 'GAME_NOT_FOUND', status: 404, message: `Game "${gameName}" not found in the catalogue` };
    }

    // 3. Check mode match. `catalogueTypeMatchesTournamentMode` bridges the
    //    tournament-mode vocabulary against the catalogue-type vocabulary.
    if (!catalogueTypeMatchesTournamentMode(gameLibEntry.mode, tournament.mode)) {
        return {
            ok: false, reason: 'MODE_MISMATCH', status: 400,
            message: `Game mode "${gameLibEntry.mode}" does not match tournament mode "${tournament.mode}"`,
        };
    }

    // 4. Check platform rules. Game's effective platforms = catalogue ∪ room tags.
    //    Parsed ONCE — the gate and its rejection message must come from the
    //    same read of the blob, or the two drift apart.
    const platformRules = parseTournamentRules(tournament);
    const cataloguePlatforms = parsePlatformsList(gameLibEntry.platforms || '[]');
    const roomTags = await RoomGameTagsService.getTagsForGameName(roomId, gameName);
    const gamePlatforms = Array.from(new Set([...cataloguePlatforms, ...roomTags]));
    // Features carry the device-axis availability the fold moved out of
    // `platforms` (ADR 0016 catalogue phase §4). Room tags are platforms only.
    const gameFeatures = parsePlatformsList(gameLibEntry.features || '[]');

    if (!passesplatformRules(gamePlatforms, platformRules, gameFeatures)) {
        return {
            ok: false, reason: 'PLATFORM_RESTRICTED', status: 400,
            message: platformRules.restrictedText || 'This game is not available for this tournament type (platform restriction)',
        };
    }

    // 5. Check cooldown (eligibility)
    const engine = TournamentEngine.getInstance();
    const isEligible = await engine.isGameEligible(tournamentId, gameLibEntry.name);
    if (!isEligible) {
        const daysRemaining = await cooldownDaysRemaining(tournamentId, gameLibEntry.name, {
            eligibilityDays: tournament.eligibility_days ?? undefined,
            minDays: 1,
        });
        return {
            ok: false, reason: 'COOLDOWN', status: 400,
            message: `"${gameLibEntry.name}" is in cooldown for ${daysRemaining} more day${daysRemaining === 1 ? '' : 's'}`,
        };
    }

    // 6. Check queue limit (PICK_QUEUE_MAX per user per tournament)
    const queueCount = await db.get(
        `SELECT COUNT(*) as count FROM games
         WHERE tournament_id = ? AND status = 'QUEUED'
           AND picker_discord_id = ? AND name != '[Pending Pick]'`,
        tournamentId, forUserId,
    );
    if ((queueCount?.count ?? 0) >= PICK_QUEUE_MAX) {
        return {
            ok: false, reason: 'QUEUE_FULL', status: 400,
            message: `Queue limit reached (max ${PICK_QUEUE_MAX} games per tournament)`,
        };
    }

    // 6b. Optional duplicate guard — see `rejectDuplicateInQueue`.
    if (input.rejectDuplicateInQueue) {
        const dup = await db.get(
            `SELECT id FROM games
             WHERE tournament_id = ? AND status = 'QUEUED' AND name != '[Pending Pick]'
               AND picker_discord_id = ? AND LOWER(name) = LOWER(?)`,
            tournamentId, forUserId, gameLibEntry.name,
        );
        if (dup) {
            return {
                ok: false, reason: 'DUPLICATE_IN_QUEUE', status: 409,
                message: `"${gameLibEntry.name}" is already in that player's queue for ${tournament.name}`,
            };
        }
    }

    return {
        ok: true,
        tournament,
        gameName: gameLibEntry.name,
        styleId: gameLibEntry.style_id || undefined,
    };
}

/**
 * The v2.103.0 duplicate-activation guard: is this game already ACTIVE in the
 * tournament? Separate from `checkPickQueueEligibility` because the player
 * route runs it after its membership write (see the module note).
 */
export async function findActiveTwin(tournamentId: string, gameName: string): Promise<{ id: string } | undefined> {
    const db = await getDatabase();
    return db.get(
        `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE' AND LOWER(name) = LOWER(?)`,
        tournamentId, gameName,
    );
}

export interface QueuedGameRow {
    id: string;
    name: string;
    queue_order: number | null;
    tournament_id: string;
    /** ISO instant the engine put this pick on hold (cooldown), else null. */
    queue_held_at: string | null;
    /** Convenience mirror of `queue_held_at != null` for the FE. */
    held: boolean;
    /** Days until a HELD pick clears its cooldown; null for unheld rows. */
    daysUntilAvailable: number | null;
}

/**
 * A player's queue for one tournament, in the order the engine consumes it
 * (`QUEUE_ORDER_SQL` — held picks first, then stored position).
 *
 * `daysUntilAvailable` is resolved only for held rows: an unheld row is either
 * eligible or has simply not been reached yet, and a per-row cooldown query
 * for the whole queue would be N queries for a number nothing renders.
 */
export async function getPlayerQueue(tournamentId: string, forUserId: string): Promise<QueuedGameRow[]> {
    const db = await getDatabase();
    const rows = await db.all(
        `SELECT id, name, queue_order, tournament_id, queue_held_at FROM games
         WHERE tournament_id = ? AND status = 'QUEUED' AND name != '[Pending Pick]'
           AND picker_discord_id = ?
         ORDER BY ${QUEUE_ORDER_SQL}`,
        tournamentId, forUserId,
    ) as Array<Omit<QueuedGameRow, 'held' | 'daysUntilAvailable'>>;

    return Promise.all(rows.map(async row => ({
        ...row,
        held: !!row.queue_held_at,
        daysUntilAvailable: row.queue_held_at
            ? await cooldownDaysRemaining(tournamentId, row.name, { minDays: 1 })
            : null,
    })));
}

export interface QueueOnBehalfSuccess {
    ok: true;
    game: { id: string; name: string };
    tournament: { id: string; name: string };
    queue: QueuedGameRow[];
}

export type QueueOnBehalfResult = QueueOnBehalfSuccess | PickEligibilityFailure;

/**
 * Admin "queue this game for that player". Runs the shared pipeline with the
 * duplicate guard on, then attributes the row to `forUserId` via
 * `TournamentEngine.queueGame` — it never activates and never touches
 * iScored: an on-behalf pick is always a QUEUE, and the rotation decides when
 * it runs. That is what makes it safe to do for an absent player.
 */
export async function queueGameOnBehalf(opts: {
    roomId: string;
    tournamentId: string;
    gameName: string;
    forUserId: string;
}): Promise<QueueOnBehalfResult> {
    const eligibility = await checkPickQueueEligibility({ ...opts, rejectDuplicateInQueue: true });
    if (!eligibility.ok) return eligibility;

    const twin = await findActiveTwin(opts.tournamentId, eligibility.gameName);
    if (twin) {
        return {
            ok: false, reason: 'ALREADY_ACTIVE', status: 409,
            message: `"${eligibility.gameName}" is already running in ${eligibility.tournament.name} — choose a different game.`,
        };
    }

    const engine = TournamentEngine.getInstance();
    const game = await engine.queueGame(
        opts.tournamentId, eligibility.gameName, eligibility.styleId, undefined, opts.forUserId,
    );

    return {
        ok: true,
        game: { id: game.id, name: game.name },
        tournament: { id: eligibility.tournament.id, name: eligibility.tournament.name },
        queue: await getPlayerQueue(opts.tournamentId, opts.forUserId),
    };
}

/**
 * Fire-and-forget "an admin queued a game for you" DM.
 *
 * Deliberately `sendDirectMessage` rather than `NotificationService.notify`:
 * the five notify types are player-opt-in preferences with an hourly rate
 * limit, and none of them describes an admin acting ON the player. This is a
 * courtesy heads-up about a change to their own queue, so it always goes out
 * — but it is also never allowed to fail the request that triggered it, hence
 * the blanket catch. Non-Discord identities (`google:*`) have no DM channel
 * and are skipped silently.
 */
export async function notifyQueuedOnBehalf(opts: {
    forUserId: string;
    roomId: string;
    tournamentName: string;
    gameName: string;
}): Promise<void> {
    try {
        const { isDiscordUserId } = await import('../utils/identityProvider.js');
        if (!isDiscordUserId(opts.forUserId)) return;

        const db = await getDatabase();
        const room = await db.get('SELECT slug, name FROM game_rooms WHERE id = ?', opts.roomId);
        if (!room) return;

        const { isDiscordEnabledForRoom, sendDirectMessage } = await import('../utils/discord.js');
        if (!(await isDiscordEnabledForRoom(opts.roomId))) return;

        const { roomPicksUrl } = await import('../utils/publicLinks.js');
        const link = roomPicksUrl(room.slug, opts.tournamentName);
        await sendDirectMessage(
            opts.forUserId,
            `An admin in **${room.name}** queued **${opts.gameName}** for you in **${opts.tournamentName}**. ` +
            `If you win the next round it will be your pick. Manage your queue: ${link}`,
        );
    } catch {
        // Never surfaces — the queue write already succeeded.
    }
}
