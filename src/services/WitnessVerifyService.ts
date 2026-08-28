import { getDatabase } from '../database/database.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/**
 * Arcaid Witness — the verify-join (v2.145.0, P8, ADR 0020).
 *
 * ## What this answers
 *
 * An AtGames cabinet is **exit-to-submit**: the score reaches AtGames' board
 * when the player leaves the table, so AtGames' timestamp proves a score landed
 * inside the round window and NOTHING about when the game was launched. That
 * gap is real and AtGames does not close it — owner-tested on hardware
 * 2026-08-25, a game started long before the window and exited inside it is
 * accepted onto their board. So "geared up" (start the table early, sit on a
 * ball, exit inside the window) is invisible from the Arcaid side.
 *
 * The Witness app on the cabinet reports what only the cabinet can see: the
 * launch and exit times of each table session (`witness_observations`, v2.142.0).
 * This service joins those observations to the AtGames scores on a round board
 * and answers, per score: **was this table launched after the round opened?**
 *
 * ## Why the join key is `exit_ts ≈ created_at`
 *
 * Because exit-to-submit makes them the SAME moment, seen from two independent
 * clocks — AtGames' server (via `created_at`, which the sync now stores as
 * AtGames' own timestamp) and the cabinet's own clock (via `exit_ts`). Matching
 * on it is therefore also a device-clock-consistency check: a cabinet whose
 * clock is minutes off produces no match at all, which reads as `unwitnessed`
 * rather than as a false `verified`.
 *
 * ## Why `table_name` is surfaced but never matched
 *
 * The witness reports the ENGINE-INTERNAL table id (`aerobatics`), which lives
 * in a different namespace from the catalogue name ("Aerobatics" / whatever the
 * round is called) with no mapping between them. Inventing one would silently
 * downgrade legitimate scores whenever the guess missed. So the observed name
 * is carried to the host to eyeball and plays no part in the verdict.
 *
 * ## Trust model — a badge, never a gate
 *
 * Verdicts are HOST-FACING BADGES. Nothing here rejects a score, filters a
 * board, or changes a rank; the same rule ADR 0017 set for `min_elapsed_sec`.
 * `unwitnessed` is the NEUTRAL default — most players have no paired cabinet,
 * and treating a missing observation as suspicion would punish everyone who
 * never opted in. `flagged` is a hint for a human, and the whole mechanism is
 * evidence for social/stream enforcement, not tamper-proof anti-cheat: root is
 * free on these cabinets and the app reports what it is told to report.
 */

export type WitnessVerdict = {
    status: 'verified' | 'flagged' | 'unwitnessed';
    /** epoch sec, from the joined observation. */
    launchTs: number | null;
    exitTs: number | null;
    durationSec: number | null;
    /**
     * The ENGINE-INTERNAL table id the witness saw (e.g. `'aerobatics'`) —
     * informational only, deliberately NOT matched against the catalogue name.
     */
    table: string | null;
};

/**
 * How far apart an observation's `exit_ts` and a score's `created_at` may be and
 * still be the same session.
 *
 * Exit-to-submit means AtGames stamps ≈ the exit moment, so the true gap is the
 * upload latency. Two minutes covers that plus modest NTP drift on the cabinet,
 * and is narrow enough that two sessions of one table rarely both fit — when
 * they do, the nearest exit wins.
 */
export const JOIN_TOLERANCE_SEC = 120;

/**
 * How far BEFORE the round's scheduled start a launch may sit and still count
 * as on time.
 *
 * This is clock slop between the cabinet and the server, not a grace period:
 * seconds are two machines disagreeing, MINUTES early is the gear-up this whole
 * phase exists to catch.
 */
export const LAUNCH_GRACE_SEC = 15;

interface ObservationRow {
    canonical_user_id: string;
    table_name: string;
    launch_ts: number;
    exit_ts: number;
    duration_sec: number | null;
}

export class WitnessVerifyService {
    /**
     * One verdict per input row, positionally aligned with `rows`.
     *
     * `null` means "no verdict applies" — not a failed one. Only AtGames-sourced
     * rows carry a witness verdict: a phone submit has its own `min_elapsed_sec`
     * heuristic and no cabinet session to join against.
     */
    static async verdictsForRound(input: {
        /** epoch sec of the round's `scheduled_start_at`. */
        roundStartEpoch: number;
        rows: Array<{ identityKey: string; createdEpoch: number | null; source: string | null }>;
    }): Promise<Array<WitnessVerdict | null>> {
        const { roundStartEpoch, rows } = input;

        const eligible = rows
            .map((row, i) => ({ row, i }))
            .filter(({ row }) => row.source === 'atgames' && row.createdEpoch != null);
        const verdicts: Array<WitnessVerdict | null> = rows.map(() => null);
        if (eligible.length === 0) return verdicts;

        // One owner-set lookup per DISTINCT identity, not per score. A synthetic
        // key (`iscored:*`, an unlinked `atgames:*`) expands to itself, owns no
        // devices, and so falls out as `unwitnessed` with no special-casing.
        const ownersByKey = new Map<string, Set<string>>();
        for (const { row } of eligible) {
            if (ownersByKey.has(row.identityKey)) continue;
            const canonical = await IdentityLinkService.resolveCanonical(row.identityKey);
            const owners = await IdentityLinkService.expandCandidates(canonical);
            owners.add(row.identityKey);
            ownersByKey.set(row.identityKey, owners);
        }

        const allOwners = [...new Set([...ownersByKey.values()].flatMap(s => [...s]))];
        const epochs = eligible.map(({ row }) => row.createdEpoch!);
        const lo = Math.min(...epochs) - JOIN_TOLERANCE_SEC;
        const hi = Math.max(...epochs) + JOIN_TOLERANCE_SEC;

        // ONE query for the whole board — a per-score query would issue as many
        // round trips as there are players on a busy round.
        const db = await getDatabase();
        const placeholders = allOwners.map(() => '?').join(', ');
        const observations = await db.all<ObservationRow[]>(
            `SELECT canonical_user_id, table_name, launch_ts, exit_ts, duration_sec
               FROM witness_observations
              WHERE exit_ts IS NOT NULL
                AND exit_ts BETWEEN ? AND ?
                AND canonical_user_id IN (${placeholders})`,
            lo, hi, ...allOwners,
        );

        for (const { row, i } of eligible) {
            const owners = ownersByKey.get(row.identityKey)!;
            const createdEpoch = row.createdEpoch!;

            let best: ObservationRow | null = null;
            let bestDelta = Number.POSITIVE_INFINITY;
            for (const obs of observations) {
                if (!owners.has(obs.canonical_user_id)) continue;
                const delta = Math.abs(obs.exit_ts - createdEpoch);
                if (delta > JOIN_TOLERANCE_SEC) continue;
                if (delta < bestDelta) { best = obs; bestDelta = delta; }
            }

            if (!best) {
                verdicts[i] = {
                    status: 'unwitnessed', launchTs: null, exitTs: null, durationSec: null, table: null,
                };
                continue;
            }

            verdicts[i] = {
                status: best.launch_ts >= roundStartEpoch - LAUNCH_GRACE_SEC ? 'verified' : 'flagged',
                launchTs: best.launch_ts,
                exitTs: best.exit_ts,
                durationSec: best.duration_sec,
                table: best.table_name,
            };
        }

        return verdicts;
    }
}
