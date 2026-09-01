import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { eventEndGraceSec } from './EventSubmissionGate.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { parseTournamentRules } from '../utils/platformRules.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * VPXS auto score collection — the Arcaid Witness reads the VPX launcher's own
 * score records off the cabinet stick and posts them here.
 *
 * ## Where these scores come from
 *
 * VPX on an AtGames cabinet runs under the third-party vpx-standalone launcher,
 * which keeps `scoreserver/vpx-<table>-games.jsonl`: one signed record per
 * COMPLETED GAME with per-player scores, ball-by-ball timestamps, the start and
 * end of the game, and why it ended. The Witness lives on the same partition
 * and reads it. AtGames never sees any of this — VPX tables are not in their
 * catalogue and cannot be in an AtGames tournament — so this path is the ONLY
 * way a VPXS score reaches Arcaid without somebody typing it.
 *
 * ## Why the ingest rule mirrors AtGames exactly
 *
 * A score is matched into a round by WHEN THE GAME ENDED, which is the same
 * rule the AtGames path uses (there, exit-to-submit makes the AtGames stamp the
 * end of play). Doing it any other way would give two sources on one board two
 * different definitions of "inside the round".
 *
 * That is deliberate even though these records ALSO carry the game's start, and
 * we could therefore refuse a game that began before the round opened. We do
 * not: ADR 0020/0021 settled that witness evidence is a HOST-FACING BADGE and
 * never a gate. An early start is surfaced as `flagged` by
 * `WitnessVerifyService`, where a human decides — the ingest layer stays a
 * recorder.
 *
 * ## What it refuses to guess
 *
 * - **Player 2+.** The launcher records every player of a multiplayer game, but
 *   the cabinet has one paired account, and FINDINGS-0s showed its own
 *   `accountName` is stamped on every row regardless of who played. Attributing
 *   another human's ball to the stick's owner is worse than not having it, so
 *   only the single-player case is ingested (the device sends nothing else).
 * - **Which game this is, when two could match.** Two equally plausible targets
 *   is never a coin flip — the score goes to the global record instead.
 * - **Rooms the player is not in.** Candidates are scoped to rooms they belong
 *   to, plus room-less events they are a participant of.
 *
 * ## Where a score goes (P9b routing)
 *
 * The player points each paired cabinet at a room, and optionally at one
 * tournament in it (Account Settings → paired cabinets). That designation is
 * what removes the ambiguity a name match cannot: two tournaments running the
 * same table in one room are indistinguishable from a score record alone.
 *
 *   1. **Designated** → only that room's games (narrowed further by the
 *      tournament, when set) are candidates.
 *   2. **Undesignated** → only EVENT ROUNDS of events the player is a
 *      PARTICIPANT of. Joining an event is a deliberate act about one
 *      time-boxed competition, so it carries the consent a designation would
 *      otherwise supply. Rotation tournaments run for days with no such act,
 *      so they require the designation — otherwise playing at home would
 *      quietly enter somebody into a competition.
 *   3. **Anything left over** → the **Global Scoreboard**, so a player who has
 *      configured nothing can still fire up any table and have it count for
 *      their own record. This is the default, not a failure mode; the only
 *      thing that stops it is the per-cabinet `globalFallback` switch, or a
 *      table the catalogue does not know.
 */

export type VpxScoreInput = {
    canonicalUserId: string;
    /** Best display name the device could resolve (session journal > rom > slug). */
    tableName: string;
    rom?: string | null;
    slug?: string | null;
    score: number;
    /** Epoch seconds, the launcher's clock. */
    startedTs: number;
    endedTs: number;
    durationSec?: number | null;
    /** `game_over` | `shutdown` — carried for the log, never a filter here. */
    reason?: string | null;
    /**
     * The cabinet's own routing (P9b), read from `witness_devices`. A null room
     * means UNDESIGNATED, which is not an error state — it is the default, and
     * it routes to the Global Scoreboard.
     */
    target?: {
        roomId: string | null;
        tournamentId: string | null;
        globalFallback: boolean;
    };
};

