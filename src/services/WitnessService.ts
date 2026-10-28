import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { tournamentFinishedSql } from '../utils/openCard.js';

/** W29 — a device target in words, for the audit row (ids, not names: the log outlives renames). */
function targetLabel(t: { roomId: string | null; tournamentId: string | null; globalOnly: boolean }): string {
    if (t.tournamentId) return `tournament ${t.tournamentId} (room ${t.roomId})`;
    if (t.roomId) return `room ${t.roomId}`;
    return t.globalOnly ? 'Global Scoreboard only' : 'All my rooms';
}

/**
 * P8 — Arcaid Witness ingest.
 *
 * The Witness is an opt-in on-device app that reports the one fact neither the
 * AtGames API nor a phone submission can give: the moment a player LAUNCHED a
 * table (not just when they exited it). That closes the gear-up gap — play
 * before the window, exit inside it — which AtGames' exit-only timestamp
 * cannot see (confirmed on hardware: AtGames does not filter gear-up).
 *
 * ## The shape is dictated by the device, not chosen
 *
 * The AtGames External Applications SDK exposes a **synchronous GET only**
 * (`AtGames::httpGet`) — no POST. So every device call is a GET, the device
 * token rides in a query string, and the auth model is built around that
 * constraint rather than fighting it:
 *
 *   - The token is **device-scoped** (one cabinet, keyed on the stable
 *     `ATGAMES_UNIQUE_ID`), **long and random**, **revocable**, and **stored
 *     only as a SHA-256 hash** — the plaintext lives on the device. A token in
 *     a URL will be logged by proxies, so it must be worthless without also
 *     being the right device, and cheap to rotate.
 *   - Reports are **rate-limited by device id** (at the route) and **idempotent**
 *     (the UNIQUE index on (device, table, launch)), because a synchronous GET
 *     with no retry semantics will be retried.
 *
 * ## Blast radius, on purpose
 *
 * An observation is inert data — "table X launched at T on device D, owned by
 * user U." The verify-join that matches it to AtGames scores lives in
 * `WitnessVerifyService`, and produces a BADGE, never a gate. So even a stolen
 * token only lets an attacker pollute their OWN witness trail. This service
 * deliberately does the smallest correct thing and no scoring.
 *
 * ## Two things the device reports (ADR 0021)
 *
 *   - **Observations** — a table session (`launch_ts`/`exit_ts`, device clock),
 *     tagged `via` = `live` (the resident beacon saw it) or `retro` (derived
 *     from on-disk traces afterwards).
 *   - **Check-ins** — "the Witness app is open right now", stamped with the
 *     SERVER's clock. On a cabinet that runs one thing at a time, that is proof
 *     no table was mid-session at that instant.
 */

