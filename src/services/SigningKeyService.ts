import { getDatabase } from '../database/database.js';
import { ed25519KeyFromBase64, type SigningKey } from '../utils/luRecordSignature.js';

/**
 * W72 (v2.205.0) - the registry of public keys a forwarded score record may be
 * signed with (`signing_keys`, migration 202).
 *
 * Keys are CONFIGURED data: a super-admin pastes one in (Global Settings ->
 * Signing keys). None is hardcoded. Rotation is a new row; retiring a key sets
 * its `valid_until` to now and it stops verifying anything from that moment.
 * Rows are never edited or deleted, so the registry is also the record of
 * which key was trusted when.
 *
 * `activeKeys` is read on every signed score, so it is cached per source and
 * the cache is dropped on every write. The cache holds ROWS, and validity is
 * decided per read against the clock, so a key whose `valid_from` arrives (or
 * `valid_until` passes) takes effect without a write.
 */

export type SigningKeyRow = {
    id: number;
    source: string;
    algorithm: string;
    publicKey: string;
    validFrom: string;
    validUntil: string | null;
    note: string | null;
    createdAt: string;
};

type DbRow = {
    id: number; source: string; algorithm: string; public_key: string;
    valid_from: string; valid_until: string | null; note: string | null; created_at: string;
};

export class SigningKeyError extends Error {
    constructor(public readonly code: 'INVALID_KEY' | 'DUPLICATE_KEY' | 'NOT_FOUND' | 'ALREADY_RETIRED', message: string) {
        super(message);
        this.name = 'SigningKeyError';
    }
}

/** SQLite `datetime('now')` shape, for comparing against stored stamps as strings. */
function sqliteNow(now: Date = new Date()): string {
    return now.toISOString().replace('T', ' ').slice(0, 19);
}

/** Accepts ISO or SQLite UTC; returns the SQLite UTC shape, or null when unreadable. */
function toSqliteStamp(v: string): string | null {
    const s = v.trim();
    const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? sqliteNow(new Date(ms)) : null;
}

function toRow(r: DbRow): SigningKeyRow {
    return {
        id: r.id, source: r.source, algorithm: r.algorithm, publicKey: r.public_key,
        validFrom: r.valid_from, validUntil: r.valid_until, note: r.note, createdAt: r.created_at,
    };
}

export class SigningKeyService {
    private static cache = new Map<string, SigningKeyRow[]>();

    /** Drop the per-source cache (every write calls this; tests may too). */
    static invalidate(): void {
        SigningKeyService.cache.clear();
    }

    /** Every key, newest first - the admin list. */
    static async list(): Promise<SigningKeyRow[]> {
        const db = await getDatabase();
        const rows = await db.all<DbRow[]>('SELECT * FROM signing_keys ORDER BY created_at DESC, id DESC');
        return rows.map(toRow);
    }

    /** True when the key is in force at `now`. */
    static isActive(row: Pick<SigningKeyRow, 'validFrom' | 'validUntil'>, now: Date = new Date()): boolean {
        const n = sqliteNow(now);
        return row.validFrom <= n && (row.validUntil == null || row.validUntil > n);
    }

    /** The keys of one source in force now, in the shape the verifier takes. */
    static async activeKeys(source: string, now: Date = new Date()): Promise<SigningKey[]> {
        let rows = SigningKeyService.cache.get(source);
        if (!rows) {
            const db = await getDatabase();
            rows = (await db.all<DbRow[]>(
                `SELECT * FROM signing_keys WHERE source = ? AND algorithm = 'ed25519' ORDER BY id ASC`, source,
            )).map(toRow);
            SigningKeyService.cache.set(source, rows);
        }
        return rows
            .filter(r => SigningKeyService.isActive(r, now))
            .map(r => ({ id: r.id, source: r.source, publicKey: r.publicKey }));
    }

    /**
     * Register a key. The key must be base64 of exactly 32 bytes that Node
     * accepts as an Ed25519 public key; it is stored in canonical base64 so
     * the same key pasted twice (or url-safe) is caught as a duplicate.
     */
    static async add(input: { source: string; publicKey: string; validFrom?: string | null; note?: string | null }): Promise<SigningKeyRow> {
        const source = input.source.trim();
        const raw = Buffer.from(input.publicKey.trim(), 'base64');
        if (raw.length !== 32 || !ed25519KeyFromBase64(input.publicKey)) {
            throw new SigningKeyError('INVALID_KEY', 'The key must be base64 of a raw 32-byte Ed25519 public key');
        }
        const publicKey = raw.toString('base64');
        let validFrom = sqliteNow();
        if (input.validFrom) {
            const v = toSqliteStamp(input.validFrom);
            if (!v) throw new SigningKeyError('INVALID_KEY', 'valid_from is not a readable date');
            validFrom = v;
        }
        const db = await getDatabase();
        const existing = await db.get<{ id: number }>(
            'SELECT id FROM signing_keys WHERE source = ? AND public_key = ?', source, publicKey,
        );
        if (existing) throw new SigningKeyError('DUPLICATE_KEY', 'That key is already registered for this source');
        const res = await db.run(
            `INSERT INTO signing_keys (source, algorithm, public_key, valid_from, note) VALUES (?, 'ed25519', ?, ?, ?)`,
            source, publicKey, validFrom, input.note?.trim() || null,
        );
        SigningKeyService.invalidate();
        const row = await db.get<DbRow>('SELECT * FROM signing_keys WHERE id = ?', res.lastID);
        return toRow(row!);
    }

    /** Retire a key now. A retired key verifies nothing from this moment on. */
    static async retire(id: number): Promise<SigningKeyRow> {
        const db = await getDatabase();
        const row = await db.get<DbRow>('SELECT * FROM signing_keys WHERE id = ?', id);
        if (!row) throw new SigningKeyError('NOT_FOUND', 'Signing key not found');
        if (row.valid_until != null && row.valid_until <= sqliteNow()) {
            throw new SigningKeyError('ALREADY_RETIRED', 'That key is already retired');
        }
        await db.run('UPDATE signing_keys SET valid_until = ? WHERE id = ?', sqliteNow(), id);
        SigningKeyService.invalidate();
        const after = await db.get<DbRow>('SELECT * FROM signing_keys WHERE id = ?', id);
        return toRow(after!);
    }
}