export type VpxIngestResult = {
    /**
     * `'global'` — recorded on the Global Scoreboard rather than a tournament
     * board. That is the DEFAULT destination for an undesignated cabinet, not a
     * failure: a player who has configured nothing can still fire up any table
     * and have it count towards their own record.
     */
    status: 'ingested' | 'duplicate' | 'global' | 'global_duplicate' | 'no_match' | 'invalid';
    reason?: string;
    gameId?: string;
    gameName?: string;
    gameRoomId?: string | null;
    tournamentId?: string | null;
};

type CandidateRow = {
    id: string;
    name: string;
    status: string;
    round_no: number | null;
    scheduled_start_at: string | null;
    scheduled_end_at: string | null;
    start_date: string | null;
    tournament_id: string | null;
    game_room_id: string | null;
    format: string | null;
    end_grace_sec: number | null;
    platform_rules: string | null;
    is_participant: number;
};

/**
 * Match keys for one or more names: the catalogue normal form, plus a
 * SQUASHED form with the spaces taken out.
 *
 * The squashed form exists for the launcher's folder slugs, which are the
 * table name with every separator removed — `vpx-badcats` for "Bad Cats",
 * `vpx-aaronspelling` for "Aaron Spelling". Normalising alone would never
 * match those, and the slug is sometimes the only name a record has that
 * resembles what the room called the game.
 */
function nameKeys(names: string[]): Set<string> {
    const keys = new Set<string>();
    for (const name of names) {
        const normal = normalizeGameName(name || '');
        if (!normal) continue;
        keys.add(normal);
        const squashed = normal.replace(/[\s-]+/g, '');
        if (squashed) keys.add(squashed);
    }
    return keys;
}

