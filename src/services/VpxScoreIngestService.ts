import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { eventEndGraceSec } from './EventSubmissionGate.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { parseTournamentRules } from '../utils/platformRules.js';
import { logInfo, logWarn } from '../utils/logger.js';
import type { WitnessDeviceType } from './WitnessService.js';
import { tournamentFinishedSql } from '../utils/openCard.js';
import { deviceRoutesTo } from '../utils/witnessRouting.js';
import { entryAllowed, entryRefusal, normalizeEntryMode } from '../utils/tournamentEntry.js';
import {
    evaluateSanctioned, normalizeIntegrityMode, normalizeSanctionedRules,
    type IntegrityMode, type Verdict, type WitnessEvidence,
} from '../utils/sanctionedRules.js';

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
 *
 * ## Integrity mode (v2.165.0, ADR 0027; Castcade ADR 0005)
 *
 * The Castcade companion sends EVIDENCE with every score (`evidence` below:
 * the VPS game/table ids, the table hash, the settings in force, the machine
 * adjustments, the builds). Two things happen with it, in both modes:
 *
 * - **Matching prefers the VPS game id.** `vps_game` resolves to the catalogue
 *   row and that row's names (plus any `games.global_game_id` that points at
 *   it) are tried BEFORE the device's own names, so a room that called the
 *   game by a different spelling still matches. The name match stays as the
 *   fallback, so every pre-0.2.4 companion and every cabinet keeps working.
 * - **The Sanctioned rules are evaluated and the verdict stored** with the
 *   score (`witness_evidence`). In an OPEN tournament the verdict is a badge
 *   for the runner and nothing else. In a SANCTIONED tournament a `flagged`
 *   verdict means the score is NOT written to that tournament's board — it
 *   answers `not_sanctioned` with the reasons and falls through to the Global
 *   record exactly as an unmatched score would. That is the ONE gate in this
 *   file, it applies only to the auto-ingest into a tournament that opted in,
 *   and room boards never filter or re-rank on it (ADR 0017/0020/0021).
 */

export type VpxScoreInput = {
    canonicalUserId: string;
    /**
     * What kind of machine posted this (v2.163.0): `'atgames'` is the cabinet
     * Witness (device `atgames`, legacy platform `vpxs`), `'desktop'` is the
     * Castcade companion on a Windows VPX rig (device `pc`, legacy platform
     * `vpx`). Read off `witness_devices.device_type` at authentication and
     * threaded here so provenance is never inferred from the table or the
     * name (ADR 0016). Absent = cabinet, the pre-v2.163.0 contract.
     */
    deviceType?: WitnessDeviceType;
    /** v2.166.0 — `pc` or `vr_headset` from a desktop witness; null/absent = `pc`. Ignored from a cabinet. */
    playDevice?: PlayDevice | null;
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
     * The device's own routing, read from `witness_devices`
     * (`WitnessService.getDeviceTarget`). v2.175.0 (W37): a null room means
     * ALL MY ROOMS (the default) unless `globalOnly` is set.
     */
    target?: {
        roomId: string | null;
        tournamentId: string | null;
        globalOnly?: boolean;
        globalFallback: boolean;
    };
    /** The posting device's id — the evidence trail is keyed on it (v2.165.0). */
    deviceId?: string | null;
    /**
     * What the Castcade companion measured for this score (v2.165.0, ADR
     * 0027): identity, settings, adjustments, builds. Null from a cabinet or
     * an older companion. Decides nothing on its own; see the class comment.
     */
    evidence?: WitnessEvidence | null;
    /**
     * v2.167.0 (ADR 0029) — the `key` of the game START the companion
     * reported over `/witness/attempt` for this game (`attempt=<key>` on the
     * score call). Only consulted when the matched tournament limits attempts.
     */
    attemptKey?: string | null;
    /**
     * v2.167.0 — a CABINET report's `restarts=N`: ball-one restarts before
     * this game in the same sitting, each an abandoned game start. Only read
     * when the matched tournament limits attempts.
     */
    restarts?: number | null;
    /**
     * v2.180.0 (W48) — the launcher's per-ball points for this game, raw, in
     * ball order (cabinet 1.0.6+ `balls=`). Stored on the evidence trail for a
     * later per-ball format; nothing here reads it.
     */
    ballPoints?: number[] | null;
    /**
     * v2.189.0 (W49, castcade B16) — the game was quit before game over
     * (`quit=1`, `quit_ball=<n>`), or reached it (`quit=0`); null/absent =
     * unknown. Stored on the evidence trail and badged on the board; a quit
     * game still counts and still uses its attempt — nothing here gates.
     */
    quit?: import('../utils/quitEvidence.js').QuitEvidence | null;
};

/** See `VpxScoreIngestService.provenanceFor`. */
export type WitnessProvenance = {
    platform: 'vpxs' | 'vpx';
    engine: 'vpx';
    device: 'atgames' | 'pc' | 'vr_headset';
};

/**
 * v2.166.0 — how a DESKTOP witness says the game was displayed: on the monitor
 * (`pc`) or in a headset (`vr_headset`). The Castcade companion measures it
 * (the VR build only turns VR on when a headset is present, so the companion
 * looks for the OpenVR runtime inside the VPX process plus the SteamVR
 * compositor beside it) and sends `play_device`. Same trust as the rest of
 * what the companion reports; a cabinet never sends it and it is ignored
 * from one.
 */
export type PlayDevice = 'pc' | 'vr_headset';
export function parsePlayDevice(value: unknown): PlayDevice | null {
    return value === 'pc' || value === 'vr_headset' ? value : null;
}

