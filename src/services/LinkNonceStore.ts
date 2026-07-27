import crypto from 'crypto';

/**
 * In-memory, single-process nonce store for the account-link flow (v2.36.0
 * Google->Discord direction; v2.46.0 genericized to also serve the mirrored
 * Discord->Google direction): `POST /auth/link/<provider>/start` mints a
 * nonce bound to the caller's own identity -> the FE runs the OTHER
 * provider's normal OAuth redirect with `state=link:<nonce>` -> the OTHER
 * provider's callback posts the nonce back explicitly (the server never
 * trusts the `state` param itself) and consumes it to prove the same browser
 * session that started the link is the one completing it.
 *
 * Discretionary implementer's-call (per contract): a small in-memory Map with
 * TTL, not a DB-backed table. This is a single-process app (no horizontal
 * scaling), the nonce is short-lived (10 min) and low-value (proves session
 * continuity, not identity — both OAuth exchanges still independently prove
 * ownership of their respective account), and nothing is written to the
 * database until the nonce is validated. Trade-off: a server restart drops
 * all pending links. A user mid-flow across a restart just sees the callback
 * 400 with "invalid or expired" and retries the link from Account Settings —
 * no data loss, no half-linked state left behind.
 */

interface PendingLink {
    initiatorUserId: string;
    expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const pending = new Map<string, PendingLink>();

function sweep(): void {
    const now = Date.now();
    for (const [nonce, entry] of pending) {
        if (entry.expiresAt <= now) pending.delete(nonce);
    }
}

export const LinkNonceStore = {
    /** Mint a fresh nonce bound to `initiatorUserId`, expiring in 10 minutes. */
    create(initiatorUserId: string): string {
        sweep();
        const nonce = crypto.randomUUID();
        pending.set(nonce, { initiatorUserId, expiresAt: Date.now() + TTL_MS });
        return nonce;
    },

    /**
     * Validate AND consume (single-use) a nonce. Returns the bound initiator
     * user id on success, or null if the nonce is missing, expired, or already
     * used (replay). Deleting before the expiry check means a replay of an
     * already-consumed nonce always misses the map, regardless of timing.
     */
    consume(nonce: string): string | null {
        sweep();
        const entry = pending.get(nonce);
        if (!entry) return null;
        pending.delete(nonce);
        if (entry.expiresAt <= Date.now()) return null;
        return entry.initiatorUserId;
    },

    /** Test-only escape hatch — clears all pending nonces between test cases. */
    _clearAll(): void {
        pending.clear();
    },
};
