import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { eventEndGraceSec } from './EventSubmissionGate.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { parseTournamentRules } from '../utils/platformRules.js';
import { logInfo, logWarn } from '../utils/logger.js';
import type { WitnessDeviceType } from './WitnessService.js';
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
    /** The posting device's id — the evidence trail is keyed on it (v2.165.0). */
    deviceId?: string | null;
    /**
     * What the Castcade companion measured for this score (v2.165.0, ADR
     * 0027): identity, settings, adjustments, builds. Null from a cabinet or
     * an older companion. Decides nothing on its own; see the class comment.
     */
    evidence?: WitnessEvidence | null;
};

/** See `VpxScoreIngestService.provenanceFor`. */
export type WitnessProvenance = {
    platform: 'vpxs' | 'vpx';
    engine: 'vpx';
    device: 'atgames' | 'pc';
};

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
    status: 'ingested' | 'duplicate' | 'global' | 'global_duplicate' | 'no_match' | 'invalid' | 'suppressed' | 'not_sanctioned';
    reason?: string;
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
        const needles = nameKeys(deviceNames);
        if (needles.size === 0) {
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

        const routing = input.target ?? { roomId: null, tournamentId: null, globalFallback: true };
        const provenance = VpxScoreIngestService.provenanceFor(input.deviceType);
        const candidates = (await VpxScoreIngestService.loadCandidates(input.canonicalUserId))
            .filter(row => VpxScoreIngestService.inScope(row, routing));

        // v2.165.0 — the VPS game id first (the companion resolved the table to
        // a catalogue game; the room's spelling of the name no longer matters),
        // then the device's names exactly as before.
        const catalogue = input.evidence?.vpsGame
            ? await VpxScoreIngestService.catalogueGame(input.evidence.vpsGame)
            : null;
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

        if (matches.length === 0) {
            // Nothing this cabinet is pointed at wanted the score — so it goes
            // to the player's own Global Scoreboard record instead of nowhere.
            if (routing.globalFallback) {
                return VpxScoreIngestService.recordGlobal(input, score, needles);
            }
            await VpxScoreIngestService.trail(input, score, playedAt, { outcome: 'no_match' });
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
        const where = {
            gameId: target.id, gameName: target.name,
            gameRoomId: target.game_room_id, tournamentId: target.tournament_id,
        };

        if (await VpxScoreIngestService.isSuppressedPlay(input, score, [...deviceNames, target.name], playedAt)) {
            return { status: 'suppressed', reason: 'the player deleted this score', ...where };
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

        if (id == null) {
            await VpxScoreIngestService.trail(input, score, playedAt, { outcome: 'duplicate', ...where, integrityMode: mode, verdict });
            return { status: 'duplicate', ...where, verdict: verdict.verdict, reasons: verdict.reasons };
        }

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

        await VpxScoreIngestService.trail(input, score, playedAt, {
            outcome: 'ingested', ...where, integrityMode: mode, verdict,
            scoreHistoryId: id, globalScoreId: fanned?.globalScoreId ?? null,
        });

        logInfo(
            `VPX ingest: ${username} ${score} on "${target.name}" ` +
            `(${target.round_no != null ? `round ${target.round_no}` : 'rotation'}, ` +
            `tournament ${target.tournament_id ?? 'none'}, reason=${input.reason ?? 'unknown'}, ` +
            `${mode} play, verdict ${verdict.verdict}${verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : ''})`,
        );
        return {
            status: 'ingested', ...where,
            verdict: verdict.verdict, reasons: verdict.reasons,
            globalScoreId: fanned?.globalScoreId ?? null,
        };
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
        },
    ): Promise<void> {
        if (!input.deviceId) return;
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
                tableName: input.tableName,
                rom: input.rom ?? null,
                score,
                playedAt,
                evidence: input.evidence ?? null,
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
        opts: { trail?: boolean } = {},
    ): Promise<VpxIngestResult> {
        const result = await VpxScoreIngestService.recordGlobalInner(input, score, needles);
        if (opts.trail !== false) {
            await VpxScoreIngestService.trail(input, score, toSqliteUtc(Math.floor(input.endedTs)), {
                outcome: result.status === 'global' || result.status === 'global_duplicate' || result.status === 'suppressed'
                    ? result.status : 'no_match',
                gameName: result.gameName,
                globalScoreId: result.globalScoreId ?? null,
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
        let globalScoreId: string | null = null;
        try {
            const written = await GlobalScoreService.submit({
                globalGameId: game.id,
                playerId: input.canonicalUserId,
                iscoredUsername: username,
                score,
                originType: 'global',
                ...VpxScoreIngestService.provenanceFor(input.deviceType),
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
    static provenanceFor(deviceType: WitnessDeviceType | undefined): WitnessProvenance {
        return deviceType === 'desktop'
            ? { platform: 'vpx', engine: 'vpx', device: 'pc' }
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