export type VpxIngestResult = {
    /**
     * `'global'` — recorded on the Global Scoreboard rather than a tournament
     * board. That is the DEFAULT destination for an undesignated cabinet, not a
     * failure: a player who has configured nothing can still fire up any table
     * and have it count towards their own record.
     */
    /**
     * `'suppressed'` (v2.156.0, ADR 0024) — the player deleted this exact play
     * and the cabinet is replaying it. Nothing is written anywhere, and the
     * wire answer to the device is `'duplicate'` (a status its contract
     * already knows), never a new value.
     */
    /**
     * `'not_sanctioned'` (v2.165.0, ADR 0027) — the score matched a tournament
     * in Sanctioned play and failed its rules, so it was NOT written to that
     * board. `reasons` says why; `fallback` is what happened to it instead
     * (the Global record, when the device allows it).
     */
    /**
     * `'attempt_refused'` (v2.167.0, ADR 0029) — the score matched a tournament
     * that limits attempts and did not belong to a counted, on-time game
     * start. Wired exactly like `not_sanctioned`: `reasons` says why for the
     * player, `reason` is the machine reason, `fallback` what happened instead.
     */
    status: 'ingested' | 'duplicate' | 'global' | 'global_duplicate' | 'no_match' | 'invalid' | 'suppressed' | 'not_sanctioned' | 'attempt_refused';
    reason?: string;
    /**
     * W27 (ADR 0033 §5) — on a play that went to Global (or nowhere) after
     * matching an open tournament game it could not count in: why, in words a
     * player can act on ("you are not checked in to …"). Sent on the wire as
     * `notCounted`.
     */
    notCounted?: string;
    gameId?: string;
    gameName?: string;
    gameRoomId?: string | null;
    tournamentId?: string | null;
    /** The integrity verdict when a tournament matched (both modes). */
    verdict?: 'pass' | 'flagged' | null;
    reasons?: string[];
    fallback?: 'global' | 'global_duplicate' | 'no_match' | 'suppressed' | null;
    /** The Global Scoreboard row this play landed on (fallback or fan-out), when known. */
    globalScoreId?: string | null;
    /** v2.167.0 — on an accepted score in a limited tournament: which attempt it was. */
    attempt?: { n: number; of: number; remaining: number };
    /**
     * v2.175.0 (W37, ADR 0033): one play counts in EVERY tournament it matches
     * (one per tournament). Present when more than one was tried; the top-level
     * fields describe the first landing (or the first outcome when none landed),
     * which is all a pre-1.0.6 cabinet or older companion reads.
     */
    landed?: Array<{
        status: VpxIngestResult['status'];
        gameId?: string; gameName?: string; gameRoomId?: string | null; tournamentId?: string | null;
        attempt?: { n: number; of: number; remaining: number };
        reasons?: string[];
    }>;
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
    /** v2.165.0 — set on pinned games only; rotation/event rows leave it NULL. */
    global_game_id: string | null;
    integrity_mode: string | null;
    sanctioned_rules: string | null;
    required_vps_table_id: string | null;
    required_rom: string | null;
    required_fingerprint: string | null;
    /** v2.167.0 (ADR 0029) — the tournament's attempt limit; null = unlimited. */
    max_attempts: number | null;
    /** v2.175.0 (W37) — the player is a member of the game's room. */
    is_member: number;
    /** v2.175.0 (W37/W36) — the event requires check-in (`entryAllowed`). */
    checkin_required: number | null;
    /** v2.178.0 (W38) — players press Start attempts before plays count. */
    require_attempt_start: number | null;
    /** v2.179.0 (W39) — `members` | `invited` (ADR 0033 §6). */
    entry_mode: string | null;
    /** v2.179.0 (W39) — the player is on the tournament's roster. */
    on_roster: number;
    /** W27 — names for the "why it didn't count" reason. */
    tournament_name: string | null;
    room_name: string | null;
};

