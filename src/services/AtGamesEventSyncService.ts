import { getDatabase } from '../database/database.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { getAtGamesCredsForRoom } from '../utils/atgamesCreds.js';
import { AtGamesPrivateClient } from './AtGamesPrivateClient.js';
import type { AtGamesRanking } from './AtGamesPrivateClient.js';
import { eventEndGraceSec } from './EventSubmissionGate.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';

/**
 * P7 — ingests an AtGames private tournament's scores into an Arcaid event.
 *
 * ## The problem this solves
 *
 * On an AtGames cabinet a player cannot submit to Arcaid from where they are
 * standing — the cabinet posts to AtGames, not to us. Until now a host ran an
 * AtGames round by asking players to re-type their score into Arcaid on their
 * phone. This reads the AtGames private tournament directly, so the board fills
 * itself from the cabinets.
 *
 * ## What is authoritative, and what is not
 *
 * The AtGames score is authoritative. Its `created_at` is the moment the player
 * **exited the table** (AtGames is exit-to-submit), NOT when they started — so
 * this can tell you a score landed inside the round window and nothing more.
 * Play duration is unknowable from here; that is exactly the gap P8's on-device
 * witness exists to close, and nothing in this file should ever be described as
 * proving a score was played inside the window.
 *
 * ## Rules
 *
 * - **The window is enforced server-side, on Arcaid's clock reading of AtGames'
 *   timestamp.** A score whose `created_at` falls outside its round's window
 *   plus the event's grace is dropped, not stored — same grace value the submit
 *   gate and the round-closing scheduler use (`eventEndGraceSec`), because a
 *   score accepted by one and refused by another is the bug that helper exists
 *   to prevent.
 * - **Rounds are matched by (catalogue game, window).** A Live Event may run
 *   the same table in two rounds; the score lands in whichever round's window
 *   contains its timestamp. An AtGames game with no matching Arcaid round is
 *   counted and reported, never guessed at.
 * - **Identity is a link, never a name match.** `atgames:<account id>` resolves
 *   through `user_identity_links`; an unlinked account's score still lands (the
 *   host wants a complete board) but carries `submitted_by_user_id = NULL` and
 *   the synthetic `atgames:<id>` in `discord_user_id`, exactly as the iScored
 *   poller does with `iscored:<name>`. Name-matching an AtGames handle onto an
 *   Arcaid account would silently attribute one player's score to another.
 * - **Ingest is idempotent.** `ScoreHistoryService.log` dedups on
 *   (room, game row, player, score), so re-running mid-round costs nothing.
 * - **No Global Scoreboard fan-out.** Deliberate, matching `'sync'`: these
 *   scores were never observed by Arcaid and mostly belong to unlinked
 *   accounts. Revisit as a product call, not as an oversight.
 */

export interface AtGamesSyncResult {
    /** Rows written to `score_history`. */
    ingested: number;
    /** Rows already present (the dedup swallowed them). */
    duplicates: number;
    /** Rows whose timestamp fell outside every candidate round's window. */
    outOfWindow: number;
    /** Rows whose AtGames game matched no round in this tournament. */
    unmatchedGame: number;
    /** Rows written without an Arcaid account behind them. */
    unlinkedAccounts: number;
    /** AtGames game ids that matched no round, for the host to act on. */
    unmatchedGameIds: number[];
    /** Arcaid round ids that gained at least one score — what to refresh. */
    affectedGameIds: string[];
    /** True when nothing was written — this was a preview. */
    dryRun: boolean;
    /**
     * Per-score outcome, for a host who wants to know WHY a score is missing.
     * "It didn't show up" is the question this feature will generate most, and
     * a count alone cannot answer it.
     */
    rows: AtGamesSyncRow[];
}

export interface AtGamesSyncRow {
    atgamesAccount: number;
    userName: string;
    score: number;
    /** AtGames' own timestamp, normalised to ISO UTC; null if unparseable. */
    atIso: string | null;
    decision: 'ingested' | 'duplicate' | 'out_of_window' | 'unmatched_game' | 'bad_timestamp';
    roundNo: number | null;
    roundName: string | null;
    /** The Arcaid account this landed under, or null when the AtGames account is unlinked. */
    linkedUserId: string | null;
}

interface TournamentRow {
    id: string;
    game_room_id: string | null;
    format: string | null;
    atgames_tournament_id: string | null;
    end_grace_sec: number | null;
}

interface RoundRow {
    id: string;
    name: string;
    round_no: number | null;
    scheduled_start_at: string | null;
    scheduled_end_at: string | null;
}

