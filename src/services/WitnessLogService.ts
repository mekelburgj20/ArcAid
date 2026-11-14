import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { logsSupported } from '../utils/witnessVersion.js';

/**
 * W99 (v2.245.0, ADR 0040) - a cabinet sends its logs when its player asks.
 *
 * The server can never reach a cabinet; it can only answer one. So a player's
 * request is a row (`witness_log_requests`), its id rides back on the
 * cabinet's next heartbeat as `logs`, and the cabinet answers with ONE POST of
 * an uncompressed tar it packed from a fixed allow-list compiled into the app
 * (the server only ever sends an id, never a path). The tar is stored as
 * `data/witness-logs/<id>.tar` and downloaded by the player through gzip.
 *
 * The bundle is the player's private data:
 *   - only its owner can list, download or delete it; a request id alone
 *     authorizes nothing (every player read is keyed on id AND owner, and a
 *     device upload on id AND device AND that device's current owner);
 *   - a `ready` bundle is deleted (row and file) 7 days after it arrived, and
 *     unpairing the device deletes its requests and files at once.
 *
 * Lifecycle: `pending` -> `ready` (upload) | `failed` (the cabinet said it
 * could not build the archive) | `expired` (15 minutes with no answer). Expiry
 * is decided LAZILY by `sweep()`, which every read and write here runs first;
 * there is no timer.
 *
 * Every id is validated as 32 lowercase hex before it is used to build a path.
 */

/** A pending request gives up after this long with no answer. */
export const LOG_REQUEST_PENDING_MINUTES = 15;
/** A ready bundle is deleted this long after it arrived. */
export const LOG_BUNDLE_KEEP_DAYS = 7;
/** The largest tar a cabinet may upload (the contract's 16 MiB). */
export const WITNESS_LOG_MAX_BYTES = 16 * 1024 * 1024;
/** How many requests the player's list shows. */
export const LOG_REQUESTS_LIST_LIMIT = 10;

export type LogRequestStatus = 'pending' | 'ready' | 'failed' | 'expired';

/** The wire shape (contract §2). Times are ISO 8601 UTC. */
export interface LogRequest {
    id: string;
    deviceId: string;
    status: LogRequestStatus;
    requestedAt: string;
    readyAt: string | null;
    sizeBytes: number | null;
    failReason: string | null;
    expiresAt: string;
}

interface LogRequestRow {
    id: string;
    atgames_unique_id: string;
    canonical_user_id: string;
    status: string;
    requested_at: string;
    ready_at: string | null;
    size_bytes: number | null;
    fail_reason: string | null;
}

export class WitnessLogError extends Error {
    readonly code: 'NOT_FOUND' | 'LOGS_UNSUPPORTED';
    constructor(code: WitnessLogError['code'], message: string) {
        super(message);
        this.name = 'WitnessLogError';
        this.code = code;
    }
}