/** What `VpxScoreIngestService.match` decided. Shared by the score and the attempt calls. */
export type VpxMatchResult = {
    needles: Set<string>;
    routing: { roomId: string | null; tournamentId: string | null; globalOnly?: boolean; globalFallback: boolean };
    provenance: WitnessProvenance;
    catalogue: { id: string; keys: Set<string> } | null;
} & (
    | {
        kind: 'target';
        /** The first of `targets` — what a single-answer caller uses. */
        target: CandidateRow;
        where: { gameId: string; gameName: string; gameRoomId: string | null; tournamentId: string | null };
        /** v2.175.0 (W37): every tournament this play counts in, one game each, rounds first. */
        targets: CandidateRow[];
    }
    | {
        kind: 'none';
        /**
         * W27 (ADR 0033 §5) — why the play counts nowhere, when an open game of
         * that name exists for this player ("not checked in to …", "played after
         * … closed", "your device sends to …"); null when nothing of that name
         * is open to them at all.
         */
        reason: string | null;
    }
    | { kind: 'ambiguous'; count: number }
);

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
    /**
     * The three names the device sends for one table — journal display name,
     * `rom`, and the folder slug turned back into words. `nameKeys` (matching)
     * and the suppression check both start from this ONE list.
     */
    private static deviceNames(input: VpxScoreInput): string[] {
        return [
            input.tableName,
            input.rom ?? '',
            (input.slug ?? '').replace(/^vpx-/, '').replace(/[-_]+/g, ' '),
        ];
    }

    /** Was this exact play deleted by its owner? (ADR 0024 — the ONE predicate.) */
    private static async isSuppressedPlay(
        input: VpxScoreInput, score: number, names: string[], playedAt: string,
    ): Promise<boolean> {
        const { AutoScoreSuppressionService } = await import('./AutoScoreSuppressionService.js');
        const suppressed = await AutoScoreSuppressionService.isSuppressed({
            source: 'vpx',
            ownerKey: input.canonicalUserId,
            gameNames: names,
            score,
            playedAt,
        });
        if (suppressed) {
            logInfo(
                `VPX ingest: suppressed ${input.canonicalUserId} ${score} on "${input.tableName}" ` +
                `(ended ${playedAt}) — the player deleted this play`,
            );
        }
        return suppressed;
    }

    static async ingest(input: VpxScoreInput): Promise<VpxIngestResult> {
        // v2.167.1 — one device's reports run one at a time. The dedup in
        // `ScoreHistoryService.log` is a SELECT then an INSERT with no unique
        // index behind it, so four copies of one score arriving in the same
        // tick all pass the check and all write (the prod copies of
        // 2026-10-22 were 1–2 s apart and three were caught — luck, not
        // design). Chained per device, the second copy runs after the first
        // has written and is answered as the repeat it is. Different devices
        // never wait on each other; a failure releases the chain.
        const key = input.deviceId ?? `user:${input.canonicalUserId}`;
        const previous = VpxScoreIngestService.inflight.get(key) ?? Promise.resolve();
        const run = previous
            .then(() => VpxScoreIngestService.ingestNow(input))
            .then(result => VpxScoreIngestService.trailBackstop(input, result));
        const link: Promise<void> = run.then(() => undefined, () => undefined).finally(() => {
            if (VpxScoreIngestService.inflight.get(key) === link) VpxScoreIngestService.inflight.delete(key);
        });
        VpxScoreIngestService.inflight.set(key, link);
        return run;
    }

    /** v2.167.1 — the tail of each device's in-flight chain (see `ingest`). */
    private static readonly inflight = new Map<string, Promise<void>>();

    /** W29 — the inputs this process has already written a trail row for (see `trailBackstop`). */
    private static readonly trailed = new WeakSet<VpxScoreInput>();

    /**
     * W29 (v2.181.0) — every witness score leaves a trail row, whatever happened
     * to it. The per-board paths write their own rows (with the game, the
     * verdict, the score row); this catches every outcome that returned before
     * reaching one — an invalid score, no usable name, a deleted play, an
     * ambiguous match with no Global fallback, and any return added later — and
     * stores the server's reason with it, so "why didn't my score land?" is
     * answered from the database instead of the device's own log. Best-effort,
     * like `trail`: it never changes the answer.
     */
    private static async trailBackstop(input: VpxScoreInput, result: VpxIngestResult): Promise<VpxIngestResult> {
        if (VpxScoreIngestService.trailed.has(input)) return result;
        const raw = Math.floor(Number(input.score));
        const score = Number.isFinite(raw) ? raw : 0;
        const playedAt = Number.isFinite(input.endedTs) && input.endedTs > 0
            ? toSqliteUtc(Math.floor(input.endedTs))
            : toSqliteUtc(Math.floor(Date.now() / 1000));
        await VpxScoreIngestService.trail(input, score, playedAt, {
            outcome: result.status,
            gameId: result.gameId ?? null,
            tournamentId: result.tournamentId ?? null,
            gameRoomId: result.gameRoomId ?? null,
            globalScoreId: result.globalScoreId ?? null,
            reasons: result.reason ? [result.reason] : (result.reasons ?? []),
        });
        return result;
    }

    private static async ingestNow(input: VpxScoreInput): Promise<VpxIngestResult> {
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
        const deviceNames = VpxScoreIngestService.deviceNames(input);
        if (nameKeys(deviceNames).size === 0) {
            return { status: 'no_match', reason: 'no usable table name on the record' };
        }

        // v2.156.0 (ADR 0024) — a play the player DELETED stays deleted. The
        // cabinet replays up to seven days of score files whenever it restarts
        // or is re-paired, so this check runs before ANY destination is chosen:
        // a play deleted from a room board must not reappear on the Global
        // Scoreboard once the table has rotated off the card. Checked with the
        // three names the device sent (the same list `needles` is built from);
        // the room path adds the matched game's name and `recordGlobal` the
        // catalogue name, since either is what a delete there would have keyed.
        const playedAt = toSqliteUtc(Math.floor(input.endedTs));
        if (await VpxScoreIngestService.isSuppressedPlay(input, score, deviceNames, playedAt)) {
            return { status: 'suppressed', reason: 'the player deleted this score' };
        }

        const matched = await VpxScoreIngestService.match(input);
        const { needles: matchNeedles, routing } = matched;

        if (matched.kind === 'none') {
            // Nothing this cabinet is pointed at wanted the score — so it goes
            // to the player's own Global Scoreboard record instead of nowhere.
            if (routing.globalFallback) {
                return VpxScoreIngestService.recordGlobal(input, score, matchNeedles, { notCounted: matched.reason });
            }
            const reason = matched.reason ?? `no open game matched "${input.tableName}"`;
            await VpxScoreIngestService.trail(input, score, playedAt, { outcome: 'no_match', reasons: [reason] });
            return { status: 'no_match', reason };
        }
        if (matched.kind === 'ambiguous') {
            // Still ambiguous even inside the designated scope. The designation
            // exists to make this vanishingly rare; when it happens anyway the
            // score is not thrown away, it goes to the global record.
            if (routing.globalFallback) {
                logWarn(
                    `VPX ingest: "${input.tableName}" matched ${matched.count} open games for ` +
                    `${input.canonicalUserId} — sending to the Global Scoreboard instead of guessing`,
                );
                return VpxScoreIngestService.recordGlobal(input, score, matchNeedles);
            }
            return {
                status: 'no_match',
                reason: `"${input.tableName}" matches ${matched.count} open games — not guessing which`,
            };
        }
        // v2.175.0 (W37, ADR 0033): every tournament the play matches gets it,
        // each through the full per-board path below (repeat, attempts,
        // suppression, Sanctioned gate, write, fan-out, trail).
        const results: VpxIngestResult[] = [];
        for (const target of matched.targets) {
            results.push(await VpxScoreIngestService.landOn(input, score, playedAt, deviceNames, matched, target));
        }
        return VpxScoreIngestService.combine(results);
    }

    /**
     * v2.175.0 (W37) — one answer for a play that may have counted in several
     * tournaments. The top-level fields are the first LANDING (else the first
     * outcome), which is all an older device reads; `landed` lists every one.
     */
    private static combine(results: VpxIngestResult[]): VpxIngestResult {
        if (results.length === 1) return results[0]!;
        const primary = results.find(r => r.status === 'ingested') ?? results[0]!;
        return {
            ...primary,
            landed: results.map(r => ({
                status: r.status,
                gameId: r.gameId, gameName: r.gameName, gameRoomId: r.gameRoomId, tournamentId: r.tournamentId,
                ...(r.attempt ? { attempt: r.attempt } : {}),
                ...(r.reasons && r.reasons.length > 0 ? { reasons: r.reasons } : {}),
            })),
        };
    }

    /** Land one play on ONE matched tournament game (the pre-v2.175.0 single-target path). */
    private static async landOn(
        input: VpxScoreInput, score: number, playedAt: string, deviceNames: string[],
        matched: VpxMatchResult & { kind: 'target' }, target: CandidateRow,
    ): Promise<VpxIngestResult> {
        const { needles: matchNeedles, routing, provenance } = matched;
        const where = {
            gameId: target.id, gameName: target.name,
            gameRoomId: target.game_room_id, tournamentId: target.tournament_id,
        };

        // v2.167.1 — a REPEAT of a play that already landed on this board
        // answers like the first time. On 2026-10-22 prod saw the same desktop
        // score arrive four times inside two seconds; one landed, three were
        // answered `duplicate`, and the companion showed whichever answer
        // finished first — "duplicate" for a score that was on the board.
        // Nothing is written here (the dedup below would refuse it anyway);
        // the trail records the repeat against the row it repeats. Decided
        // BEFORE the attempt binding, the suppression check and the gate, so a
        // repeat on a limited tournament is not refused as `reused` either.
        const repeat = await VpxScoreIngestService.landedRepeat(input, target, score, playedAt);
        if (repeat) {
            await VpxScoreIngestService.trail(input, score, playedAt, {
                outcome: 'duplicate', ...where,
                integrityMode: normalizeIntegrityMode(target.integrity_mode),
                scoreHistoryId: repeat.id,
            });
            return { status: 'ingested', ...where, verdict: null, reasons: [] };
        }

        // v2.167.0 (ADR 0029) — Limited attempts. On a limited tournament a
        // score lands only when it belongs to a counted, on-time game START the
        // Castcade companion reported over `/witness/attempt`. A refusal is
        // wired exactly like a Sanctioned one (below): held off this board,
        // Global fall-through when the device allows it, trail row.
        let attemptAccepted: { attemptId: number; attempt: { n: number; of: number; remaining: number } } | null = null;
        if (target.max_attempts != null && target.max_attempts >= 1 && target.tournament_id) {
            const { AttemptService, ATTEMPT_REFUSAL_TEXT, playIsStarted } = await import('./AttemptService.js');
            const refusal = (reason: 'device' | 'exit_sample' | 'not_started') =>
                ({ ok: false as const, reason, text: ATTEMPT_REFUSAL_TEXT[reason] });
            // W38 (ADR 0033 §4) — with "Start attempts" required, a play that
            // began before the player pressed it goes to Global and uses NO
            // attempt (checked before any attempt row is written).
            const notStarted = target.require_attempt_start === 1 && input.deviceId
                ? !playIsStarted(
                    (await AttemptService.startsFor(input.canonicalUserId, [target.id]))[target.id],
                    input.startedTs,
                )
                : false;
            const bound = !input.deviceId
                ? refusal('device')
                : notStarted
                ? refusal('not_started')
                : input.deviceType !== 'desktop'
                // A CABINET has no live start call: each game report IS the
                // attempt, counted at report time (owner ruling 2026-10-22).
                // A no-ROM table's exit sample is one reading per SITTING, so
                // its games cannot be counted at all.
                ? (input.reason === 'exit_sample'
                    ? refusal('exit_sample')
                    : await AttemptService.recordStartAndBind({
                        tournamentId: target.tournament_id, gameId: target.id, gameRoomId: target.game_room_id,
                        canonicalUserId: input.canonicalUserId, deviceId: input.deviceId,
                        limit: target.max_attempts,
                        score, startedTs: input.startedTs, endedTs: input.endedTs,
                        tableName: input.tableName, rom: input.rom ?? null,
                        restarts: input.restarts ?? null,
                    }))
                : await AttemptService.bindScore({
                    tournamentId: target.tournament_id, gameId: target.id, gameRoomId: target.game_room_id,
                    canonicalUserId: input.canonicalUserId, deviceId: input.deviceId,
                    attemptKey: input.attemptKey ?? null, limit: target.max_attempts,
                    score, startedTs: input.startedTs, endedTs: input.endedTs,
                    tableName: input.tableName, rom: input.rom ?? null,
                    // W38 (ADR 0033 §3) — a play that started before the window
                    // and ended inside it counts.
                    windowStartTs: target.round_no != null
                        ? epochOf(target.scheduled_start_at)
                        : epochOf(target.start_date),
                });
            if (!bound.ok) {
                logInfo(
                    `VPX ingest: attempt refused (${bound.reason}) — ${input.canonicalUserId} ${score} on ` +
                    `"${target.name}" (tournament ${target.tournament_id}, ${target.max_attempts} attempts)`,
                );
                const fallback = routing.globalFallback
                    ? await VpxScoreIngestService.recordGlobal(input, score, matchNeedles, { trail: false })
                    : null;
                await VpxScoreIngestService.trail(input, score, playedAt, {
                    outcome: 'attempt_refused', ...where,
                    integrityMode: normalizeIntegrityMode(target.integrity_mode),
                    reasons: [bound.reason],
                    globalScoreId: fallback?.globalScoreId ?? null,
                });
                return {
                    status: 'attempt_refused', reason: bound.reason, ...where,
                    reasons: [bound.text],
                    fallback: fallback ? (fallback.status as VpxIngestResult['fallback']) : null,
                    globalScoreId: fallback?.globalScoreId ?? null,
                };
            }
            attemptAccepted = { attemptId: bound.attemptId, attempt: bound.attempt };
        }
        const needles = matchNeedles;

        if (await VpxScoreIngestService.isSuppressedPlay(input, score, [...deviceNames, target.name], playedAt)) {
            // W29 — its own row: in a multi-tournament play another board's row
            // would otherwise stand in for this one and the backstop would skip it.
            const reason = 'the player deleted this score';
            await VpxScoreIngestService.trail(input, score, playedAt, {
                outcome: 'suppressed', ...where,
                integrityMode: normalizeIntegrityMode(target.integrity_mode),
                reasons: [reason],
            });
            return { status: 'suppressed', reason, ...where };
        }

        // v2.165.0 (ADR 0027) — the rules are evaluated for EVERY tournament
        // match. Open play: the verdict is stored as a badge and the write goes
        // ahead. Sanctioned play: a flagged score is held out of this board.
        const mode: IntegrityMode = normalizeIntegrityMode(target.integrity_mode);
        const verdict: Verdict = evaluateSanctioned({
            rules: normalizeSanctionedRules(target.sanctioned_rules),
            requirements: {
                requiredVpsTableId: target.required_vps_table_id,
                requiredRom: target.required_rom,
                requiredFingerprint: target.required_fingerprint,
            },
            evidence: input.evidence ?? null,
            rom: input.rom ?? null,
        });
        if (mode === 'sanctioned' && verdict.verdict === 'flagged') {
            logInfo(
                `VPX ingest: not sanctioned — ${input.canonicalUserId} ${score} on "${target.name}" ` +
                `(tournament ${target.tournament_id}): ${verdict.reasons.join('; ')}`,
            );
            // Held out of THIS board only. The play still counts for the
            // player's own record when the device allows it — the same path an
            // unmatched score takes — and the refusal is recorded against the
            // tournament so the runner sees what was held out and why.
            const fallback = routing.globalFallback
                ? await VpxScoreIngestService.recordGlobal(input, score, needles, { trail: false })
                : null;
            await VpxScoreIngestService.trail(input, score, playedAt, {
                outcome: 'not_sanctioned', ...where, integrityMode: mode, verdict,
                globalScoreId: fallback?.globalScoreId ?? null,
            });
            return {
                status: 'not_sanctioned', reason: verdict.reasons.join('; '), ...where,
                verdict: 'flagged', reasons: verdict.reasons,
                fallback: fallback ? (fallback.status as VpxIngestResult['fallback']) : null,
                globalScoreId: fallback?.globalScoreId ?? null,
            };
        }

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
            // Provenance is KNOWN here, unlike an iScored sync: the engine is
            // VPX by construction (the record came out of VPX) and the device
            // is whatever kind of machine the Witness that posted it is paired
            // on — the cabinet, or a Windows rig running the Castcade companion
            // (v2.163.0). `provenanceFor` is the ONE mapping for all three
            // writes below and the exclusion check above.
            ...provenance,
            // The launcher's timestamp, not ours — the same discipline the
            // AtGames path follows, and what makes the witness join possible.
            createdAt: playedAt,
        });

        // v2.166.2 — what the trail STORES (and the board shows) for a score
        // that LANDED. The gate above has already acted on the raw verdict.
        const badge = VpxScoreIngestService.badgeVerdict(input, verdict);

        if (id == null) {
            await VpxScoreIngestService.trail(input, score, playedAt, { outcome: 'duplicate', ...where, integrityMode: mode, verdict: badge });
            return { status: 'duplicate', ...where, verdict: badge?.verdict ?? null, reasons: badge?.reasons ?? [] };
        }

        // The room board is served from `leaderboard_cache`, which has no
        // expiry: the manual submit routes, the per-row delete and the player
        // merge clear it, and until v2.165.0 this path never did. A witness
        // score was therefore on the tournament's scores page at once but off
        // the room page until someone ELSE'S manual submission to the same game
        // flushed the cache (the owner's Tales from the Crypt game, 2026-10-20).
        // The score route already pushes `leaderboard:updated` on `ingested`;
        // the refetch that push triggers re-read the stale cache. Cleared here,
        // before the fan-out and the trail, so no return path below can skip it.
        const { LeaderboardService } = await import('./LeaderboardService.js');
        await LeaderboardService.invalidate(target.id);

        // v2.153.0 (ADR 0023): landing in a tournament does not keep a score off
        // the Global Scoreboard. Where you played is not supposed to decide
        // whether the world sees it — the opt-out is the player's, not the
        // format's.
        const { GlobalScoreService } = await import('./GlobalScoreService.js');
        const fanned = await GlobalScoreService.fanOutAutomatedScore({
            gameRoomId: target.game_room_id,
            gameName: target.name,
            gameId: target.id,
            canonicalUserId: input.canonicalUserId,
            username,
            score,
            tournamentId: target.tournament_id,
            ...provenance,
            source: 'vpx',
        });

        if (attemptAccepted) {
            const { AttemptService } = await import('./AttemptService.js');
            await AttemptService.markScored(attemptAccepted.attemptId, {
                scoreHistoryId: id, score, endedTs: input.endedTs,
            });
        }

        await VpxScoreIngestService.trail(input, score, playedAt, {
            outcome: 'ingested', ...where, integrityMode: mode, verdict: badge,
            scoreHistoryId: id, globalScoreId: fanned?.globalScoreId ?? null,
        });

        logInfo(
            `VPX ingest: ${username} ${score} on "${target.name}" ` +
            `(${target.round_no != null ? `round ${target.round_no}` : 'rotation'}, ` +
            `tournament ${target.tournament_id ?? 'none'}, reason=${input.reason ?? 'unknown'}, ` +
            (attemptAccepted
                ? `attempt ${attemptAccepted.attempt.n} of ${attemptAccepted.attempt.of}, `
                : '') +
            `${mode} play, ` +
            (badge
                ? `verdict ${badge.verdict}${badge.reasons.length ? `: ${badge.reasons.join('; ')}` : ''}`
                : `no verdict stored (${input.deviceType === 'desktop' ? 'no evidence' : 'cabinet'})`) +
            ')',
        );
        return {
            status: 'ingested', ...where,
            verdict: badge?.verdict ?? null, reasons: badge?.reasons ?? [],
            globalScoreId: fanned?.globalScoreId ?? null,
            ...(attemptAccepted ? { attempt: attemptAccepted.attempt } : {}),
        };
    }

    /**
     * Which open game a witness play belongs to (extracted v2.167.0 so the
     * score call AND the attempt call of ADR 0029 share one answer — an
     * attempt and its score can never land on different games).
     *
     * Routing by designation or participation, the VPS game id first then the
     * device's names, the window (the play's END for a score; the START for an
     * attempt, passed in as `endedTs`), the device-exclusion rule, the
     * round-beats-rotation tie-break, and ambiguity is never a guess.
     *
     * `needles` comes back with the catalogue game's names folded in, which is
     * what the Global fall-through and the suppression check key on.
     */
    static async match(input: VpxScoreInput): Promise<VpxMatchResult> {
        const needles = nameKeys(VpxScoreIngestService.deviceNames(input));
        const routing = input.target ?? { roomId: null, tournamentId: null, globalFallback: true };
        const provenance = VpxScoreIngestService.provenanceFor(input.deviceType, input.playDevice);
        const loaded = await VpxScoreIngestService.loadCandidates(input.canonicalUserId);
        const candidates = loaded.filter(row => VpxScoreIngestService.inScope(row, routing));

        // v2.165.0 — the VPS game id first (the companion resolved the table to
        // a catalogue game; the room's spelling of the name no longer matters),
        // then the device's names exactly as before.
        // v2.193.0 (W12) - no usable VPS id (none sent, or one the catalogue
        // does not know)? A `rom` the ROM map gives to exactly ONE catalogue
        // game stands in for it, the same way: that game's names are tried
        // before the device's. An ambiguous or unknown ROM changes nothing.
        const catalogue = (input.evidence?.vpsGame
            ? await VpxScoreIngestService.catalogueGame(input.evidence.vpsGame)
            : null) ?? await VpxScoreIngestService.catalogueGameForRom(input.rom);
        const byVps = catalogue
            ? candidates.filter(row =>
                (row.global_game_id != null && row.global_game_id === catalogue.id)
                || [...nameKeys([row.name])].some(key => catalogue.keys.has(key)))
            : [];
        const byName = candidates.filter(row => [...nameKeys([row.name])].some(key => needles.has(key)));
        const matches = (byVps.length > 0 ? byVps : byName)
            .filter(row => VpxScoreIngestService.inWindow(row, input.endedTs))
            .filter(row => !VpxScoreIngestService.engineExcluded(row, provenance.device));
        if (catalogue) {
            // The catalogue's own names join the suppression and Global keys:
            // a delete there was keyed on them.
            for (const key of catalogue.keys) needles.add(key);
        }

        // v2.175.0 (W37, closes W36): only tournaments the player is ALLOWED IN.
        const allowed = matches.filter(row => VpxScoreIngestService.allowedIn(row));
        if (allowed.length === 0) {
            return {
                kind: 'none', needles, routing, provenance, catalogue,
                reason: VpxScoreIngestService.missReason(input, loaded, routing, provenance, catalogue),
            };
        }
        // v2.175.0 (W37, ADR 0033): the play counts in EVERY tournament it
        // matches — two tournaments running the same table in member rooms each
        // get it. This replaces P9b's "two matches is no_match" and the
        // round-beats-rotation tie-break (which only ever chose ONE of them).
        // Ambiguity survives only INSIDE one tournament (two of its open games
        // match the same play): that tournament is skipped, never guessed at.
        const byTournament = new Map<string, CandidateRow[]>();
        for (const row of allowed) {
            const key = row.tournament_id ?? `game:${row.id}`;
            byTournament.set(key, [...(byTournament.get(key) ?? []), row]);
        }
        const targets: CandidateRow[] = [];
        let ambiguousCount = 0;
        for (const [key, rows] of byTournament) {
            if (rows.length === 1) {
                targets.push(rows[0]!);
            } else {
                ambiguousCount += rows.length;
                logWarn(
                    `VPX ingest: "${input.tableName}" matched ${rows.length} open games in tournament ${key} ` +
                    `for ${input.canonicalUserId} — skipping that tournament instead of guessing`,
                );
            }
        }
        if (targets.length === 0) {
            return { kind: 'ambiguous', count: ambiguousCount, needles, routing, provenance, catalogue };
        }
        // Event rounds first (their window is the more specific claim), then
        // rotation games; the first is what a single-answer caller reports.
        targets.sort((a, b) => Number(b.round_no != null) - Number(a.round_no != null));
        const target = targets[0]!;
        const where = {
            gameId: target.id, gameName: target.name,
            gameRoomId: target.game_room_id, tournamentId: target.tournament_id,
        };
        return { kind: 'target', target, where, targets, needles, routing, provenance, catalogue };
    }

    /**
     * W27 (ADR 0033 §5) — why a play counts in NO tournament, in words a player
     * can act on. Walks the same filters as `match`, in the same order (the
     * device target, the window, the tournament's device rules, entry), over the
     * open games whose NAME matched, and names the furthest one any of them
     * reached: that is the step the player missed. Null when no open game of
     * that name is open to the player at all — ordinary play at home, where
     * "no open game matched" is the whole story.
     */
    private static missReason(
        input: VpxScoreInput, loaded: CandidateRow[],
        routing: VpxMatchResult['routing'], provenance: WitnessProvenance,
        catalogue: { id: string; keys: Set<string> } | null,
    ): string | null {
        const needles = nameKeys(VpxScoreIngestService.deviceNames(input));
        const byVps = catalogue
            ? loaded.filter(row =>
                (row.global_game_id != null && row.global_game_id === catalogue.id)
                || [...nameKeys([row.name])].some(key => catalogue.keys.has(key)))
            : [];
        const named = byVps.length > 0
            ? byVps
            : loaded.filter(row => [...nameKeys([row.name])].some(key => needles.has(key)));
        if (named.length === 0) return null;

        const label = (row: CandidateRow): string => {
            const t = `"${row.tournament_name ?? row.name}"${row.round_no != null ? ` round ${row.round_no}` : ''}`;
            return row.room_name ? `${t} in ${row.room_name}` : t;
        };

        const scoped = named.filter(row => VpxScoreIngestService.inScope(row, routing));
        if (scoped.length === 0) {
            const to = routing.tournamentId ? 'one other tournament'
                : routing.roomId ? 'one other room'
                : routing.globalOnly ? 'the Global Scoreboard only'
                : 'All my rooms';
            return `your device is set to send to ${to}, so it did not count in ${label(named[0]!)}`;
        }

        const timed = scoped.filter(row => VpxScoreIngestService.inWindow(row, input.endedTs));
        if (timed.length === 0) {
            const row = scoped[0]!;
            if (row.round_no != null) {
                const start = epochOf(row.scheduled_start_at);
                return start != null && input.endedTs < start
                    ? `played before ${label(row)} opened`
                    : `played after ${label(row)} closed`;
            }
            return `played before "${row.name}" went up in ${label(row)}`;
        }

        const devices = timed.filter(row => !VpxScoreIngestService.engineExcluded(row, provenance.device));
        if (devices.length === 0) {
            const device = provenance.device === 'atgames' ? 'AtGames cabinet'
                : provenance.device === 'vr_headset' ? 'VR headset' : 'PC';
            return `${label(timed[0]!)} does not accept ${device} scores`;
        }

        const row = devices[0]!;
        switch (entryRefusal({
            format: row.format === 'event' ? 'event' : 'rotation',
            roomless: row.game_room_id == null,
            checkinRequired: row.checkin_required === 1,
            isMember: row.is_member === 1,
            isParticipant: row.is_participant === 1,
            entryMode: normalizeEntryMode(row.entry_mode),
            onRoster: row.on_roster === 1,
        })) {
            case 'not_checked_in': return `you are not checked in to ${label(row)}`;
            case 'not_on_roster': return `${label(row)} is invite-only and you are not on its roster`;
            case 'not_joined': return `you have not joined ${label(row)}`;
            case 'not_member': return `you are not a member of ${row.room_name ?? 'that room'}`;
            default: return null;
        }
    }

    /**
     * v2.166.2 — the verdict the trail stores for a score that LANDED (Open
     * play, or a Sanctioned pass). `evaluateSanctioned` judged the score and
     * the Sanctioned gate has already acted on that judgement; this decides
     * whether it is also a BADGE anyone should see on the board.
     *
     * - **A cabinet never gets one.** It sends no evidence today, and whatever
     *   a later cabinet build sends (table / script / ROM / engine hashes, the
     *   VPS ids) is for a cabinet evidence profile that does not exist yet.
     *   Running a cabinet's partial evidence through the DESKTOP rules would
     *   fail "settings were not reported" and "builds were not reported" and
     *   paint every cabinet score Flagged. Owner ruling 2026-10-21: store what
     *   it sent, verdict NULL, no chip. (In Sanctioned play the gate still
     *   refuses it as `no_match`, and THAT trail row keeps its flagged verdict
     *   so the runner's review says what was held out and why.)
     * - **A desktop with no evidence** (a Castcade older than 0.2.5) gets none
     *   either. "No evidence" is an absence of badge, never a badge of absence
     *   — `admin-ui/src/lib/integrityBadge.ts` said so from the start; until
     *   v2.166.2 the ingest stored `flagged: no evidence` and the board drew it.
     * - A desktop WITH evidence keeps the verdict as before: `pass` is the
     *   Sanctioned / Conditions-verified badge, `flagged` in Open play is the
     *   badge that says what was measured.
     */
    private static badgeVerdict(input: VpxScoreInput, verdict: Verdict): Verdict | null {
        if (input.deviceType !== 'desktop') return null;
        if (!input.evidence) return null;
        return verdict;
    }

    /**
     * v2.167.1 — how recent a play (or a Global write) must be for a repeat of
     * it to be answered as the original was. Two minutes covers the companion
     * re-sending a live score and the cabinet's 60 s send retry (1.0.4); a
     * cabinet replaying days of score files on restart or re-pair stays
     * `duplicate`, which its contract treats the same way.
     */
    static readonly REPEAT_WINDOW_SEC = 120;

    /**
     * The `score_history` row this exact play already wrote to this board, if
     * the play ended inside `REPEAT_WINDOW_SEC`: same game row, same room,
     * same tournament stamp, same player, same score, witness source, and the
     * launcher's own end time as `created_at` (which is what makes it the
     * SAME play rather than the same score again later). Keyed on the row the
     * dedup saw, not on the trail, because in the concurrent case the first
     * run's trail is written after its row — the row is the only thing the
     * repeat can be sure already exists.
     */
    private static async landedRepeat(
        input: VpxScoreInput, target: CandidateRow, score: number, playedAt: string,
    ): Promise<{ id: number } | null> {
        if (Date.now() / 1000 - input.endedTs > VpxScoreIngestService.REPEAT_WINDOW_SEC) return null;
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(
            `SELECT id FROM score_history
              WHERE game_id = ? AND game_room_id IS ? AND submitted_during_tournament_id IS ?
                AND discord_user_id = ? AND score = ? AND source = 'vpx' AND created_at = ?
              LIMIT 1`,
            target.id, target.game_room_id, target.tournament_id ?? null,
            input.canonicalUserId, score, playedAt,
        );
        return row ?? null;
    }

    /** v2.167.1 — true when an ISO / SQLite UTC stamp is inside `REPEAT_WINDOW_SEC` of now. */
    private static withinRepeatWindow(stamp: string | null | undefined): boolean {
        if (!stamp) return false;
        const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : stamp.replace(' ', 'T') + 'Z';
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) return false;
        return Date.now() - ms <= VpxScoreIngestService.REPEAT_WINDOW_SEC * 1000;
    }

    /**
     * The evidence trail (v2.165.0, ADR 0027): one row per witness score the
     * ingest saw, every outcome, both modes. Best-effort by construction — a
     * failure here must never cost the score, which is already decided.
     */
    private static async trail(
        input: VpxScoreInput, score: number, playedAt: string,
        extra: {
            outcome: import('./WitnessEvidenceService.js').IngestOutcome;
            gameId?: string | null; tournamentId?: string | null; gameRoomId?: string | null;
            gameName?: string;
            integrityMode?: IntegrityMode | null; verdict?: Verdict | null;
            scoreHistoryId?: number | null; globalScoreId?: string | null;
            /** v2.167.0 — stored reasons when there is no verdict (an attempt refusal's machine reason). */
            reasons?: string[];
        },
    ): Promise<void> {
        if (!input.deviceId) return;
        VpxScoreIngestService.trailed.add(input);
        try {
            const { WitnessEvidenceService } = await import('./WitnessEvidenceService.js');
            await WitnessEvidenceService.record({
                deviceId: input.deviceId,
                canonicalUserId: input.canonicalUserId,
                outcome: extra.outcome,
                gameId: extra.gameId ?? null,
                tournamentId: extra.tournamentId ?? null,
                gameRoomId: extra.gameRoomId ?? null,
                scoreHistoryId: extra.scoreHistoryId ?? null,
                globalScoreId: extra.globalScoreId ?? null,
                integrityMode: extra.integrityMode ?? null,
                verdict: extra.verdict ?? null,
                ...(extra.reasons ? { reasons: extra.reasons } : {}),
                tableName: input.tableName,
                rom: input.rom ?? null,
                score,
                playedAt,
                evidence: input.evidence ?? null,
                ballPoints: input.ballPoints ?? null,
                quit: input.quit ?? null,
            });
        } catch (err) {
            logWarn(`VPX ingest: evidence trail not written (${err instanceof Error ? err.message : String(err)})`);
        }
    }

    /**
     * The catalogue game a VPS id names, with the match keys of its names
     * (`name` and `display_name`), or null when the catalogue has no such
     * game. One indexed lookup (`idx_global_games_vps`).
     */
    private static async catalogueGame(vpsGameId: string): Promise<{ id: string; keys: Set<string> } | null> {
        const db = await getDatabase();
        const row = await db.get<{ id: string; name: string; display_name: string | null }>(
            `SELECT id, name, display_name FROM global_games WHERE vps_id = ? AND status = 'approved' LIMIT 1`,
            vpsGameId,
        );
        if (!row) return null;
        return { id: row.id, keys: nameKeys([row.name, row.display_name ?? '']) };
    }

    /**
     * v2.193.0 (W12) - the catalogue game a PinMAME ROM id names through
     * `global_game_roms` (VPS `romFiles`), in the SAME shape as
     * `catalogueGame`, or null when the map does not know the ROM or lists it
     * under more than one game (never a guess). It only ADDS that game's own
     * names; a room game whose name is not that game's still does not match.
     */
    private static async catalogueGameForRom(rom: string | null | undefined): Promise<{ id: string; keys: Set<string> } | null> {
        const { GlobalGameRomService } = await import('./GlobalGameRomService.js');
        const row = await GlobalGameRomService.gameForRom(rom);
        if (!row) return null;
        return { id: row.id, keys: nameKeys([row.name, row.display_name ?? '']) };
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
        opts: { trail?: boolean; notCounted?: string | null } = {},
    ): Promise<VpxIngestResult> {
        const inner = await VpxScoreIngestService.recordGlobalInner(input, score, needles);
        // W27 (ADR 0033 §5) — a play that matched an open tournament game but
        // could not count there says why, beside wherever it went instead.
        const result: VpxIngestResult = opts.notCounted ? { ...inner, notCounted: opts.notCounted } : inner;
        if (opts.trail !== false) {
            await VpxScoreIngestService.trail(input, score, toSqliteUtc(Math.floor(input.endedTs)), {
                outcome: result.status === 'global' || result.status === 'global_duplicate' || result.status === 'suppressed'
                    ? result.status : 'no_match',
                gameName: result.gameName,
                globalScoreId: result.globalScoreId ?? null,
                // W29 — why it did not land ("not in the Arcaid catalogue", "matches 2 catalogue games", …);
                // W27 — why it did not count in the tournament it matched, first.
                ...((result.notCounted || result.reason)
                    ? { reasons: [result.notCounted, result.reason].filter((r): r is string => !!r) }
                    : {}),
            });
        }
        return result;
    }

    private static async recordGlobalInner(
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
        if (candidates.length > 1) {
            // v2.158.0 — the launcher's DISPLAY name is the authority; `rom`
            // and the folder slug are fallbacks for when it is not what the
            // catalogue calls the game, not peers of it. Two 09-30 losses
            // (SPRINT_STATUS #150): "Scooby-Doo! (Original 2022)" matched both
            // "Scooby-Doo!" and "Scooby Doo" because the SLUG squashes to
            // either, and "Halloween (Original 2023)" matched "Halloween
            // (Original, 2023)" AND "Halloween MM Edition" through the rom.
            // Prefer the one row whose normalised name equals the display
            // name's — the NORMAL form only, never the squashed one, which is
            // exactly what blurred the two Scooby rows together. Still two
            // (true duplicates)? Give up as before: a merge is the fix, not a
            // guess here.
            const journal = normalizeGameName(input.tableName || '');
            if (journal) {
                const exact = candidates.filter(row => normalizeGameName(row.name) === journal);
                if (exact.length === 1) candidates = exact;
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

        // The catalogue name is what a Global Scoreboard delete keyed its
        // tombstone on, and what a room delete keyed it on when the room used
        // the catalogue's name — the device's own names may not normalise to it
        // (a launcher slug has no spaces).
        if (await VpxScoreIngestService.isSuppressedPlay(
            input, score, [...VpxScoreIngestService.deviceNames(input), game.name],
            toSqliteUtc(Math.floor(input.endedTs)),
        )) {
            return { status: 'suppressed', reason: 'the player deleted this score', gameName: game.name };
        }

        const username = await VpxScoreIngestService.resolvePlayerName(input.canonicalUserId, null);

        // v2.156.0 (ADR 0024) — a SOFT-DELETED row for this player, game and
        // score is itself the record that this score was removed, whatever
        // wrote it, so the cabinet must not re-post it. This covers the
        // cabinet rows written with a NULL source before v2.156.0 (which get
        // no tombstone on delete) without guessing at a backfill. An admin
        // restore clears `deleted_at`, after which the duplicate check below
        // applies as normal.
        const removed = await db.get<{ id: string }>(
            `SELECT id FROM global_scores
              WHERE global_game_id = ? AND player_id = ? AND score = ? AND deleted_at IS NOT NULL
              LIMIT 1`,
            game.id, input.canonicalUserId, score,
        );
        if (removed) {
            logInfo(
                `VPX ingest: suppressed ${input.canonicalUserId} ${score} on "${game.name}" ` +
                `— a deleted Global Scoreboard row already records this score as removed`,
            );
            return { status: 'suppressed', reason: 'the player deleted this score', gameName: game.name };
        }

        // Idempotency: the device retries a report whose answer it never saw,
        // and a re-pull re-reads the same jsonl lines. Global has no
        // ScoreHistoryService.isDuplicate of its own, so the same predicate is
        // spelled out here — (player, game, score) already present is a no-op.
        const existing = await db.get<{ id: string; submitted_at: string | null }>(
            `SELECT id, submitted_at FROM global_scores
              WHERE global_game_id = ? AND player_id = ? AND score = ? AND deleted_at IS NULL
              LIMIT 1`,
            game.id, input.canonicalUserId, score,
        );
        if (existing) {
            // v2.167.1 — a repeat inside the window is told what the first
            // send was told: it landed. `submitted_at` is the INGEST time of
            // the row, so this is literally "answered within two minutes".
            if (VpxScoreIngestService.withinRepeatWindow(existing.submitted_at)) {
                return { status: 'global', gameName: game.name, globalScoreId: existing.id };
            }
            return { status: 'global_duplicate', gameName: game.name };
        }

        const { GlobalScoreService } = await import('./GlobalScoreService.js');
        let globalScoreId: string | null = null;
        try {
            const written = await GlobalScoreService.submit({
                globalGameId: game.id,
                playerId: input.canonicalUserId,
                iscoredUsername: username,
                score,
                originType: 'global',
                ...VpxScoreIngestService.provenanceFor(input.deviceType, input.playDevice),
                // v2.156.0 — these rows used to be written with a NULL source,
                // which left them indistinguishable from a typed global entry
                // and gave a delete nothing to tombstone on (ADR 0024).
                source: 'vpx',
            });
            globalScoreId = written?.id ?? null;
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
        return { status: 'global', gameName: game.name, globalScoreId };
    }

    /**
     * The LIMITED-ATTEMPTS games a play from this device would count on right
     * now (2026-10-25, for the cabinet's "Sending to" line). Built from the
     * same filters `match` applies — candidates, routing, entry, the window
     * at `nowTs`, the device-exclusion rule — minus the table-name match, so
     * the line can never name a game a score would not land on.
     */
    static async openLimitedGames(input: {
        canonicalUserId: string;
        target: { roomId: string | null; tournamentId: string | null; globalOnly?: boolean };
        deviceType: WitnessDeviceType | null | undefined;
        nowTs: number;
    }): Promise<Array<{ gameId: string; gameName: string; tournamentId: string; limit: number; requireStart: boolean }>> {
        const provenance = VpxScoreIngestService.provenanceFor(input.deviceType ?? 'atgames');
        return (await VpxScoreIngestService.loadCandidates(input.canonicalUserId))
            .filter(row => row.max_attempts != null && row.max_attempts >= 1 && row.tournament_id != null)
            .filter(row => VpxScoreIngestService.inScope(row, input.target))
            .filter(row => VpxScoreIngestService.allowedIn(row))
            .filter(row => VpxScoreIngestService.inWindow(row, input.nowTs))
            .filter(row => !VpxScoreIngestService.engineExcluded(row, provenance.device))
            .map(row => ({
                gameId: row.id, gameName: row.name, tournamentId: row.tournament_id!, limit: row.max_attempts!,
                requireStart: row.require_attempt_start === 1,
            }));
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
                    g.start_date, g.tournament_id, g.game_room_id, g.global_game_id,
                    g.required_vps_table_id, g.required_rom, g.required_fingerprint,
                    t.format, t.end_grace_sec, t.platform_rules, t.integrity_mode, t.sanctioned_rules,
                    t.max_attempts, t.checkin_required, t.require_attempt_start, t.entry_mode,
                    t.name AS tournament_name, gr.name AS room_name,
                    EXISTS (
                        SELECT 1 FROM tournament_participants tp
                         WHERE tp.tournament_id = g.tournament_id AND tp.user_id = ?
                    ) AS is_participant,
                    (g.game_room_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM room_members rm2
                         WHERE rm2.room_id = g.game_room_id AND rm2.user_id = ?
                    )) AS is_member,
                    EXISTS (
                        SELECT 1 FROM tournament_roster tr
                         WHERE tr.tournament_id = g.tournament_id AND tr.user_id = ?
                    ) AS on_roster
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
               LEFT JOIN game_rooms gr ON gr.id = g.game_room_id
              -- W33 open-card rule: a FINISHED event is out; a PAUSED rotation
              -- (is_active = 0) is not — pause only stops the rotation.
              WHERE NOT ${tournamentFinishedSql('t')}
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
                     -- W39: a roster spot is a direct entry, like a participant row.
                     OR EXISTS (
                            SELECT 1 FROM tournament_roster tr2
                             WHERE tr2.tournament_id = g.tournament_id AND tr2.user_id = ?
                        )
                    )`,
            canonicalUserId, canonicalUserId, canonicalUserId, canonicalUserId, canonicalUserId, canonicalUserId,
        );
    }

    /**
     * Does this candidate lie inside what the device is pointed at?
     *
     * The routing model lives in ONE place, `utils/witnessRouting.ts`
     * (`deviceRoutesTo`), shared with the event check-in lobby. In short: a
     * pinned tournament → that tournament; a room → that room's games;
     * "Global Scoreboard only" → no tournament at all (W26, ADR 0032 — the
     * pre-v2.174.0 fallback to events the player had joined is gone), except a
     * Throwdown the player has joined, which no device can be pointed at.
     * A designated TOURNAMENT is still what makes two tournaments running the
     * same table in one room resolvable at all.
     *
     * Everything that falls outside goes to the Global Scoreboard.
     */
    private static inScope(row: CandidateRow, target: {
        roomId: string | null; tournamentId: string | null; globalOnly?: boolean;
    }): boolean {
        return deviceRoutesTo(target, {
            roomId: row.game_room_id,
            tournamentId: row.tournament_id,
            isRound: row.round_no != null,
            // W39 — a roster spot routes like a participant row: entered directly.
            isParticipant: row.is_participant === 1 || row.on_roster === 1,
            isMember: row.is_member === 1,
        });
    }

    /**
     * v2.175.0 (W37, closes W36): is the player ALLOWED IN this candidate's
     * tournament? The same `entryAllowed` the typed-score gate uses — before
     * this a device score skipped "check-in required" entirely.
     */
    private static allowedIn(row: CandidateRow): boolean {
        return entryAllowed({
            format: row.format === 'event' ? 'event' : 'rotation',
            roomless: row.game_room_id == null,
            checkinRequired: row.checkin_required === 1,
            isMember: row.is_member === 1,
            isParticipant: row.is_participant === 1,
            entryMode: normalizeEntryMode(row.entry_mode),
            onRoster: row.on_roster === 1,
        });
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
    private static engineExcluded(row: CandidateRow, device: WitnessProvenance['device']): boolean {
        const rules = parseTournamentRules(row.platform_rules, row.tournament_id ?? undefined);
        const excludedEngines = rules.engines?.excluded ?? [];
        const excludedDevices = rules.devices?.excluded ?? [];
        return excludedEngines.includes('vpx') || excludedDevices.includes(device);
    }

    /**
     * The (platform, engine, device) a witness score carries, decided by the
     * KIND of machine that posted it and nothing else (v2.163.0, ADR 0016: never
     * inferred). The engine is always VPX. The cabinet Witness is the AtGames
     * device on the legacy `vpxs` platform; the Castcade companion runs on a
     * Windows PC, so its scores are `pc` on the legacy `vpx` platform — a VR
     * headset on that PC is a display, not a different machine, and the
     * companion cannot tell the two apart, so `pc` is the honest value.
     * Used by the room write, the Global fan-out, the Global-fallback write
     * AND the tournament exclusion check, so a tournament that excludes
     * AtGames does not refuse a desktop score and one that excludes PC does.
     */
    static provenanceFor(deviceType: WitnessDeviceType | undefined, playDevice?: PlayDevice | null): WitnessProvenance {
        // v2.166.0: a desktop may say the game was played in a headset. The
        // device axis is what the badge and the tournament device rules read,
        // so `vr_headset` lands there; the legacy platform stays `vpx`.
        return deviceType === 'desktop'
            ? { platform: 'vpx', engine: 'vpx', device: playDevice === 'vr_headset' ? 'vr_headset' : 'pc' }
            : { platform: 'vpxs', engine: 'vpx', device: 'atgames' };
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
