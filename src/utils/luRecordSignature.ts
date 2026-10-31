/**
 * W72 - the Legends Unchained (LU) ScoreServer signature on a VPX score record.
 *
 * The vpx-standalone launcher on an ALP cabinet writes one `game_end` record per
 * sitting to `scoreserver/vpx-<table>-games.jsonl`, and LU's ScoreServer signs
 * each line. The cabinet Witness may forward that raw line on
 * `GET /api/witness/score` as `record=<base64 of the line>`; this module decides
 * whether the line is genuine and whether it describes the score the cabinet
 * reported beside it.
 *
 * The contract (LU's lead dev, 2026-10-30; proven against 193/193 corpus records):
 * - pure Ed25519 (Go `crypto/ed25519`): no prehash, no context string;
 * - the signature is 64 bytes, base64, in the record's `sig` field;
 * - the signed payload is the line with surrounding whitespace trimmed, cut at
 *   the LAST occurrence of the exact bytes `,"sig":`, plus `}`;
 * - the public key is base64 of the raw 32-byte key.
 *
 * `machine_id` is the generic `alp4k-01` on every record, so it binds nothing:
 * the device token stays the identity. A verified record is a BADGE, never a
 * gate: nothing here ever refuses a score. The badge needs the record to be
 * the reported game (`crossCheckLuRecord`); a genuine signature over a
 * different game of the same sitting earns none, so it cannot lend its weight
 * to a number it did not sign.
 *
 * Pure: no database, no clock.
 */
import crypto from 'crypto';

/** The `signing_keys.source` the ScoreServer's keys are registered under. */
export const LU_SCORESERVER_SOURCE = 'lu-scoreserver';

/**
 * The longest ENCODED `record=` value accepted, in base64 characters (after
 * Express has URL-decoded the query). The cabinet omits the param above 6,144
 * characters (about 4.4 KB raw; the longest real record is 2,912 bytes), so
 * nothing it sends is ever near this; a longer value is "no record".
 */
export const LU_RECORD_MAX_ENCODED_CHARS = 8192;

/** The largest decoded line accepted - what `LU_RECORD_MAX_ENCODED_CHARS` can decode to. */
export const LU_RECORD_MAX_BYTES = (LU_RECORD_MAX_ENCODED_CHARS / 4) * 3;

/**
 * Whitespace/newline only, at either end - NOT `String.prototype.trim`, which
 * also eats Unicode spaces and a BOM that would be part of the signed bytes.
 */
function trimLine(line: string): string {
    return line.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
}

/** The cut point: the LAST occurrence of these exact bytes ends the payload. */
const SIG_MARKER = ',"sig":';

/** Times on the record are milliseconds, the cabinet's params seconds: allow rounding. */
export const LU_RECORD_TIME_TOLERANCE_SEC = 2;

export type SigningKey = { id: number | string; source: string; publicKey: string };

/** The parsed record, as far as the cross-check needs it. */
export type LuRecord = {
    type?: unknown;
    started?: unknown;
    timestamp?: unknown;
    scores?: unknown;
    [k: string]: unknown;
};

export type LuSignatureResult =
    /** The signature verifies against an active key of `source`. */
    | { status: 'verified'; source: string; keyId: number | string; record: LuRecord }
    /** The line is well-formed but no active key verifies it (or none is configured). */
    | { status: 'failed'; reason: string };

/**
 * `record=` off the query string (Express has already URL-decoded it, so the
 * cabinet's percent-encoded `+ / =` arrive as themselves) -> the raw line, or
 * null when it is absent, over `LU_RECORD_MAX_ENCODED_CHARS`, not base64, or
 * does not decode to UTF-8 text. Null means "no record" - today's unsigned
 * path - never a failed signature and never a 400.
 *
 * The decoded bytes are kept exactly as the file had them (the cabinet strips
 * only a trailing CR/LF); the cut in `splitSignedLine` works on them. A `+`
 * that reached us as a space (a sender that did not escape it) is put back,
 * and Node's base64 decoder accepts the url-safe alphabet too.
 */
export function parseForwardedRecord(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value.length > LU_RECORD_MAX_ENCODED_CHARS) return null;
    const b64 = value.replace(/ /g, '+').replace(/[\r\n]+$/, '');
    if (!b64) return null;
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
    const raw = Buffer.from(b64, 'base64');
    if (raw.length === 0 || raw.length > LU_RECORD_MAX_BYTES) return null;
    const line = raw.toString('utf8');
    // Bytes that are not valid UTF-8 decode to replacement characters, and the
    // re-encoded payload would no longer be the bytes that were signed.
    if (line.includes('�')) return null;
    if (!trimLine(line)) return null;
    return line;
}

/** The base64 raw key -> a Node public key object, or null when it is not 32 bytes of Ed25519. */
export function ed25519KeyFromBase64(b64: string): crypto.KeyObject | null {
    let raw: Buffer;
    try {
        raw = Buffer.from(String(b64 || '').trim(), 'base64');
    } catch {
        return null;
    }
    if (raw.length !== 32) return null;
    try {
        return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    } catch {
        return null;
    }
}