/** Raised when the caller asked for something this sync cannot do. */
export class AtGamesSyncError extends Error {
    readonly code: 'NOT_LINKED' | 'NO_CREDENTIALS' | 'NOT_FOUND' | 'NO_ROOM';
    constructor(code: AtGamesSyncError['code'], message: string) {
        super(message);
        this.name = 'AtGamesSyncError';
        this.code = code;
    }
}

/**
 * Epoch ms → the SQLite UTC shape `score_history.created_at` is stored in
 * (`'YYYY-MM-DD HH:MM:SS'`, what `datetime('now')` writes).
 *
 * Built from the UTC getters rather than sliced out of `toISOString()` so the
 * milliseconds and the `T` can't survive by accident — a stray `.000Z` would
 * still compare and `strftime('%s', …)` correctly, but it would make these rows
 * visibly different from every other row in the column.
 */
export function toSqliteUtc(epochMs: number): string {
    const d = new Date(epochMs);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Parses an AtGames timestamp to epoch milliseconds, or null.
 *
 * AtGames writes tournament rankings as `"2026-08-23 20:54:42.0"` — UTC, but
 * with no zone marker at all, which `Date.parse` reads as LOCAL time. On a
 * server that is not on UTC that silently shifts every score by the offset and
 * drops half of them outside the window, so the zone is appended explicitly
 * rather than left to the runtime.
 */
export function parseAtGamesTimestamp(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const trimmed = String(raw).trim();

    // `2026-08-23 20:54:42.0` / `2026-08-23T20:54:42` (± fractional seconds).
    const sqlish = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(trimmed);
    if (sqlish) {
        const [, y, mo, d, h, mi, s] = sqlish;
        return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    }

    // Anything already carrying a zone (`…Z`, `…+00:00`) is safe to hand over.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

export class AtGamesEventSyncService {
    /**
     * Pulls the linked AtGames private tournament and writes its in-window
     * scores into this Arcaid tournament's rounds.
     *
     * Throws `AtGamesSyncError` for a caller mistake (not linked, no creds) and
     * `AtGamesAuthError` when AtGames rejects the room's credentials — both are
     * things a room admin can fix, so they must surface rather than be logged
     * and swallowed.
     */
    static async syncTournament(
        tournamentId: string,
        opts?: { dryRun?: boolean },
    ): Promise<AtGamesSyncResult> {
        const dryRun = opts?.dryRun === true;
        const db = await getDatabase();

        const tournament = await db.get<TournamentRow>(
            `SELECT id, game_room_id, format, atgames_tournament_id, end_grace_sec
             FROM tournaments WHERE id = ?`,
            tournamentId,
        );
        if (!tournament) {
            throw new AtGamesSyncError('NOT_FOUND', 'Tournament not found');
        }
        if (!tournament.atgames_tournament_id) {
            throw new AtGamesSyncError(
                'NOT_LINKED',
                'This tournament is not linked to an AtGames private tournament',
            );
        }
        if (!tournament.game_room_id) {
            // Credentials live on the room. A room-less Throwdown has nowhere
            // to keep them, so AtGames sync is a hosted-event feature.
            throw new AtGamesSyncError(
                'NO_ROOM',
                'AtGames sync needs a game room (the AtGames account is a room setting)',
            );
        }

        const creds = await getAtGamesCredsForRoom(tournament.game_room_id);
        if (!creds) {
            throw new AtGamesSyncError(
                'NO_CREDENTIALS',
                'This room has no AtGames account configured (set ATGAMES_EMAIL and ATGAMES_PASSWORD)',
            );
        }

        const client = new AtGamesPrivateClient(creds);
        const resolvedId = await this.resolveAtGamesId(client, tournament.id, tournament.atgames_tournament_id);
        const detail = await client.getPrivateTournament(resolvedId);
        const rankings = AtGamesPrivateClient.flattenRankings(detail);

        const rounds = await db.all<RoundRow[]>(
            `SELECT id, name, round_no, scheduled_start_at, scheduled_end_at
             FROM games
             WHERE tournament_id = ? AND round_no IS NOT NULL
             ORDER BY round_no ASC`,
            tournamentId,
        );
        if (rounds.length === 0) {
            logWarn(`AtGames sync: tournament ${tournamentId} has no event rounds — nothing to ingest into`);
        }

        const roundsByGameId = await this.mapRoundsToAtGamesIds(rounds);
        const graceMs = eventEndGraceSec(tournament) * 1000;

        const result: AtGamesSyncResult = {
            ingested: 0, duplicates: 0, outOfWindow: 0,
            unmatchedGame: 0, unlinkedAccounts: 0, unmatchedGameIds: [], affectedGameIds: [],
            dryRun, rows: [],
        };
        const affected = new Set<string>();
        const unmatched = new Set<number>();
        // One lookup per distinct account, not per score — a busy round has
        // many rows from few players.
        const canonicalByAccount = new Map<number, string | null>();

        for (const row of rankings) {
            const score = typeof row.score === 'number' ? row.score : Number(row.score);
            const at = parseAtGamesTimestamp(row.created_at);
            const record = (
                decision: AtGamesSyncRow['decision'],
                round: RoundRow | null,
                linkedUserId: string | null,
            ) => {
                result.rows.push({
                    atgamesAccount: row.account,
                    userName: row.user_name,
                    score,
                    atIso: at == null ? null : new Date(at).toISOString(),
                    decision,
                    roundNo: round?.round_no ?? null,
                    roundName: round?.name ?? null,
                    linkedUserId,
                });
            };

            const candidates = roundsByGameId.get(row.game_id);
            if (!candidates || candidates.length === 0) {
                result.unmatchedGame++;
                unmatched.add(row.game_id);
                record('unmatched_game', null, null);
                continue;
            }

            if (at == null) {
                logWarn(`AtGames sync: unparseable timestamp "${row.created_at}" on game ${row.game_id} — skipping`);
                result.outOfWindow++;
                record('bad_timestamp', null, null);
                continue;
            }

            const round = candidates.find(r => {
                const start = r.scheduled_start_at ? Date.parse(r.scheduled_start_at) : NaN;
                const end = r.scheduled_end_at ? Date.parse(r.scheduled_end_at) : NaN;
                if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
                return at >= start && at <= end + graceMs;
            });
            if (!round) {
                result.outOfWindow++;
                record('out_of_window', null, null);
                continue;
            }

            if (!canonicalByAccount.has(row.account)) {
                const providerId = `atgames:${row.account}`;
                const canonical = await IdentityLinkService.resolveCanonical(providerId);
                canonicalByAccount.set(row.account, canonical === providerId ? null : canonical);
            }
            const canonical = canonicalByAccount.get(row.account) ?? null;
            if (!canonical) result.unlinkedAccounts++;

            // A dry run answers the same question the real run does, through
            // the SAME dedup predicate — it just stops short of the INSERT.
            const isNew = dryRun
                ? !(await ScoreHistoryService.isDuplicate({
                    gameName: round.name, gameRoomId: tournament.game_room_id,
                    gameId: round.id, username: row.user_name, score,
                }))
                : await this.writeScore(row, round, tournament, canonical, at);

            if (isNew) { result.ingested++; affected.add(round.id); record('ingested', round, canonical); }
            else { result.duplicates++; record('duplicate', round, canonical); }
        }

        result.unmatchedGameIds = [...unmatched];
        // A dry run must never claim it changed anything — the caller emits a
        // leaderboard refresh off this list.
        result.affectedGameIds = dryRun ? [] : [...affected];
        logInfo(
            `AtGames sync${dryRun ? ' (DRY RUN)' : ''}: tournament ${tournamentId} <- AtGames ${tournament.atgames_tournament_id} — ` +
            `${result.ingested} new, ${result.duplicates} already had, ${result.outOfWindow} out of window, ` +
            `${result.unmatchedGame} with no matching round, ${result.unlinkedAccounts} from unlinked accounts`,
        );
        if (unmatched.size > 0) {
            logWarn(
                `AtGames sync: AtGames game id(s) ${[...unmatched].join(', ')} are in the AtGames tournament but ` +
                `match no round of Arcaid tournament ${tournamentId} — check the catalogue rows carry the right atgames_id`,
            );
        }
        return result;
    }

    /**
     * Resolves what the host typed into a numeric AtGames tournament id.
     *
     * Hosts paste the INVITATION CODE at least as often as the id — the code
     * is the thing AtGames shows players, while the id only appears in the
     * address bar (the first live test stored `9CTQSJF`, 2026-08-25). A
     * non-numeric value is matched against the account's own tournament list
     * by invitation code or name, and the numeric id is written back so the
     * next sync skips the list call.
     */
    private static async resolveAtGamesId(
        client: AtGamesPrivateClient,
        tournamentId: string,
        stored: string,
    ): Promise<string> {
        const trimmed = stored.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;

        const list = await client.listPrivateTournaments();
        const needle = trimmed.toLowerCase();
        const match = list.find(t => (t.invitationCode ?? '').toLowerCase() === needle)
            ?? list.find(t => t.name.toLowerCase() === needle);
        if (!match) {
            throw new AtGamesSyncError(
                'NOT_FOUND',
                `"${trimmed}" matches no tournament on this AtGames account — paste the number from the tournament's address on atgames.net, or its invitation code`,
            );
        }

        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET atgames_tournament_id = ?, atgames_invite_code = COALESCE(atgames_invite_code, ?)
              WHERE id = ?`,
            String(match.id), match.invitationCode ?? null, tournamentId,
        );
        logInfo(`AtGames sync: resolved "${trimmed}" to tournament ${match.id} ("${match.name}") and stored the id`);
        return String(match.id);
    }

    /**
     * Creates the AtGames private tournament FOR an Arcaid event, so a host
     * never has to leave Arcaid to set one up (owner-asked, 2026-08-25).
     *
     * The AtGames window is the event's whole span — first round start to last
     * round end plus the grace — because AtGames has one window per tournament
     * while an Arcaid event has one per round. Arcaid's per-round windows stay
     * the arbiter at ingest; the AtGames window just has to CONTAIN them.
     */
    static async createForTournament(tournamentId: string): Promise<{
        atgamesTournamentId: string;
        inviteCode: string | null;
        name: string;
        start: string;
        end: string;
        gameIds: number[];
    }> {
        const db = await getDatabase();
        const tournament = await db.get<TournamentRow & { name: string }>(
            `SELECT id, name, game_room_id, format, atgames_tournament_id, end_grace_sec
             FROM tournaments WHERE id = ?`,
            tournamentId,
        );
        if (!tournament) throw new AtGamesSyncError('NOT_FOUND', 'Tournament not found');
        if (tournament.atgames_tournament_id) {
            throw new AtGamesSyncError(
                'NOT_LINKED',
                'This event is already linked to an AtGames tournament — clear the id first to create a fresh one',
            );
        }
        if (!tournament.game_room_id) {
            throw new AtGamesSyncError('NO_ROOM', 'AtGames sync needs a game room (the AtGames account is a room setting)');
        }

        const creds = await getAtGamesCredsForRoom(tournament.game_room_id);
        if (!creds) {
            throw new AtGamesSyncError(
                'NO_CREDENTIALS',
                'This room has no AtGames account configured (set ATGAMES_EMAIL and ATGAMES_PASSWORD)',
            );
        }

        const rounds = await db.all<RoundRow[]>(
            `SELECT id, name, round_no, scheduled_start_at, scheduled_end_at
             FROM games WHERE tournament_id = ? AND round_no IS NOT NULL ORDER BY round_no ASC`,
            tournamentId,
        );
        if (rounds.length === 0) {
            throw new AtGamesSyncError('NOT_FOUND', 'This event has no rounds yet — add rounds before creating the AtGames tournament');
        }

        const roundsByGameId = await this.mapRoundsToAtGamesIds(rounds);
        const gameIds = [...roundsByGameId.keys()];
        if (gameIds.length === 0) {
            // Naming the games beats "0 gameIds": the fix is a catalogue sync
            // or picking the table from the suggestions, and the host needs to
            // know WHICH name failed to resolve.
            const names = [...new Set(rounds.map(r => r.name))].join(', ');
            throw new AtGamesSyncError(
                'NOT_FOUND',
                `None of this event's games (${names}) are AtGames-linked in the catalogue — run "Sync AtGames" on the catalogue, or check the round names match the library entries`,
            );
        }

        const startMs = Math.min(...rounds.map(r => Date.parse(r.scheduled_start_at ?? '')));
        const endMs = Math.max(...rounds.map(r => Date.parse(r.scheduled_end_at ?? '')));
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            throw new AtGamesSyncError('NOT_FOUND', 'This event\'s rounds have no scheduled windows');
        }
        const endWithGraceMs = endMs + eventEndGraceSec(tournament) * 1000;
        // AtGames refuses a start date in the past (the live 400 of 2026-08-26:
        // the owner pressed Create while round 1 was already running; the
        // owner's own successful manual create — whose cURL confirmed our
        // field names and ISO format exactly — used a future window). Clamp
        // forward: Arcaid's per-round windows arbitrate at ingest anyway, so
        // the AtGames window only has to CONTAIN what remains of the event.
        const nowMs = Date.now();
        if (endWithGraceMs <= nowMs + 120_000) {
            throw new AtGamesSyncError('NOT_FOUND', 'This event is already over — there is nothing left for an AtGames tournament to cover');
        }
        const start = new Date(Math.max(startMs, nowMs + 60_000)).toISOString();
        const end = new Date(endWithGraceMs).toISOString();

        const client = new AtGamesPrivateClient(creds);
        const created = await client.createPrivateTournament({
            name: tournament.name, startDate: start, endDate: end, gameIds,
        });

        await db.run(
            `UPDATE tournaments SET atgames_tournament_id = ?, atgames_invite_code = ? WHERE id = ?`,
            String(created.id), created.invitationCode ?? null, tournamentId,
        );
        logInfo(
            `AtGames: created private tournament ${created.id} for event ${tournamentId} ` +
            `(${gameIds.length} game(s), ${start} -> ${end})`,
        );
        return {
            atgamesTournamentId: String(created.id),
            inviteCode: created.invitationCode ?? null,
            name: tournament.name,
            start, end, gameIds,
        };
    }

    /**
     * Builds `AtGames game id -> rounds playing that game`.
     *
     * The join runs through the catalogue: a round's `games.name` matches a
     * `global_games` row, and that row carries `atgames_id` from the AtGames
     * importer. That is the whole reason the importer chases AtGames' stable
     * game id — without it this mapping would be a name comparison against a
     * third party's spelling.
     */
    private static async mapRoundsToAtGamesIds(rounds: RoundRow[]): Promise<Map<number, RoundRow[]>> {
        const byGameId = new Map<number, RoundRow[]>();
        if (rounds.length === 0) return byGameId;

        const db = await getDatabase();
        const names = [...new Set(rounds.map(r => r.name.toLowerCase()))];
        const placeholders = names.map(() => '?').join(', ');
        const catalogue = await db.all<Array<{ name: string; atgames_id: string | number | null }>>(
            `SELECT name, atgames_id FROM global_games
             WHERE atgames_id IS NOT NULL AND LOWER(name) IN (${placeholders})`,
            ...names,
        );

        const atgamesIdByName = new Map<string, number>();
        for (const row of catalogue) {
            const id = Number(row.atgames_id);
            if (Number.isFinite(id)) atgamesIdByName.set(row.name.toLowerCase(), id);
        }

        for (const round of rounds) {
            const id = atgamesIdByName.get(round.name.toLowerCase());
            if (id == null) continue;
            const list = byGameId.get(id) ?? [];
            list.push(round);
            byGameId.set(id, list);
        }
        return byGameId;
    }

    /**
     * Writes one AtGames score. Returns false when the dedup swallowed it.
     *
     * `device` is always the AtGames cabinet. `engine` is NOT — an AtGames
     * cabinet runs VPX, Zen FX, Zaccaria and AtGames-native tables, so it is
     * taken from the catalogue row when that row names exactly one engine and
     * left `'unknown'` otherwise. Guessing an engine here would put a score in
     * the wrong comparability bucket, which ADR 0016 exists to prevent.
     *
     * `createdAt` is ATGAMES' timestamp, not now (v2.145.0). Exit-to-submit
     * means that instant is when the player left the table, so it is both the
     * honest submit time for `elapsed_sec` and the join key the Witness
     * verify-join needs (`exit_ts ≈ created_at`). Stamping the host's "Pull
     * scores" click instead — which is what the default did — made every
     * ingested row claim to have arrived whenever the host got round to it.
     */
    private static async writeScore(
        row: AtGamesRanking,
        round: RoundRow,
        tournament: TournamentRow,
        canonicalUserId: string | null,
        atMs: number,
    ): Promise<boolean> {
        const engine = await this.resolveEngine(round.name);
        const score = typeof row.score === 'number' ? row.score : Number(row.score);

        const id = await ScoreHistoryService.log({
            gameName: round.name,
            gameRoomId: tournament.game_room_id,
            gameId: round.id,
            username: row.user_name,
            // The synthetic id is what makes a later link able to find and
            // re-attribute these rows; `normalizeSubmitterUserId` keeps it out
            // of `submitted_by_user_id`, which only ever holds a real account.
            discordUserId: canonicalUserId ?? `atgames:${row.account}`,
            score,
            source: 'atgames',
            tournamentId: tournament.id,
            platform: 'atgames',
            engine,
            device: 'atgames',
            createdAt: toSqliteUtc(atMs),
        });
        return id != null;
    }

    /** The catalogue row's engine when it names exactly one, else `'unknown'`. */
    private static async resolveEngine(gameName: string): Promise<string> {
        try {
            const db = await getDatabase();
            const row = await db.get<{ platforms: string | null }>(
                `SELECT platforms FROM global_games WHERE LOWER(name) = LOWER(?) LIMIT 1`,
                gameName,
            );
            if (!row?.platforms) return 'unknown';
            const parsed: unknown = JSON.parse(row.platforms);
            if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
                return parsed[0];
            }
            return 'unknown';
        } catch (err) {
            logError(`AtGames sync: could not resolve an engine for "${gameName}"`, err);
            return 'unknown';
        }
    }
}