function epochOf(value: string | null | undefined): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** SQLite's own datetime shape (`YYYY-MM-DD HH:MM:SS`, UTC, no zone). */
function toSqliteUtc(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export class VpxScoreIngestService {
    static async ingest(input: VpxScoreInput): Promise<VpxIngestResult> {
        const score = Math.floor(Number(input.score));
        if (!Number.isFinite(score) || score <= 0) {
            return { status: 'invalid', reason: 'score is not a positive number' };
        }
        if (!Number.isFinite(input.endedTs) || input.endedTs <= 0) {
            return { status: 'invalid', reason: 'game end timestamp missing' };
        }

        // The device sends up to three names for the same table and any of them
        // may be the one the room used: the session journal's catalogue-grade
        // display name ("Bad Cats (Williams 1989)"), the record's `rom` (a
        // PinMAME id for real machines, free text for originals, occasionally
        // simply wrong — FINDINGS-0s), and the folder slug. Normalising all
        // three and accepting a hit on any is what makes the match survive
        // that heterogeneity.
        const needles = nameKeys([
            input.tableName,
            input.rom ?? '',
            (input.slug ?? '').replace(/^vpx-/, '').replace(/[-_]+/g, ' '),
        ]);
        if (needles.size === 0) {
            return { status: 'no_match', reason: 'no usable table name on the record' };
        }

        const routing = input.target ?? { roomId: null, tournamentId: null, globalFallback: true };
        const candidates = (await VpxScoreIngestService.loadCandidates(input.canonicalUserId))
            .filter(row => VpxScoreIngestService.inScope(row, routing));
        const matches = candidates
            .filter(row => [...nameKeys([row.name])].some(key => needles.has(key)))
            .filter(row => VpxScoreIngestService.inWindow(row, input.endedTs))
            .filter(row => !VpxScoreIngestService.engineExcluded(row));

        if (matches.length === 0) {
            // Nothing this cabinet is pointed at wanted the score — so it goes
            // to the player's own Global Scoreboard record instead of nowhere.
            if (routing.globalFallback) {
                return VpxScoreIngestService.recordGlobal(input, score, needles);
            }
            return { status: 'no_match', reason: `no open game matched "${input.tableName}"` };
        }
        // An event ROUND is the more specific claim: it has an explicit window
        // this score fell inside, where a rotation game is merely open. When
        // both match the same table, the round wins.
        const rounds = matches.filter(m => m.round_no != null);
        const pool = rounds.length > 0 ? rounds : matches;
        if (pool.length > 1) {
            // Still ambiguous even inside the designated scope. The designation
            // exists to make this vanishingly rare; when it happens anyway the
            // score is not thrown away, it goes to the global record.
            if (routing.globalFallback) {
                logWarn(
                    `VPX ingest: "${input.tableName}" matched ${pool.length} open games for ` +
                    `${input.canonicalUserId} — sending to the Global Scoreboard instead of guessing`,
                );
                return VpxScoreIngestService.recordGlobal(input, score, needles);
            }
            return {
                status: 'no_match',
                reason: `"${input.tableName}" matches ${pool.length} open games — not guessing which`,
            };
        }
        const target = pool[0]!;

        const username = await VpxScoreIngestService.resolvePlayerName(
            input.canonicalUserId, target.game_room_id,
        );

        const id = await ScoreHistoryService.log({
            gameName: target.name,
            gameRoomId: target.game_room_id,
            gameId: target.id,
            username,
            discordUserId: input.canonicalUserId,
            score,
            source: 'vpx',
            tournamentId: target.tournament_id ?? null,
            platform: 'vpxs',
            // Provenance is KNOWN here, unlike an iScored sync: the engine is
            // VPX by construction (the record came out of the VPX launcher) and
            // the device is the cabinet the Witness is paired to.
            engine: 'vpx',
            device: 'atgames',
            // The launcher's timestamp, not ours — the same discipline the
            // AtGames path follows, and what makes the witness join possible.
            createdAt: toSqliteUtc(Math.floor(input.endedTs)),
        });

        if (id == null) {
            return {
                status: 'duplicate', gameId: target.id, gameName: target.name,
                gameRoomId: target.game_room_id, tournamentId: target.tournament_id,
            };
        }

        logInfo(
            `VPX ingest: ${username} ${score} on "${target.name}" ` +
            `(${target.round_no != null ? `round ${target.round_no}` : 'rotation'}, ` +
            `tournament ${target.tournament_id ?? 'none'}, reason=${input.reason ?? 'unknown'})`,
        );
        return {
            status: 'ingested', gameId: target.id, gameName: target.name,
            gameRoomId: target.game_room_id, tournamentId: target.tournament_id,
        };
    }

    /**
     * The fallback destination: the player's own Global Scoreboard record.
     *
     * ## Why this is allowed to exist at all
     *
     * ADR 0016 P2 bars iScored-SYNCED scores from the Global Scoreboard, and
     * that rule is untouched — it exists because a synced score's provenance is
     * unknowable, so it would pollute engine-comparable boards. A witness score
     * is the opposite case: engine and device are known exactly (it came out of
     * the VPX launcher on a cabinet paired to this account), the identity is a
     * real linked account, and the evidence behind it is stronger than the photo
     * a manual global submit requires. So it qualifies on the merits the ADR
     * actually names.
     *
     * ## The one hard constraint
     *
     * `global_scores.global_game_id` is NOT NULL and references the catalogue.
     * A table that is not in `global_games` therefore CANNOT be recorded
     * globally — there is nothing to attach it to. That is reported honestly
     * (`no_match` with a reason) rather than papered over by inventing a
     * catalogue row from a launcher's free-text name.
     */
    private static async recordGlobal(
        input: VpxScoreInput, score: number, needles: Set<string>,
    ): Promise<VpxIngestResult> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string; name: string; manufacturer: string | null; year: number | null }>>(
            `SELECT id, name, manufacturer, year FROM global_games WHERE status = 'approved'`,
        );
        let candidates = rows.filter(row => [...nameKeys([row.name])].some(key => needles.has(key)));

        if (candidates.length > 1) {
            // The session journal's name carries the manufacturer and year in a
            // parenthetical ("Bad Cats (Williams 1989)") — exactly what tells
            // two same-named machines apart. Use it when it is there.
            const hint = /\(([^)]*?)(\d{4})\)/.exec(input.tableName || '');
            if (hint) {
                const maker = hint[1]!.trim().toLowerCase();
                const year = Number(hint[2]);
                const narrowed = candidates.filter(row =>
                    (!maker || (row.manufacturer ?? '').toLowerCase().includes(maker))
                    && (!year || row.year === year));
                if (narrowed.length > 0) candidates = narrowed;
            }
        }
        if (candidates.length !== 1) {
            return {
                status: 'no_match',
                reason: candidates.length === 0
                    ? `"${input.tableName}" is not in the Arcaid catalogue`
                    : `"${input.tableName}" matches ${candidates.length} catalogue games`,
            };
        }
        const game = candidates[0]!;

        const username = await VpxScoreIngestService.resolvePlayerName(input.canonicalUserId, null);

        // Idempotency: the device retries a report whose answer it never saw,
        // and a re-pull re-reads the same jsonl lines. Global has no
        // ScoreHistoryService.isDuplicate of its own, so the same predicate is
        // spelled out here — (player, game, score) already present is a no-op.
        const existing = await db.get<{ id: string }>(
            `SELECT id FROM global_scores
              WHERE global_game_id = ? AND player_id = ? AND score = ? AND deleted_at IS NULL
              LIMIT 1`,
            game.id, input.canonicalUserId, score,
        );
        if (existing) {
            return { status: 'global_duplicate', gameName: game.name };
        }

        const { GlobalScoreService } = await import('./GlobalScoreService.js');
        try {
            await GlobalScoreService.submit({
                globalGameId: game.id,
                playerId: input.canonicalUserId,
                iscoredUsername: username,
                score,
                originType: 'global',
                platform: 'vpxs',
                engine: 'vpx',
                device: 'atgames',
            });
        } catch (err) {
            // `submit` throws BANNED for a banned identity (it ban-checks every
            // non-room origin). A banned player's cabinet must fail quietly:
            // the device is told the request was handled, and nothing lands.
            const message = err instanceof Error ? err.message : String(err);
            if (message === 'BANNED') {
                return { status: 'no_match', reason: 'account is not eligible' };
            }
            throw err;
        }

        logInfo(
            `VPX ingest -> Global Scoreboard: ${username} ${score} on "${game.name}" ` +
            `(undesignated cabinet, reason=${input.reason ?? 'unknown'})`,
        );
        return { status: 'global', gameName: game.name };
    }

    /**
     * Everything this player could plausibly be scoring on right now: event
     * rounds of events they are in, and ACTIVE rotation games in their rooms.
     *
     * Pinned (tournament-less) boards are deliberately NOT candidates — they
     * have no window and no tournament, so an auto-ingest into one would be a
     * permanent, unbounded write triggered by ordinary play at home.
     */
    private static async loadCandidates(canonicalUserId: string): Promise<CandidateRow[]> {
        const db = await getDatabase();
        return db.all<CandidateRow[]>(
            `SELECT g.id, g.name, g.status, g.round_no, g.scheduled_start_at, g.scheduled_end_at,
                    g.start_date, g.tournament_id, g.game_room_id,
                    t.format, t.end_grace_sec, t.platform_rules,
                    EXISTS (
                        SELECT 1 FROM tournament_participants tp
                         WHERE tp.tournament_id = g.tournament_id AND tp.user_id = ?
                    ) AS is_participant
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
              WHERE t.is_active = 1
                AND (
                        (t.format = 'event' AND g.round_no IS NOT NULL)
                     OR (g.status = 'ACTIVE' AND (t.format IS NULL OR t.format = 'rotation'))
                    )
                AND (
                        (g.game_room_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM room_members rm
                             WHERE rm.room_id = g.game_room_id AND rm.user_id = ?
                        ))
                     OR EXISTS (
                            SELECT 1 FROM tournament_participants tp
                             WHERE tp.tournament_id = g.tournament_id AND tp.user_id = ?
                        )
                    )`,
            canonicalUserId, canonicalUserId, canonicalUserId,
        );
    }

    /**
     * Does this candidate lie inside what the cabinet is pointed at?
     *
     * The routing model, in one place (P9b):
     *
     * - **Designated room** — only that room's games are candidates. A
     *   designated TOURNAMENT narrows it further, which is what makes two
     *   tournaments running the same table in one room resolvable at all.
     * - **Undesignated** — only EVENT ROUNDS are candidates, and only of events
     *   the player is a participant of. Joining an event is itself a deliberate
     *   act about a specific, time-boxed competition, so it carries the consent
     *   a designation would otherwise supply. **Rotation tournaments require a
     *   designation**: they run for days with no per-session act, and quietly
     *   entering somebody into one because they played at home is a surprise
     *   nobody asked for.
     *
     * Everything that falls outside goes to the Global Scoreboard.
     */
    private static inScope(row: CandidateRow, target: {
        roomId: string | null; tournamentId: string | null;
    }): boolean {
        if (target.roomId) {
            if (row.game_room_id !== target.roomId) return false;
            if (target.tournamentId && row.tournament_id !== target.tournamentId) return false;
            return true;
        }
        return row.round_no != null && row.is_participant === 1;
    }

    /** Did this game END inside the target's window? */
    private static inWindow(row: CandidateRow, endedTs: number): boolean {
        if (row.round_no != null) {
            const start = epochOf(row.scheduled_start_at);
            const end = epochOf(row.scheduled_end_at);
            if (start == null || end == null) return false;
            return endedTs >= start && endedTs <= end + eventEndGraceSec(row);
        }
        // A rotation game is open-ended; the only bound that means anything is
        // that the score cannot predate the game going up on the board.
        const activated = epochOf(row.start_date);
        return activated == null || endedTs >= activated;
    }

    /**
     * Tournament rules are two-axis (ADR 0016 P2 / ADR 0009). Only the EXCLUDED
     * axis applies to a submission — `required` decides which games are
     * eligible for the tournament, never which platforms may score on them —
     * so a VPX score is refused exactly when the tournament excludes VPX.
     */
    private static engineExcluded(row: CandidateRow): boolean {
        const rules = parseTournamentRules(row.platform_rules, row.tournament_id ?? undefined);
        const excludedEngines = rules.engines?.excluded ?? [];
        const excludedDevices = rules.devices?.excluded ?? [];
        return excludedEngines.includes('vpx') || excludedDevices.includes('atgames');
    }

    /**
     * The name this score should carry on the board: the player's claimed name
     * in that room first (first-claim-wins is what every other score of theirs
     * in this room already uses), then their global display name.
     */
    private static async resolvePlayerName(
        canonicalUserId: string, gameRoomId: string | null,
    ): Promise<string> {
        const db = await getDatabase();
        if (gameRoomId) {
            const member = await db.get<{ display_name: string | null }>(
                `SELECT display_name FROM room_members WHERE room_id = ? AND user_id = ?`,
                gameRoomId, canonicalUserId,
            ).catch(() => undefined);
            if (member?.display_name) return member.display_name;
        }
        const profile = await db.get<{ display_name: string | null; username: string | null }>(
            `SELECT display_name, username FROM user_profiles WHERE discord_user_id = ?`,
            canonicalUserId,
        ).catch(() => undefined);
        if (profile?.display_name) return profile.display_name;
        if (profile?.username) return profile.username;
        // Never invent a friendly-looking name: the id is at least true, and a
        // linked account renders through the profile resolver anyway.
        logWarn(`VPX ingest: no display name for ${canonicalUserId} — falling back to the id`);
        return canonicalUserId;
    }
}