/**
 * The signed payload and the signature bytes, or null when the line carries no
 * `,"sig":` or its signature field cannot be read. Exactly the reference
 * verifier's cut: trim, cut at the LAST marker, append `}`. A lookalike
 * `,"sig":` earlier in the line (inside `rom`, say) is not the cut point.
 */
export function splitSignedLine(line: string): { payload: Buffer; sig: Buffer } | null {
    const t = trimLine(line);
    const i = t.lastIndexOf(SIG_MARKER);
    if (i < 0) return null;
    let sigB64: unknown;
    try {
        sigB64 = (JSON.parse('{' + t.slice(i + 1)) as { sig?: unknown }).sig;
    } catch {
        return null;
    }
    if (typeof sigB64 !== 'string' || !sigB64) return null;
    return { payload: Buffer.from(t.slice(0, i) + '}', 'utf8'), sig: Buffer.from(sigB64, 'base64') };
}

/**
 * Verify one forwarded line against every active key (callers pass only the
 * keys of the source they trust, already filtered for validity). Never throws.
 */
export function verifyLuRecord(line: string, keys: SigningKey[]): LuSignatureResult {
    const parts = splitSignedLine(line);
    if (!parts) return { status: 'failed', reason: 'the record carries no readable signature' };
    if (parts.sig.length !== 64) return { status: 'failed', reason: 'the signature is not 64 bytes' };
    let record: LuRecord;
    try {
        const parsed = JSON.parse(trimLine(line)) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { status: 'failed', reason: 'the record is not a JSON object' };
        }
        record = parsed as LuRecord;
    } catch {
        return { status: 'failed', reason: 'the record is not valid JSON' };
    }
    if (keys.length === 0) return { status: 'failed', reason: 'no signing key is configured' };
    for (const k of keys) {
        const key = ed25519KeyFromBase64(k.publicKey);
        if (!key) continue;
        try {
            if (crypto.verify(null, parts.payload, key, parts.sig)) {
                return { status: 'verified', source: k.source, keyId: k.id, record };
            }
        } catch { /* a malformed key or signature is just "not this key" */ }
    }
    return { status: 'failed', reason: 'the signature does not verify against any active key' };
}

function isoToEpochSec(v: unknown): number | null {
    if (typeof v !== 'string' || !v) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Player 1's entry on the record: the one named "Player 1", else the first. */
function playerOne(record: LuRecord): { score?: unknown; timestamp?: unknown } | null {
    if (!Array.isArray(record.scores) || record.scores.length === 0) return null;
    const entries = record.scores.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object');
    return entries.find(s => s.player === 'Player 1') ?? entries[0] ?? null;
}

/**
 * Is the reported game the one the SIGNED record's top-level fields describe?
 * A record is one per SITTING: its player-1 `score` and its end `timestamp`
 * are the sitting's LAST game, and its `started` is when the sitting began.
 * The cabinet splits a sitting into games (ball-1 restarts, restart folds) and
 * forwards the same record with each of them, so only the final game can
 * match. Player 1's `score` (a decimal string on the record) must equal the
 * reported score exactly, and the record's end (`timestamp`, else player 1's
 * `timestamp`) must be within `LU_RECORD_TIME_TOLERANCE_SEC` of the reported
 * `ended`. `started` is deliberately NOT compared: the sitting's start is not
 * the game's.
 *
 * A disagreement is not an accusation - it is "this signature vouches for a
 * different game of the sitting". The caller records it and the score lands
 * as an unsigned one; nothing is ever dropped on this answer.
 */
export function crossCheckLuRecord(
    record: LuRecord,
    reported: { score: number; endedTs: number },
): { ok: true } | { ok: false; reason: string } {
    const p1 = playerOne(record);
    if (!p1) return { ok: false, reason: 'the signed record has no player score' };
    const rawScore = typeof p1.score === 'number' ? String(p1.score) : p1.score;
    if (typeof rawScore !== 'string' || !/^\d+$/.test(rawScore.trim())) {
        return { ok: false, reason: 'the signed record has no readable score' };
    }
    // BigInt, not Number: an exact comparison must survive scores past 2^53.
    const signedScore = BigInt(rawScore.trim());
    if (!Number.isFinite(reported.score) || signedScore !== BigInt(Math.floor(reported.score))) {
        return { ok: false, reason: `the signed record's score (${rawScore.trim()}) is not the reported score (${reported.score})` };
    }
    const ended = isoToEpochSec(record.timestamp) ?? isoToEpochSec(p1.timestamp);
    if (ended == null || !Number.isFinite(reported.endedTs)
        || Math.abs(ended - reported.endedTs) > LU_RECORD_TIME_TOLERANCE_SEC) {
        return { ok: false, reason: 'the signed record\'s end is not the reported end' };
    }
    return { ok: true };
}