const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
/** A device's failure reason: a short lowercase code (`no_files`, `no_space`, `tar_error`, `upload_failed`). */
const FAIL_REASON_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function isLogRequestId(value: unknown): value is string {
    return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

/** SQLite `datetime('now')` text (UTC, no zone) -> epoch ms. */
function sqliteMs(value: string): number {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function toWire(row: LogRequestRow): LogRequest {
    const requested = sqliteMs(row.requested_at);
    const ready = row.ready_at ? sqliteMs(row.ready_at) : null;
    const status: LogRequestStatus = row.status === 'ready' || row.status === 'failed' || row.status === 'expired'
        ? row.status : 'pending';
    // `ready`: when the file is deleted. Every other status: when the pending
    // window ends (for `failed` / `expired`, the moment it ended or would have).
    const expires = status === 'ready' && ready != null
        ? ready + LOG_BUNDLE_KEEP_DAYS * 86_400_000
        : requested + LOG_REQUEST_PENDING_MINUTES * 60_000;
    return {
        id: row.id,
        deviceId: row.atgames_unique_id,
        status,
        requestedAt: iso(requested),
        readyAt: ready != null ? iso(ready) : null,
        sizeBytes: row.size_bytes,
        failReason: row.fail_reason,
        expiresAt: iso(expires),
    };
}

/**
 * Is this the start of a POSIX ustar archive? The first 512-byte header must
 * carry the `ustar` magic at offset 257 and a valid header checksum (the sum
 * of its bytes with the checksum field read as spaces) - the same test `tar`
 * itself applies before it will read an archive.
 */
export function looksLikeTar(body: Buffer): boolean {
    if (body.length < 512) return false;
    if (body.subarray(257, 262).toString('latin1') !== 'ustar') return false;
    const field = body.subarray(148, 156).toString('latin1').replace(/[\0 ]+/g, ' ').trim();
    if (!/^[0-7]{1,8}$/.test(field)) return false;
    const stored = Number.parseInt(field, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : body[i]!;
    return sum === stored;
}

export class WitnessLogService {
    private static root = path.join(process.cwd(), 'data', 'witness-logs');

    /** Tests point the bundle directory at a temp dir (null restores the default). */
    static setRootForTests(root: string | null): void {
        WitnessLogService.root = root ?? path.join(process.cwd(), 'data', 'witness-logs');
    }

    /** `<root>/<id>.tar`, only ever for a validated id. */
    private static filePath(id: string): string {
        if (!isLogRequestId(id)) throw new Error('Witness logs: invalid request id');
        return path.join(WitnessLogService.root, `${id}.tar`);
    }

    private static async unlinkQuiet(id: string): Promise<void> {
        try {
            await fs.promises.unlink(WitnessLogService.filePath(id));
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                logWarn(`Witness logs: could not delete bundle ${id} (${(err as Error)?.message ?? String(err)})`);
            }
        }
    }

    /**
     * The lazy clock. Pending requests past their 15 minutes become `expired`
     * (`no_answer`); ready bundles past 7 days are deleted (file, then row);
     * failed / expired rows are dropped 7 days after they were made, so the
     * table cannot grow without bound. Cheap and idempotent: run by every
     * read and write in this service.
     */
    static async sweep(): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_log_requests SET status = 'expired', fail_reason = 'no_answer'
              WHERE status = 'pending' AND requested_at <= datetime('now', ?)`,
            `-${LOG_REQUEST_PENDING_MINUTES} minutes`,
        );
        const old = await db.all<Array<{ id: string }>>(
            `SELECT id FROM witness_log_requests
              WHERE (status = 'ready' AND ready_at <= datetime('now', ?))
                 OR (status IN ('failed', 'expired') AND requested_at <= datetime('now', ?))`,
            `-${LOG_BUNDLE_KEEP_DAYS} days`, `-${LOG_BUNDLE_KEEP_DAYS} days`,
        );
        for (const { id } of old) {
            if (isLogRequestId(id)) await WitnessLogService.unlinkQuiet(id);
            await db.run(`DELETE FROM witness_log_requests WHERE id = ?`, id);
        }
    }

    /**
     * A player asks for a cabinet's logs. The device must be the caller's and
     * unpaired-not (`NOT_FOUND`), a cabinet on 1.1.0 or later
     * (`LOGS_UNSUPPORTED`). A pending request for the device is returned as it
     * is (`created: false`), so a double click is one request.
     */
    static async request(canonicalUserId: string, deviceId: string): Promise<{ request: LogRequest; created: boolean }> {
        const db = await getDatabase();
        const device = await db.get<{ device_type: string | null; app_version: string | null }>(
            `SELECT device_type, app_version FROM witness_devices
              WHERE atgames_unique_id = ? AND canonical_user_id = ? AND revoked_at IS NULL`,
            deviceId, canonicalUserId,
        );
        if (!device) throw new WitnessLogError('NOT_FOUND', 'No such device paired to your account');
        if (!logsSupported(device.device_type, device.app_version)) {
            throw new WitnessLogError('LOGS_UNSUPPORTED', 'This device cannot send its logs (a cabinet running Arcaid Witness 1.1.0 or later can)');
        }
        await WitnessLogService.sweep();

        const pendingRow = () => db.get<LogRequestRow>(
            `SELECT * FROM witness_log_requests WHERE atgames_unique_id = ? AND status = 'pending'`, deviceId,
        );
        const existing = await pendingRow();
        if (existing) return { request: toWire(existing), created: false };

        const id = randomBytes(16).toString('hex');
        try {
            await db.run(
                `INSERT INTO witness_log_requests (id, atgames_unique_id, canonical_user_id, status)
                 VALUES (?, ?, ?, 'pending')`,
                id, deviceId, canonicalUserId,
            );
        } catch (err) {
            // A concurrent request won the one-pending-per-device index: answer with it.
            const raced = await pendingRow();
            if (raced) return { request: toWire(raced), created: false };
            throw err;
        }
        const row = await db.get<LogRequestRow>(`SELECT * FROM witness_log_requests WHERE id = ?`, id);
        logInfo(`Witness logs: request ${id} for device ${deviceId} by ${canonicalUserId}`);
        return { request: toWire(row!), created: true };
    }

    /** The caller's latest requests, newest first. */
    static async list(canonicalUserId: string): Promise<LogRequest[]> {
        await WitnessLogService.sweep();
        const db = await getDatabase();
        const rows = await db.all<LogRequestRow[]>(
            `SELECT * FROM witness_log_requests WHERE canonical_user_id = ?
              ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
            canonicalUserId, LOG_REQUESTS_LIST_LIMIT,
        );
        return rows.map(toWire);
    }

    /**
     * The heartbeat's `logs` field: the device's pending request id, or null.
     * Only a request made by the device's CURRENT owner counts.
     */
    static async pendingForDevice(deviceId: string): Promise<string | null> {
        await WitnessLogService.sweep();
        const db = await getDatabase();
        const row = await db.get<{ id: string }>(
            `SELECT r.id FROM witness_log_requests r
               JOIN witness_devices d ON d.atgames_unique_id = r.atgames_unique_id
                                     AND d.canonical_user_id = r.canonical_user_id
                                     AND d.revoked_at IS NULL
              WHERE r.atgames_unique_id = ? AND r.status = 'pending'
              ORDER BY r.requested_at LIMIT 1`,
            deviceId,
        );
        return row && isLogRequestId(row.id) ? row.id : null;
    }

    /** The pending request this device may answer: id + device + its current owner. */
    private static async pendingFor(deviceId: string, canonicalUserId: string, requestId: string): Promise<LogRequestRow | null> {
        if (!isLogRequestId(requestId)) return null;
        await WitnessLogService.sweep();
        const db = await getDatabase();
        const row = await db.get<LogRequestRow>(
            `SELECT * FROM witness_log_requests
              WHERE id = ? AND atgames_unique_id = ? AND canonical_user_id = ? AND status = 'pending'`,
            requestId, deviceId, canonicalUserId,
        );
        return row ?? null;
    }

    /**
     * The cabinet's upload. `no_request` = unknown id, not pending (already
     * answered, failed or expired) or another device's; `empty` / `not_a_tar`
     * = the body is not an archive. The bytes go to a uniquely named part
     * file first; the row is then CLAIMED (`pending` -> `ready`, only one
     * upload can win) and only the winner renames its part into place, so a
     * second, racing upload can never overwrite or delete the stored bundle.
     */
    static async upload(
        deviceId: string, canonicalUserId: string, requestId: string, body: Buffer | null,
    ): Promise<'ok' | 'no_request' | 'empty' | 'not_a_tar'> {
        const pending = await WitnessLogService.pendingFor(deviceId, canonicalUserId, requestId);
        if (!pending) return 'no_request';
        if (!body || body.length === 0) return 'empty';
        if (body.length > WITNESS_LOG_MAX_BYTES || !looksLikeTar(body)) return 'not_a_tar';

        await fs.promises.mkdir(WitnessLogService.root, { recursive: true });
        const final = WitnessLogService.filePath(requestId);
        const part = `${final}.${randomBytes(6).toString('hex')}.part`;
        try {
            await fs.promises.writeFile(part, body, { mode: 0o600 });
        } catch (err) {
            await fs.promises.rm(part, { force: true }).catch(() => {});
            throw err;
        }

        const db = await getDatabase();
        const res = await db.run(
            `UPDATE witness_log_requests SET status = 'ready', ready_at = datetime('now'), size_bytes = ?
              WHERE id = ? AND status = 'pending'`,
            body.length, requestId,
        );
        if ((res.changes ?? 0) !== 1) {
            await fs.promises.rm(part, { force: true }).catch(() => {});
            return 'no_request';
        }
        try {
            await fs.promises.rename(part, final);
        } catch (err) {
            // Give the request back to the cabinet (it may retry) rather than
            // leave a `ready` row with no file behind it.
            await db.run(
                `UPDATE witness_log_requests SET status = 'pending', ready_at = NULL, size_bytes = NULL WHERE id = ?`,
                requestId,
            ).catch(() => {});
            await fs.promises.rm(part, { force: true }).catch(() => {});
            throw err;
        }
        logInfo(`Witness logs: bundle ${requestId} received from device ${deviceId} (${body.length} bytes)`);
        return 'ok';
    }

    /** The cabinet could not build the archive. False = no such pending request for this device. */
    static async fail(deviceId: string, canonicalUserId: string, requestId: string, rawReason: unknown): Promise<boolean> {
        const pending = await WitnessLogService.pendingFor(deviceId, canonicalUserId, requestId);
        if (!pending) return false;
        const reason = typeof rawReason === 'string' && FAIL_REASON_RE.test(rawReason) ? rawReason : 'unknown';
        const db = await getDatabase();
        const res = await db.run(
            `UPDATE witness_log_requests SET status = 'failed', fail_reason = ?
              WHERE id = ? AND status = 'pending'`,
            reason, requestId,
        );
        if ((res.changes ?? 0) !== 1) return false;
        logInfo(`Witness logs: request ${requestId} failed on device ${deviceId} (${reason})`);
        return true;
    }

    /**
     * The owner's download: the stored tar as a read stream, with the file
     * name the response should carry (`arcaid-witness-logs-<YYYYMMDD-HHmm>.tar.gz`,
     * UTC of `readyAt`). Null unless the caller owns it and it is `ready` (and
     * its file is still there).
     */
    static async openDownload(canonicalUserId: string, requestId: string): Promise<{ stream: fs.ReadStream; filename: string } | null> {
        if (!isLogRequestId(requestId)) return null;
        await WitnessLogService.sweep();
        const db = await getDatabase();
        const row = await db.get<LogRequestRow>(
            `SELECT * FROM witness_log_requests WHERE id = ? AND canonical_user_id = ? AND status = 'ready'`,
            requestId, canonicalUserId,
        );
        if (!row || !row.ready_at) return null;
        const file = WitnessLogService.filePath(requestId);
        try {
            const st = await fs.promises.stat(file);
            if (!st.isFile()) return null;
        } catch {
            return null;
        }
        const d = new Date(sqliteMs(row.ready_at));
        const p = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
        return { stream: fs.createReadStream(file), filename: `arcaid-witness-logs-${stamp}.tar.gz` };
    }

    /** The owner deletes a request (any status): row and file. False = not theirs / no such id. */
    static async remove(canonicalUserId: string, requestId: string): Promise<boolean> {
        if (!isLogRequestId(requestId)) return false;
        const db = await getDatabase();
        const row = await db.get<{ id: string }>(
            `SELECT id FROM witness_log_requests WHERE id = ? AND canonical_user_id = ?`,
            requestId, canonicalUserId,
        );
        if (!row) return false;
        await WitnessLogService.unlinkQuiet(requestId);
        await db.run(`DELETE FROM witness_log_requests WHERE id = ? AND canonical_user_id = ?`, requestId, canonicalUserId);
        return true;
    }

    /** Unpairing a device deletes every request it had, and their files. Never throws. */
    static async purgeForDevice(deviceId: string): Promise<void> {
        try {
            const db = await getDatabase();
            const rows = await db.all<Array<{ id: string }>>(
                `SELECT id FROM witness_log_requests WHERE atgames_unique_id = ?`, deviceId,
            );
            for (const { id } of rows) {
                if (isLogRequestId(id)) await WitnessLogService.unlinkQuiet(id);
            }
            await db.run(`DELETE FROM witness_log_requests WHERE atgames_unique_id = ?`, deviceId);
        } catch (err) {
            logError(`Witness logs: purge for unpaired device ${deviceId} failed`, err);
        }
    }
}