/** Unambiguous when read off a cabinet screen — no 0/O/1/I/L (Throwdown charset). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LEN = 6;
const PAIRING_TTL_MS = 10 * 60 * 1000;

function makeCode(): string {
    const bytes = randomBytes(PAIRING_CODE_LEN);
    let out = '';
    for (let i = 0; i < PAIRING_CODE_LEN; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    return out;
}

/** SHA-256 hex. The device token is never stored in the clear. */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * What kind of machine a paired witness device is (v2.163.0). `atgames` is a
 * cabinet running the Arcaid Witness app, keyed on its ATGAMES_UNIQUE_ID;
 * `desktop` is the Castcade companion on a Windows VPX rig
 * (https://github.com/mekelburgj20/castcade, its ADR 0003), keyed on a UUID it
 * generates once per install. Informational — nothing gates on it. The column
 * stays `atgames_unique_id` for both: renaming it would touch every table and
 * query in the witness family for no behavioural gain.
 */
export type WitnessDeviceType = 'atgames' | 'desktop';
export const WITNESS_DEVICE_TYPES: readonly WitnessDeviceType[] = ['atgames', 'desktop'];
export function isWitnessDeviceType(value: unknown): value is WitnessDeviceType {
    return typeof value === 'string' && (WITNESS_DEVICE_TYPES as readonly string[]).includes(value);
}

export interface WitnessDevice {
    atgamesUniqueId: string;
    atgamesUsername: string | null;
    deviceType: WitnessDeviceType;
    pairedAt: string;
    lastSeenAt: string | null;
    /**
     * Score routing. v2.175.0 (W37): a null room means ALL MY ROOMS unless
     * `globalOnly` is set ("Global Scoreboard only", ADR 0032). A room narrows
     * to that room, a tournament to that tournament (optional, never needed).
     */
    targetRoomId: string | null;
    targetRoomName: string | null;
    targetTournamentId: string | null;
    targetTournamentName: string | null;
    globalOnly: boolean;
    globalFallback: boolean;
}

export class WitnessTargetError extends Error {
    readonly code: 'NOT_FOUND' | 'NOT_A_MEMBER' | 'TOURNAMENT_NOT_IN_ROOM';
    constructor(code: WitnessTargetError['code'], message: string) {
        super(message);
        this.code = code;
        this.name = 'WitnessTargetError';
    }
}

export class WitnessPairError extends Error {
    readonly code: 'CODE_INVALID' | 'CODE_EXPIRED' | 'CODE_USED' | 'DEVICE_CONFLICT' | 'DEVICE_TYPE_INVALID';
    constructor(code: WitnessPairError['code'], message: string) {
        super(message);
        this.name = 'WitnessPairError';
        this.code = code;
    }
}

export class WitnessService {
    /**
     * Mint a short-lived pairing code for a logged-in player. They type it into
     * the Witness app on the cabinet, which redeems it.
     *
     * A player may only have one live code at a time — minting a new one
     * expires any earlier unconsumed codes, so a screen full of stale codes
     * can't accumulate.
     */
    static async createPairingCode(canonicalUserId: string): Promise<{ code: string; expiresAt: string }> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_pairing_codes SET expires_at = datetime('now')
              WHERE canonical_user_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
            canonicalUserId,
        );

        // Expiry is stored and compared in SQLite's own datetime format
        // throughout — a JS ISO string ('…Z') and `datetime('now')` (space,
        // no zone) do NOT string-compare, and `Date.parse` mishandles the
        // latter, so the JS side never touches the comparison.
        const ttlMinutes = Math.round(PAIRING_TTL_MS / 60000);
        for (let attempt = 0; attempt < 6; attempt++) {
            const code = makeCode();
            try {
                await db.run(
                    `INSERT INTO witness_pairing_codes (code, canonical_user_id, expires_at)
                     VALUES (?, ?, datetime('now', ?))`,
                    code, canonicalUserId, `+${ttlMinutes} minutes`,
                );
                const stored = await db.get<{ expires_at: string }>(
                    'SELECT expires_at FROM witness_pairing_codes WHERE code = ?', code,
                );
                logInfo(`Witness: pairing code minted for ${canonicalUserId}`);
                return { code, expiresAt: stored?.expires_at ?? '' };
            } catch {
                // PK clash — try another code.
            }
        }
        throw new Error('Witness: could not mint a unique pairing code');
    }

    /**
     * Redeem a pairing code from the device (GET). Binds the code's owner to
     * this device id and returns a fresh device token (plaintext, once — only
     * the hash is stored). Re-pairing the SAME device rotates its token (and
     * takes the type it now declares); pairing a device already owned by
     * someone else is refused.
     *
     * The device id is opaque here: an ATGAMES_UNIQUE_ID from a cabinet or a
     * UUID from the Castcade companion. It is trimmed and must be non-empty;
     * no shape is enforced, so a desktop id needs no special case.
     * `deviceType` defaults to 'atgames' because every cabinet build omits it;
     * an unknown value is refused BEFORE the code is looked up, so a typo in
     * the companion does not burn a single-use code.
     */
    static async redeemPairingCode(
        rawCode: string, atgamesUniqueId: string, atgamesUsername: string | null,
        deviceType: string = 'atgames',
    ): Promise<{ token: string }> {
        const code = (rawCode || '').trim().toUpperCase();
        const deviceId = (atgamesUniqueId || '').trim();
        if (!code || !deviceId) throw new WitnessPairError('CODE_INVALID', 'A pairing code and device id are required');
        if (!isWitnessDeviceType(deviceType)) {
            throw new WitnessPairError('DEVICE_TYPE_INVALID', `Unknown device type; expected one of ${WITNESS_DEVICE_TYPES.join(', ')}`);
        }

        const db = await getDatabase();
        const row = await db.get<{ canonical_user_id: string; consumed_at: string | null; is_expired: number }>(
            `SELECT canonical_user_id, consumed_at,
                    (expires_at <= datetime('now')) AS is_expired
             FROM witness_pairing_codes WHERE code = ?`,
            code,
        );
        if (!row) throw new WitnessPairError('CODE_INVALID', 'That pairing code is not valid');
        if (row.consumed_at) throw new WitnessPairError('CODE_USED', 'That pairing code has already been used');
        if (row.is_expired) throw new WitnessPairError('CODE_EXPIRED', 'That pairing code has expired');

        // A device belongs to one Arcaid account. Re-pairing to the SAME owner
        // is a token rotation (fine); a DIFFERENT owner is refused, or one
        // player could hijack another's cabinet trail.
        const existing = await db.get<{ canonical_user_id: string }>(
            `SELECT canonical_user_id FROM witness_devices WHERE atgames_unique_id = ? AND revoked_at IS NULL`,
            deviceId,
        );
        if (existing && existing.canonical_user_id !== row.canonical_user_id) {
            throw new WitnessPairError('DEVICE_CONFLICT', 'This device is already linked to a different Arcaid account');
        }

        const token = randomBytes(32).toString('base64url');
        const tokenHash = hashToken(token);

        await db.exec('BEGIN');
        try {
            await db.run(
                `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, atgames_username, device_type, token_hash, revoked_at)
                 VALUES (?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(atgames_unique_id) DO UPDATE SET
                    canonical_user_id = excluded.canonical_user_id,
                    atgames_username = excluded.atgames_username,
                    device_type = excluded.device_type,
                    token_hash = excluded.token_hash,
                    revoked_at = NULL`,
                deviceId, row.canonical_user_id, atgamesUsername || null, deviceType, tokenHash,
            );
            await db.run(
                `UPDATE witness_pairing_codes SET consumed_at = datetime('now'), consumed_device_id = ? WHERE code = ?`,
                deviceId, code,
            );
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        logInfo(`Witness: ${deviceType} device ${deviceId} paired to ${row.canonical_user_id}`);
        return { token };
    }

    /**
     * Record one witnessed table session from the device (GET). Returns false
     * when the device/token is unknown, revoked, or mismatched — the ROUTE
     * turns that into a 401 and the rate limiter caps abuse; this method never
     * reveals which of the two was wrong.
     *
     * Idempotent: a repeated (device, table, launch) is a no-op success, so the
     * device may safely retry a GET whose response it never saw.
     */
    static async recordObservation(input: {
        atgamesUniqueId: string;
        token: string;
        tableName: string;
        launchTs: number;
        exitTs?: number | null;
        durationSec?: number | null;
        /**
         * `'retro'` = derived after the fact from on-disk traces rather than
         * seen live by the resident beacon. ANY other value (including absent)
         * is `'live'` — a tag this permissive must fail closed to the stronger
         * claim being the DEFAULT, never to a caller's typo silently marking a
         * live report as retro. Same trust either way (ADR 0021); the column
         * exists so the distinction survives for later analysis.
         */
        via?: string | null;
        /**
         * What the observation IS: the beacon's table `'session'` (default) or
         * one `'game'` inside it, filed by the VPX score ingest. The two are
         * keyed apart because the first game of a sitting starts at the same
         * second the session does — on a (device, table, launch) key alone the
         * game row collided with the session row and was swallowed, so game 1
         * of every multi-game sitting had no observation whose exit matched
         * its score and verified as `unwitnessed` (round 8, 2026-09-06).
         */
        kind?: 'session' | 'game';
        /**
         * `'exit'` (v2.158.0) — this GAME row is an EXIT SAMPLE: a no-ROM
         * table's single score reading taken when the player left, with no
         * game start of its own. Its `launch_ts` is the SESSION's launch (the
         * earliest the game could have begun), substituted by the cabinet.
         * The verify join reads it to refuse `flagged` on evidence that
         * cannot tell a geared-up game from a clean one (ADR 0022 addendum).
         * NULL = a fully observed game or session.
         */
        sample?: 'exit' | null;
        /**
         * v2.160.0 — the launcher's ball-1 restart tally for this GAME
         * (`restarts=N` on the wire since rc8), and whether the score sent was
         * a ball-sum FLOOR because the launcher wrote 0 for one ball. Game
         * rows only; informational, surfaced on the verdict, never a gate.
         */
        restarts?: number | null;
        partial?: boolean | null;
    }): Promise<boolean> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        const table = (input.tableName || '').trim();
        if (!deviceId || !input.token || !table || !Number.isFinite(input.launchTs)) return false;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return false;

        const db = await getDatabase();
        const launch = Math.floor(input.launchTs);
        const exit = input.exitTs != null && Number.isFinite(input.exitTs) ? Math.floor(input.exitTs) : null;
        const duration = input.durationSec != null && Number.isFinite(input.durationSec)
            ? Math.floor(input.durationSec)
            : (exit != null ? exit - launch : null);
        const via = input.via === 'retro' ? 'retro' : 'live';
        const kind = input.kind === 'game' ? 'game' : 'session';
        const sample = input.sample === 'exit' ? 'exit' : null;
        const restarts = input.restarts != null && Number.isFinite(input.restarts) && input.restarts >= 0
            ? Math.floor(input.restarts) : null;
        const partial = input.partial == null ? null : (input.partial ? 1 : 0);

        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind, sample, restarts, partial)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(atgames_unique_id, table_name, launch_ts, kind) DO UPDATE SET
                exit_ts = COALESCE(excluded.exit_ts, witness_observations.exit_ts),
                duration_sec = COALESCE(excluded.duration_sec, witness_observations.duration_sec),
                sample = COALESCE(witness_observations.sample, excluded.sample),
                restarts = COALESCE(witness_observations.restarts, excluded.restarts),
                partial = COALESCE(witness_observations.partial, excluded.partial)`,
            // `via` is deliberately absent from the DO UPDATE: first writer
            // wins. A retro sweep that re-reports a session the beacon already
            // saw live must not downgrade it, and a live report arriving after
            // a retro row must not overstate what was actually observed.
            // `sample` follows the same first-writer rule: once a row is known
            // to be an exit sample a re-send cannot promote it to a full game.
            deviceId, device.canonical_user_id, table, launch, exit, duration, via, kind, sample, restarts, partial,
        );
        await WitnessService.touchDevice(deviceId);
        return true;
    }

    /**
     * Record one round-start CHECK-IN from the device (GET) — tier 2 of the
     * three-tier trust model (ADR 0021).
     *
     * These cabinets run one thing at a time: the Witness app being in the
     * FOREGROUND at time T proves no table was mid-session at T. So a score
     * exited after a check-in that happened at/after the round opened was
     * necessarily launched inside the window, even when the beacon produced no
     * session observation to join.
     *
     * The timestamp is the SERVER's and only ever the server's — that is the
     * entire point. A device-supplied time would make the attestation a
     * self-report, and tier 2 would prove nothing.
     *
     * Returns false for unknown / revoked / wrong-token, exactly like
     * `recordObservation`, so the ROUTE can answer with one undifferentiated
     * 401. Repeated check-ins are expected and are NOT deduped: each one is
     * another attestation point, and more of them can only ever help.
     */
    static async recordCheckin(atgamesUniqueId: string, token: string): Promise<{ ts: string; canonicalUserId: string } | null> {
        const deviceId = (atgamesUniqueId || '').trim();
        if (!deviceId || !token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, token);
        if (!device) return null;

        const db = await getDatabase();
        const res = await db.run(
            `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts)
             VALUES (?, ?, datetime('now'))`,
            deviceId, device.canonical_user_id,
        ) as { lastID?: number };
        await WitnessService.touchDevice(deviceId);

        const stored = await db.get<{ server_ts: string }>(
            'SELECT server_ts FROM witness_checkins WHERE id = ?', res.lastID,
        );
        return { ts: stored?.server_ts ?? '', canonicalUserId: device.canonical_user_id };
    }

    /**
     * Record one VPXS score the Witness read off the cabinet's own stick (P9).
     *
     * Same device-token auth and same undifferentiated failure as the other two
     * device-facing writers, for the same reason. What differs is that this one
     * can succeed at AUTHENTICATION and still decline to record: a score whose
     * table matches no open game of this player is a perfectly normal event
     * (they played something that is not in a tournament), and the device must
     * be told "accepted, not matched" rather than "unauthorised", or it would
     * retry forever against a wall.
     *
     * Returns `null` ONLY for an auth failure, so the route can keep answering
     * a bare 401 for that and 200 for everything else.
     */
    static async recordVpxScore(input: {
        atgamesUniqueId: string;
        token: string;
        tableName: string;
        rom?: string | null;
        slug?: string | null;
        score: number;
        startedTs: number;
        endedTs: number;
        durationSec?: number | null;
        reason?: string | null;
        via?: string | null;
        restarts?: number | null;
        partial?: boolean | null;
        /** v2.165.0 (ADR 0027) — what the Castcade companion measured; null from a cabinet. */
        evidence?: import('../utils/sanctionedRules.js').WitnessEvidence | null;
        /** v2.166.0 — `pc` | `vr_headset` from a desktop; ignored from a cabinet. */
        playDevice?: import('./VpxScoreIngestService.js').PlayDevice | null;
        /** v2.167.0 (ADR 0029) — the game START's key from `/witness/attempt`. */
        attemptKey?: string | null;
        /** v2.180.0 (W48) — the launcher's per-ball points for this game, raw (cabinet 1.0.6+). */
        ballPoints?: number[] | null;
        /** v2.189.0 (W49) — quit before game over (Castcade companion); null = unknown. */
        quit?: import('../utils/quitEvidence.js').QuitEvidence | null;
    }): Promise<(import('./VpxScoreIngestService.js').VpxIngestResult & { deviceType: WitnessDeviceType }) | null> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        if (!deviceId || !input.token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return null;

        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);
        const ingested = await VpxScoreIngestService.ingest({
            canonicalUserId: device.canonical_user_id,
            // v2.163.0 — what kind of machine this is decides the score's
            // `device`/`platform` provenance (cabinet → atgames/vpxs, desktop →
            // pc/vpx). Never inferred from the table or the name.
            deviceType: device.device_type,
            target,
            deviceId,
            evidence: input.evidence ?? null,
            playDevice: input.playDevice ?? null,
            attemptKey: input.attemptKey ?? null,
            restarts: input.restarts ?? null,
            ballPoints: input.ballPoints ?? null,
            quit: input.quit ?? null,
            tableName: (input.tableName || '').trim(),
            rom: input.rom ?? null,
            slug: input.slug ?? null,
            score: input.score,
            startedTs: input.startedTs,
            endedTs: input.endedTs,
            durationSec: input.durationSec ?? null,
            reason: input.reason ?? null,
        });
        const result = { ...ingested, deviceType: device.device_type };

        // A matched VPX score also files its own OBSERVATION, and that is the
        // whole reason the verify layer needs no VPX-specific rule:
        //
        // The launcher's record carries the GAME's start and end, which is
        // finer-grained than the table SESSION the resident detector sees — one
        // VPX session routinely contains several games. Verifying a VPX score
        // against the session's launch time would flag every second and third
        // game of a legitimate sitting, because the session began before the
        // round did. Filing the game itself as an observation makes the
        // existing tier-1 join answer the right question: the exit matches the
        // score's timestamp exactly, and the launch it compares against the
        // round start is the GAME's launch.
        // A `'suppressed'` play (ADR 0024 — the player deleted it) files NO
        // observation: there is no score left for it to witness.
        if (result.status === 'ingested' || result.status === 'duplicate') {
            await WitnessService.recordObservation({
                atgamesUniqueId: deviceId,
                token: input.token,
                tableName: (input.tableName || '').trim(),
                launchTs: Math.floor(input.startedTs),
                exitTs: Math.floor(input.endedTs),
                durationSec: input.durationSec ?? null,
                via: input.via ?? null,
                kind: 'game',
                // v2.158.0 — a no-ROM table's exit sample carries the SESSION
                // launch as its start (the cabinet has nothing finer). Mark the
                // row so the verify join knows this launch is a bound, not a
                // measurement; before this the server logged `reason` and
                // dropped it, and an exit sample from a table opened before
                // the round read as `flagged` (SPRINT_STATUS #144/#150).
                sample: input.reason === 'exit_sample' ? 'exit' : null,
                restarts: input.restarts ?? null,
                partial: input.partial ?? null,
            });
        } else if (result.status === 'no_match' || result.status === 'invalid' || result.status === 'not_sanctioned' || result.status === 'attempt_refused') {
            // A 200 the device will never retry, so this line is the ONLY
            // trace the score leaves. Round 8 (2026-09-06) lost two of six
            // scores to a cabinet-side naming bug (`table=t2_l8`) and the
            // prod log showed nothing at all — the diagnosis had to come from
            // the cabinet's own log. Name everything the matcher was given.
            logWarn(
                `VPX ingest: ${result.status} for ${device.canonical_user_id} — ` +
                `table="${(input.tableName || '').trim()}" rom="${input.rom ?? ''}" slug="${input.slug ?? ''}" ` +
                `score=${input.score} ended=${input.endedTs}` +
                (result.reason ? ` (${result.reason})` : ''),
            );
        }

        await WitnessService.touchDevice(deviceId);
        return result;
    }

    /**
     * Limited attempts (v2.167.0, ADR 0029): the companion reports a game
     * START the moment it happens. Same device-token auth as the score call
     * and the same `null` = bare 401 contract. The game is decided by the
     * score call's own matching (`VpxScoreIngestService.match`), so an attempt
     * and its score cannot land on different games; the window is tested
     * against the START.
     *
     * Answers `counted` / `over_limit` (AttemptService), `unlimited` when
     * the matched game's tournament has no limit (nothing recorded), or
     * `no_match` (no open game, or two — never a guess).
     */
    static async recordAttempt(input: {
        atgamesUniqueId: string;
        token: string;
        tableName: string;
        rom?: string | null;
        slug?: string | null;
        startedTs: number;
        key: string;
        players?: number | null;
        evidence?: import('../utils/sanctionedRules.js').WitnessEvidence | null;
        playDevice?: import('./VpxScoreIngestService.js').PlayDevice | null;
        /** Cabinet only (1.0.4): the end of a game it detected but cannot score. */
        endedTs?: number | null;
        /** Cabinet only: `no_score` | `short_game` — stored as the row's note. */
        reason?: string | null;
    }): Promise<{
        status: 'counted' | 'over_limit' | 'unlimited' | 'no_match' | 'invalid';
        game: string | null;
        attempt: number | null;
        of: number | null;
        remaining: number | null;
        late: boolean;
        reason?: string;
    } | null> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        if (!deviceId || !input.token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return null;

        const empty = { game: null, attempt: null, of: null, remaining: null, late: false };
        const startedTs = Math.floor(Number(input.startedTs));
        const key = (input.key || '').trim();
        if (!Number.isFinite(startedTs) || startedTs <= 0 || !key) {
            await WitnessService.touchDevice(deviceId);
            return { status: 'invalid', ...empty, reason: !key ? 'key missing' : 'start timestamp missing' };
        }

        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);
        const tableName = (input.tableName || '').trim();
        const matched = await VpxScoreIngestService.match({
            canonicalUserId: device.canonical_user_id,
            deviceType: device.device_type,
            target,
            deviceId,
            evidence: input.evidence ?? null,
            playDevice: input.playDevice ?? null,
            tableName,
            rom: input.rom ?? null,
            slug: input.slug ?? null,
            score: 0,
            startedTs,
            // The window is tested against the START: an attempt is a start.
            endedTs: startedTs,
        });
        await WitnessService.touchDevice(deviceId);
        if (matched.kind !== 'target') {
            return {
                status: 'no_match', ...empty,
                reason: matched.kind === 'ambiguous'
                    ? `"${tableName}" matches ${matched.count} open games — not guessing which`
                    : `no open game matched "${tableName}"`,
            };
        }
        // v2.175.0 (W37, ADR 0033): the play counts in every tournament it
        // matches, so its START uses an attempt in EACH limited one (the
        // attempt key is unique per game since migration 192). The answer is
        // the first limited tournament's, which is all the companion shows.
        const limited = matched.targets.filter(g => g.max_attempts != null && g.max_attempts >= 1 && g.tournament_id);
        if (limited.length === 0) {
            return { status: 'unlimited', ...empty, game: matched.target.name };
        }
        const { AttemptService, ATTEMPT_REFUSAL_TEXT, playIsStarted } = await import('./AttemptService.js');
        // W38 (ADR 0033 §4) — a table that needs "Start attempts" counts a game
        // only when it began at or after the player's press; before that the
        // start uses nothing (its score will go to Global, `not_started`).
        const needsStart = limited.filter(g => g.require_attempt_start === 1).map(g => g.id);
        const starts = needsStart.length > 0
            ? await AttemptService.startsFor(device.canonical_user_id, needsStart)
            : {};
        const counting = limited.filter(g => g.require_attempt_start !== 1 || playIsStarted(starts[g.id], startedTs));
        if (counting.length === 0) {
            // Not a new wire status: a pre-W38 companion already shows
            // `no_match` with its reason.
            return { status: 'no_match', ...empty, game: limited[0]!.name, reason: ATTEMPT_REFUSAL_TEXT.not_started };
        }
        let first: { status: 'counted' | 'over_limit'; game: string; attempt: number; of: number; remaining: number; late: boolean } | null = null;
        for (const game of counting) {
            const started = await AttemptService.recordStart({
                tournamentId: game.tournament_id!, gameId: game.id, gameRoomId: game.game_room_id,
                canonicalUserId: device.canonical_user_id, deviceId, key, limit: game.max_attempts!,
                startedTs, players: input.players ?? null, tableName, rom: input.rom ?? null,
                // A cabinet reports after the fact by design (an abandoned or short
                // game it could not score), so it is never late; its reason and
                // end ride on the row.
                cabinet: device.device_type !== 'desktop',
                endedTs: device.device_type !== 'desktop' ? (input.endedTs ?? null) : null,
                note: device.device_type !== 'desktop' ? (input.reason ?? null) : null,
            });
            if (!started) return { status: 'invalid', ...empty, reason: 'key missing' };
            logInfo(
                `Witness attempt: ${device.canonical_user_id} ${started.status} ${started.attempt} of ${started.of} ` +
                `on "${game.name}" (tournament ${game.tournament_id}${started.late ? ', LATE' : ''}${started.resent ? ', resend' : ''})`,
            );
            first ??= {
                status: started.status, game: game.name,
                attempt: started.attempt, of: started.of, remaining: started.remaining, late: started.late,
            };
        }
        return first!;
    }

    /**
     * v2.188.0 (W45, ADR 0033 §4) — the device presses "Start attempts": the
     * device-token twin of the web button (`AttemptService.startForPlayer`).
     * Same auth and the same `null` = bare 401 contract as `recordAttempt`.
     *
     * The tables pressed are never re-derived here: they are the
     * `requireStart` games of `VpxScoreIngestService.openLimitedGames` — the
     * SAME candidates, routing, entry, window and device-exclusion filters the
     * ingest applies, and exactly what the heartbeat's attempts line lists as
     * NOT STARTED — so the press can never start a table a play from this
     * device would not land on. Naming a table (`table`/`rom`/`slug`/
     * `vps_game`) narrows the press to the games that table's play would land
     * on, decided by the score call's own `match` (one row per tournament it
     * matches, ADR 0033). The write is `AttemptService.startAttempts` with
     * `source: 'device'`: idempotent, the FIRST press wins.
     *
     * Answers `started` (at least one game in `started`, even if every one was
     * already started), `nothing_to_start` (no open start-required limited
     * game routes from this device), or `no_match` (a table was named and it
     * is not one of them). Never an error for a bad query: a cabinet never
     * retries a 200, and a desktop just shows the answer.
     */
    static async startAttemptsFromDevice(input: {
        atgamesUniqueId: string;
        token: string;
        tableName?: string | null;
        rom?: string | null;
        slug?: string | null;
        evidence?: import('../utils/sanctionedRules.js').WitnessEvidence | null;
        playDevice?: import('./VpxScoreIngestService.js').PlayDevice | null;
        nowSec?: number;
    }): Promise<{
        canonicalUserId: string;
        status: 'started' | 'nothing_to_start' | 'no_match';
        started: Array<{ game: string; gameId: string; tournamentId: string; startedTs: number; alreadyStarted: boolean }>;
        reason?: string;
    } | null> {
        const deviceId = (input.atgamesUniqueId || '').trim();
        if (!deviceId || !input.token) return null;

        const device = await WitnessService.authenticateDevice(deviceId, input.token);
        if (!device) return null;

        const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
        const canonicalUserId = device.canonical_user_id;
        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const { AttemptService } = await import('./AttemptService.js');
        const target = await WitnessService.getDeviceTarget(deviceId);

        const open = (await VpxScoreIngestService.openLimitedGames({
            canonicalUserId, target, deviceType: device.device_type, playDevice: input.playDevice, nowTs: nowSec,
        })).filter(g => g.requireStart);
        await WitnessService.touchDevice(deviceId);
        if (open.length === 0) {
            return {
                canonicalUserId, status: 'nothing_to_start', started: [],
                reason: 'no limited-attempts table needing Start attempts is open for this device',
            };
        }

        const tableName = (input.tableName || '').trim();
        const named = !!(tableName || (input.rom || '').trim() || (input.slug || '').trim() || input.evidence?.vpsGame);
        let chosen = open;
        if (named) {
            const label = tableName || input.rom || input.slug || input.evidence?.vpsGame || '';
            // The score call's own matching, at the press moment (a play
            // started now is what this press is for).
            const matched = await VpxScoreIngestService.match({
                canonicalUserId,
                deviceType: device.device_type,
                target,
                deviceId,
                evidence: input.evidence ?? null,
                playDevice: input.playDevice ?? null,
                tableName,
                rom: input.rom ?? null,
                slug: input.slug ?? null,
                score: 0,
                startedTs: nowSec,
                endedTs: nowSec,
            });
            const ids = new Set(matched.kind === 'target' ? matched.targets.map(t => t.id) : []);
            chosen = open.filter(g => ids.has(g.gameId));
            if (chosen.length === 0) {
                return {
                    canonicalUserId, status: 'no_match', started: [],
                    reason: matched.kind === 'ambiguous'
                        ? `"${label}" matches ${matched.count} open games — not guessing which`
                        : `"${label}" is not an open limited-attempts table needing Start attempts for this device`,
                };
            }
        }

        const before = await AttemptService.startsFor(canonicalUserId, chosen.map(g => g.gameId));
        const started = [];
        for (const game of chosen) {
            const startedTs = await AttemptService.startAttempts({
                tournamentId: game.tournamentId, gameId: game.gameId, canonicalUserId,
                source: 'device', nowSec,
            });
            started.push({
                game: game.gameName, gameId: game.gameId, tournamentId: game.tournamentId,
                startedTs, alreadyStarted: before[game.gameId] != null,
            });
            logInfo(
                `Witness attempt-start: ${canonicalUserId} ${before[game.gameId] != null ? 'already started' : 'started'} ` +
                `"${game.gameName}" (tournament ${game.tournamentId}) from device`,
            );
        }
        return { canonicalUserId, status: 'started', started };
    }

    /**
     * The ONE device-token check. Both device-facing writers go through it so
     * they cannot drift on what "authenticated" means, and so neither can ever
     * reveal WHICH of device/token/revocation was wrong.
     */
    private static async authenticateDevice(
        deviceId: string, token: string,
    ): Promise<{ canonical_user_id: string; device_type: WitnessDeviceType } | null> {
        const db = await getDatabase();
        const device = await db.get<{
            canonical_user_id: string; token_hash: string; revoked_at: string | null; device_type: string | null;
        }>(
            `SELECT canonical_user_id, token_hash, revoked_at, device_type FROM witness_devices WHERE atgames_unique_id = ?`,
            deviceId,
        );
        if (!device || device.revoked_at || device.token_hash !== hashToken(token)) return null;
        // The type rides with the auth result because it is PROVENANCE: a
        // score's `device` column is decided by what kind of machine posted it
        // (v2.163.0), and the ingest must not have to look the row up again.
        return {
            canonical_user_id: device.canonical_user_id,
            device_type: device.device_type === 'desktop' ? 'desktop' : 'atgames',
        };
    }

    private static async touchDevice(deviceId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_devices SET last_seen_at = datetime('now') WHERE atgames_unique_id = ?`,
            deviceId,
        );
    }

    /**
     * The 1.0.4 cabinet's "still here" (v2.160.0). Stamps `heartbeat_at` and
     * `last_seen_at`; writes nothing else and attests nothing. Its only reader
     * is the event check-in lobby, which shows a cabinet that has gone quiet
     * since its check-in as "not responding" — and ONLY for cabinets that have
     * ever sent one, so a pre-1.0.4 cabinet is never read as offline.
     */
    static async recordHeartbeat(atgamesUniqueId: string, token: string): Promise<{ canonicalUserId: string } | null> {
        const deviceId = (atgamesUniqueId || '').trim();
        if (!deviceId || !token) return null;
        const device = await WitnessService.authenticateDevice(deviceId, token);
        if (!device) return null;
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_devices SET heartbeat_at = datetime('now'), last_seen_at = datetime('now')
              WHERE atgames_unique_id = ?`,
            deviceId,
        );
        return { canonicalUserId: device.canonical_user_id };
    }

    /**
     * Point a cabinet at a room (and optionally one tournament in it), or clear
     * the designation by passing nulls.
     *
     * The validation is the whole value of this method: a designation the
     * player could not legitimately score into would send their scores
     * somewhere they cannot see, which is worse than having no designation at
     * all. So the room must be one they belong to, and the tournament must
     * belong to that room.
     */
    static async setDeviceTarget(canonicalUserId: string, deviceId: string, target: {
        roomId?: string | null;
        tournamentId?: string | null;
        /** v2.175.0 (W37) — "Global Scoreboard only"; ignored when a room is set. */
        globalOnly?: boolean;
        globalFallback?: boolean;
    }): Promise<WitnessDevice> {
        const db = await getDatabase();
        const device = await db.get<{
            atgames_unique_id: string; target_room_id: string | null; target_tournament_id: string | null;
            global_only: number | null; global_fallback: number | null;
        }>(
            `SELECT atgames_unique_id, target_room_id, target_tournament_id, global_only, global_fallback
               FROM witness_devices
              WHERE atgames_unique_id = ? AND canonical_user_id = ? AND revoked_at IS NULL`,
            deviceId, canonicalUserId,
        );
        if (!device) throw new WitnessTargetError('NOT_FOUND', 'No such cabinet paired to your account');

        const roomId = target.roomId ?? null;
        // Clearing the room clears the tournament with it: a tournament
        // designation without its room is a dangling pointer that would outlive
        // the choice the player actually made.
        const tournamentId = roomId ? (target.tournamentId ?? null) : null;

        if (roomId) {
            const member = await db.get<{ user_id: string }>(
                `SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?`,
                roomId, canonicalUserId,
            );
            if (!member) {
                throw new WitnessTargetError('NOT_A_MEMBER', 'You are not a member of that room');
            }
        }
        if (tournamentId) {
            const tournament = await db.get<{ id: string }>(
                `SELECT id FROM tournaments WHERE id = ? AND game_room_id = ?`,
                tournamentId, roomId,
            );
            if (!tournament) {
                throw new WitnessTargetError('TOURNAMENT_NOT_IN_ROOM', 'That tournament is not in that room');
            }
        }

        // A room (or tournament) narrows; with no room the device is either
        // All my rooms (default) or Global Scoreboard only.
        const globalOnly = !roomId && target.globalOnly === true ? 1 : 0;
        await db.run(
            `UPDATE witness_devices
                SET target_room_id = ?, target_tournament_id = ?, global_only = ?, global_fallback = ?
              WHERE atgames_unique_id = ? AND canonical_user_id = ?`,
            roomId, tournamentId, globalOnly,
            target.globalFallback === false ? 0 : 1,
            deviceId, canonicalUserId,
        );

        // W29 (v2.181.0) — record the change (who, from, to) so a play that
        // went somewhere unexpected can be lined up against what the device was
        // pointed at when it arrived. Only a real change is written; a save of
        // the same choice is not. Best-effort: never costs the change itself.
        const from = {
            roomId: device.target_room_id, tournamentId: device.target_tournament_id,
            globalOnly: device.global_only === 1, globalFallback: device.global_fallback !== 0,
        };
        const to = { roomId, tournamentId, globalOnly: globalOnly === 1, globalFallback: target.globalFallback !== false };
        if (JSON.stringify(from) !== JSON.stringify(to)) {
            try {
                const { AuditService } = await import('./AuditService.js');
                await AuditService.log({
                    actor: canonicalUserId,
                    action: 'witness_target_change',
                    target_type: 'witness_device',
                    target_id: deviceId,
                    details: JSON.stringify({ from: { ...from, label: targetLabel(from) }, to: { ...to, label: targetLabel(to) } }),
                    ip_address: '',
                    correlation_id: '',
                });
            } catch (err) {
                logWarn(`Witness: target change not audited for ${deviceId} (${err instanceof Error ? err.message : String(err)})`);
            }
        }

        const devices = await WitnessService.listDevices(canonicalUserId);
        return devices.find(d => d.atgamesUniqueId === deviceId)!;
    }

    /**
     * The routing a score from this cabinet should follow.
     *
     * A designated tournament that has FINISHED is treated as absent rather
     * than cleared: a stale pointer must not quietly swallow scores weeks after
     * the event, and read-time expiry needs no cleanup job to stay correct.
     * "Finished" is the W33 open-card rule (`utils/openCard.ts`): a PAUSED
     * rotation is not finished, so a designation pointing at one holds.
     */
    static async getDeviceTarget(deviceId: string): Promise<{
        roomId: string | null; tournamentId: string | null; globalOnly: boolean; globalFallback: boolean;
    }> {
        const db = await getDatabase();
        const row = await db.get<{
            target_room_id: string | null; target_tournament_id: string | null;
            global_only: number; global_fallback: number; tournament_finished: number | null;
        }>(
            `SELECT d.target_room_id, d.target_tournament_id, d.global_only, d.global_fallback,
                    ${tournamentFinishedSql('t')} AS tournament_finished
               FROM witness_devices d
               LEFT JOIN tournaments t ON t.id = d.target_tournament_id
              WHERE d.atgames_unique_id = ?`,
            deviceId,
        );
        if (!row) return { roomId: null, tournamentId: null, globalOnly: false, globalFallback: true };
        const tournamentId = row.target_tournament_id && row.tournament_finished === 1
            ? null
            : row.target_tournament_id;
        return {
            roomId: row.target_room_id,
            tournamentId,
            globalOnly: !row.target_room_id && row.global_only === 1,
            globalFallback: row.global_fallback !== 0,
        };
    }

    /**
     * W27.3 (ADR 0033 §5) — for each of the player's paired devices: do its
     * scores reach THIS room? Answers the "Your scores go to" line on a room
     * page through `deviceRoutesTo`, the ONE routing rule the ingest and the
     * lobby use, with the device's EFFECTIVE target (a finished pinned
     * tournament reads as absent), so the line can never disagree with where a
     * score goes. Room-level only: whether a play is then allowed into a given
     * tournament (check-in, roster) is per play, and "Where your plays went"
     * says so per play.
     *
     * - `yes` — every open tournament here the player is in.
     * - `one_tournament` — pinned to one tournament in this room.
     * - `entered_only` — "All my rooms", not a member, but entered directly
     *   into a tournament here (checked in / admin-added / on its roster).
     * - `no` + why: `global_only`, `other_room`, `other_tournament`, `not_member`.
     */
    static async routingForRoom(canonicalUserId: string, roomId: string): Promise<Array<{
        deviceId: string; deviceType: WitnessDeviceType;
        sendsHere: 'yes' | 'one_tournament' | 'entered_only' | 'no';
        why: 'global_only' | 'other_room' | 'other_tournament' | 'not_member' | null;
        targetRoomName: string | null; targetTournamentName: string | null;
    }>> {
        const db = await getDatabase();
        const devices = await WitnessService.listDevices(canonicalUserId);
        if (devices.length === 0) return [];
        const member = !!(await db.get(
            `SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`, roomId, canonicalUserId,
        ));
        const entered = !member && !!(await db.get(
            `SELECT 1 FROM tournaments t
              WHERE t.game_room_id = ?
                AND (EXISTS (SELECT 1 FROM tournament_participants tp WHERE tp.tournament_id = t.id AND tp.user_id = ?)
                  OR EXISTS (SELECT 1 FROM tournament_roster tr WHERE tr.tournament_id = t.id AND tr.user_id = ?))`,
            roomId, canonicalUserId, canonicalUserId,
        ));
        const { deviceRoutesTo } = await import('../utils/witnessRouting.js');
        const out = [];
        for (const d of devices) {
            const target = await WitnessService.getDeviceTarget(d.atgamesUniqueId);
            const routes = deviceRoutesTo(target, {
                roomId, tournamentId: target.tournamentId, isRound: false,
                isParticipant: entered, isMember: member,
            });
            const sendsHere = !routes ? 'no' as const
                : target.tournamentId ? 'one_tournament' as const
                : !member ? 'entered_only' as const
                : 'yes' as const;
            const why = routes ? null
                : target.tournamentId ? 'other_tournament' as const
                : target.roomId ? 'other_room' as const
                : target.globalOnly ? 'global_only' as const
                : 'not_member' as const;
            out.push({
                deviceId: d.atgamesUniqueId, deviceType: d.deviceType, sendsHere, why,
                targetRoomName: d.targetRoomName,
                targetTournamentName: target.tournamentId ? d.targetTournamentName : null,
            });
        }
        return out;
    }

    /**
     * One short human line naming where this cabinet's scores go, for the app
     * to print on its status screen.
     *
     * This is the whole defence against a stale designation: a player who
     * pointed the cabinet at last Tuesday's event and forgot sees it at the
     * moment they open the Witness to check in, rather than discovering it when
     * their scores are missing from tonight's board.
     */
    static async describeTarget(deviceId: string): Promise<string> {
        const target = await WitnessService.getDeviceTarget(deviceId);
        // v2.175.0 (W37): no room = All my rooms (the default) unless the
        // player opted out to the Global Scoreboard only.
        if (!target.roomId) return target.globalOnly ? 'Global Scoreboard only' : 'All your rooms';

        const db = await getDatabase();
        const room = await db.get<{ name: string }>(
            'SELECT name FROM game_rooms WHERE id = ?', target.roomId,
        );
        const roomName = room?.name ?? 'your room';
        if (!target.tournamentId) return roomName;

        const tournament = await db.get<{ name: string; integrity_mode: string | null }>(
            'SELECT name, integrity_mode FROM tournaments WHERE id = ?', target.tournamentId,
        );
        if (!tournament?.name) return roomName;
        // v2.165.0 — a player pointed at a Sanctioned tournament should learn it
        // where they look before playing (the Status line), not from a refusal.
        const mode = tournament.integrity_mode === 'sanctioned' ? ' (Sanctioned play)' : '';
        return `${roomName} / ${tournament.name}${mode}`;
    }

    /** The devices (cabinets and desktops) a player has paired (Account Settings). */
    static async listDevices(canonicalUserId: string): Promise<WitnessDevice[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{
            atgames_unique_id: string; atgames_username: string | null; device_type: string | null; paired_at: string;
            last_seen_at: string | null; target_room_id: string | null; room_name: string | null;
            target_tournament_id: string | null; tournament_name: string | null;
            global_only: number; global_fallback: number;
        }>>(
            `SELECT d.atgames_unique_id, d.atgames_username, d.device_type, d.paired_at, d.last_seen_at,
                    d.target_room_id, r.name AS room_name,
                    d.target_tournament_id, t.name AS tournament_name,
                    d.global_only, d.global_fallback
               FROM witness_devices d
               LEFT JOIN game_rooms r ON r.id = d.target_room_id
               LEFT JOIN tournaments t ON t.id = d.target_tournament_id
              WHERE d.canonical_user_id = ? AND d.revoked_at IS NULL
              ORDER BY d.paired_at DESC`,
            canonicalUserId,
        );
        return rows.map(r => ({
            atgamesUniqueId: r.atgames_unique_id,
            atgamesUsername: r.atgames_username,
            deviceType: r.device_type === 'desktop' ? 'desktop' : 'atgames',
            pairedAt: r.paired_at,
            lastSeenAt: r.last_seen_at,
            targetRoomId: r.target_room_id,
            targetRoomName: r.room_name,
            targetTournamentId: r.target_tournament_id,
            targetTournamentName: r.tournament_name,
            globalOnly: !r.target_room_id && r.global_only === 1,
            globalFallback: r.global_fallback !== 0,
        }));
    }

    /**
     * Unpair a cabinet (soft delete — revoke, so its token stops working and a
     * later re-pair is clean). Self-only: only the owner may revoke, enforced
     * by the WHERE clause. Observations are kept; they are the player's own
     * history and harmless.
     */
    static async revokeDevice(canonicalUserId: string, atgamesUniqueId: string): Promise<boolean> {
        const db = await getDatabase();
        const res = await db.run(
            `UPDATE witness_devices SET revoked_at = datetime('now')
              WHERE atgames_unique_id = ? AND canonical_user_id = ? AND revoked_at IS NULL`,
            atgamesUniqueId, canonicalUserId,
        );
        const changed = (res.changes ?? 0) > 0;
        if (changed) logInfo(`Witness: device ${atgamesUniqueId} unpaired by ${canonicalUserId}`);
        return changed;
    }

    /** Best-effort sweep of expired, unconsumed codes. Cheap; call opportunistically. */
    static async pruneExpiredCodes(): Promise<void> {
        try {
            const db = await getDatabase();
            await db.run(
                `DELETE FROM witness_pairing_codes WHERE consumed_at IS NULL AND expires_at <= datetime('now', '-1 day')`,
            );
        } catch (err) {
            logWarn('Witness: pruneExpiredCodes failed', err);
        }
    }
}
