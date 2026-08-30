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
 * ## Three tiers of evidence (v2.148.0, ADR 0021)
 *
 * 1. **Session join** — the join above. Strongest: the cabinet saw this exact
 *    table open and close.
 * 2. **Check-in attestation** — no session matched, but the player opened the
 *    Witness on the cabinet at/after the round start and before this score
 *    exited. These cabinets run ONE thing at a time, so an app in the
 *    foreground proves no table was mid-session at that instant: anything that
 *    exited afterwards was necessarily launched inside the window. It can only
 *    ever UPGRADE an `unwitnessed` — a check-in never accuses anybody, so tier
 *    2 cannot produce `flagged`.
 * 3. **Retro-derived observations** — sessions reconstructed from on-disk
 *    traces rather than seen live. SAME TRUST, tagged (`via = 'retro'`) so the
 *    distinction survives without changing today's verdict.
 *
 * ## Why check-in time is the SERVER's
 *
 * Because everything else here is the device's. The session join tolerates a
 * device clock precisely because it must AGREE with AtGames' independent stamp;
 * a check-in has no second clock to agree with, so its timestamp is taken at
 * the moment the request arrives and the device is never asked for one.
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
    /**
     * WHICH tier produced this verdict (v2.148.0, ADR 0021):
     *
     *   - `'session'` — a table session was joined (tier 1). Carries times.
     *   - `'checkin'` — no session joined, but the cabinet attested it was idle
     *     inside the window before this score exited (tier 2). Carries no
     *     duration: a check-in says WHEN the cabinet was free, not how long the
     *     table was played.
     *   - `null` — `unwitnessed`; no tier applied.
     */
    method: 'session' | 'checkin' | null;
    /** epoch sec, from the joined observation. */
    launchTs: number | null;
    exitTs: number | null;
    durationSec: number | null;
    /**
     * The ENGINE-INTERNAL table id the witness saw (e.g. `'aerobatics'`) —
     * informational only, deliberately NOT matched against the catalogue name.
     */
    table: string | null;
    /**
     * How the joined observation was gathered: `'live'` (the resident beacon
     * saw it happen) or `'retro'` (derived from on-disk traces afterwards).
     * SAME TRUST — the tag is carried so a host and a later analysis can tell
     * them apart, and it deliberately does not change the verdict. `null` on a
     * check-in or unwitnessed verdict, which joined no observation.
     */
    via: 'live' | 'retro' | null;
    /** epoch sec of the attestation behind a `'checkin'` verdict. */
    checkinTs: number | null;
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
    via: string | null;
}

interface CheckinRow {
    canonical_user_id: string;
    /** `server_ts` as epoch seconds — the server's clock, never the device's. */
    ts: number;
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
            `SELECT canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via
               FROM witness_observations
              WHERE exit_ts IS NOT NULL
                AND exit_ts BETWEEN ? AND ?
                AND canonical_user_id IN (${placeholders})`,
            lo, hi, ...allOwners,
        );

        // --- Tier 1: join a table SESSION -----------------------------------
        const unresolved: Array<{ row: typeof eligible[number]['row']; i: number }> = [];
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
                unresolved.push({ row, i });
                continue;
            }

            verdicts[i] = {
                status: best.launch_ts >= roundStartEpoch - LAUNCH_GRACE_SEC ? 'verified' : 'flagged',
                method: 'session',
                launchTs: best.launch_ts,
                exitTs: best.exit_ts,
                durationSec: best.duration_sec,
                table: best.table_name,
                // A retro-derived observation is trusted exactly as a live one
                // (owner ruling, 2026-08-29) — the tag rides along, it does not
                // decide anything.
                via: best.via === 'retro' ? 'retro' : 'live',
                checkinTs: null,
            };
        }

        // --- Tier 2: the round-start CHECK-IN attestation --------------------
        //
        // Only for rows tier 1 could not resolve. A `flagged` row is NEVER
        // revisited: an accusation, once evidenced by a real session, cannot be
        // talked out of by a later attestation — and tier 2 can only ever
        // UPGRADE an `unwitnessed`, never produce a `flagged` of its own.
        if (unresolved.length > 0) {
            const checkins = await WitnessVerifyService.loadCheckins(
                db, allOwners, roundStartEpoch - LAUNCH_GRACE_SEC, Math.max(...epochs),
            );

            for (const { row, i } of unresolved) {
                const owners = ownersByKey.get(row.identityKey)!;
                const createdEpoch = row.createdEpoch!;

                // The nearest qualifying check-in BEFORE the score exited: the
                // tighter the gap between "cabinet was idle" and "score
                // landed", the less room there is for anything in between.
                let bestTs: number | null = null;
                for (const checkin of checkins) {
                    if (!owners.has(checkin.canonical_user_id)) continue;
                    // A check-in AFTER the score exited proves nothing about
                    // it, and one from BEFORE the round opened proves nothing
                    // either (the cabinet could have been idle then and busy
                    // with a geared-up table by the time the round started).
                    if (checkin.ts > createdEpoch) continue;
                    if (checkin.ts < roundStartEpoch - LAUNCH_GRACE_SEC) continue;
                    if (bestTs == null || checkin.ts > bestTs) bestTs = checkin.ts;
                }

                verdicts[i] = bestTs != null
                    ? {
                        status: 'verified',
                        method: 'checkin',
                        // A check-in dates the cabinet being FREE, not the
                        // table being played — so there is no launch, no exit
                        // and deliberately no duration to report.
                        launchTs: null, exitTs: null, durationSec: null, table: null, via: null,
                        checkinTs: bestTs,
                    }
                    : {
                        status: 'unwitnessed',
                        method: null,
                        launchTs: null, exitTs: null, durationSec: null, table: null, via: null,
                        checkinTs: null,
                    };
            }
        }

        return verdicts;
    }

    /**
     * The check-ins for a set of owners inside one round's evidence window, in
     * ONE query — the same batching rule the observation load follows, for the
     * same reason (a per-score query would issue one round trip per player).
     */
    private static async loadCheckins(
        db: Awaited<ReturnType<typeof getDatabase>>,
        owners: string[],
        loEpoch: number,
        hiEpoch: number,
    ): Promise<CheckinRow[]> {
        const placeholders = owners.map(() => '?').join(', ');
        return db.all<CheckinRow[]>(
            `SELECT canonical_user_id, CAST(strftime('%s', server_ts) AS INTEGER) AS ts
               FROM witness_checkins
              WHERE canonical_user_id IN (${placeholders})
                AND CAST(strftime('%s', server_ts) AS INTEGER) BETWEEN ? AND ?`,
            ...owners, loEpoch, hiEpoch,
        );
    }
}
