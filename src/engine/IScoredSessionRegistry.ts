import { IScoredClient } from './IScoredClient.js';
import { IScoredCreds } from '../utils/iscoredCreds.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';

/**
 * Per-account serialized session manager for iScored Playwright operations.
 *
 * Why this exists: iScored treats one logged-in user as one browser session.
 * When multiple maintenance / cleanup / admin actions fire concurrently for the
 * same account (the canonical case: rtx_pinball has 5 tournaments on one
 * account, 4 weeklies + DG fire at Wed 22:00 within ~5ms of each other), each
 * caller used to construct its own `IScoredClient`. Multiple Playwright
 * contexts on the same iScored account contend over server-side state — the
 * `<select id="selectGame">` dropdown gets repopulated mid-call, and
 * `IScoredClient.deleteGame` short-circuits with "not found in dropdown" even
 * though the entity is still there. ROADMAP entry 2026-04-29.
 *
 * The fix: every iScored-touching path goes through `withSession(creds, fn)`.
 * Calls for the same account chain serially (the `fn` callbacks execute one at
 * a time, never concurrently). The underlying client is reused across calls
 * within an idle TTL window so cron-fire batches don't pay the Playwright
 * login cost N times.
 *
 * Callers triggered by independent code paths (Scheduler cron fires, admin
 * actions, Discord commands) all converge on this registry — no caller-side
 * coordination required.
 */

interface SessionEntry {
    client: IScoredClient;
    /** Reset whenever a new caller acquires the session. */
    idleTimer: NodeJS.Timeout | null;
    creds: IScoredCreds;
}

export class IScoredSessionRegistry {
    private static instance: IScoredSessionRegistry;

    /** Tail of the per-account chain. Each new caller awaits this and replaces it with its own done-promise. */
    private chains: Map<string, Promise<void>> = new Map();

    /** Open sessions keyed by account. Reused across calls within IDLE_TTL_MS of the last release. */
    private sessions: Map<string, SessionEntry> = new Map();

    /**
     * How long to hold an idle session open before disconnecting. Sized to bridge
     * the gap between consecutive cron-fire batches and post-maintenance reorder
     * calls without holding the session indefinitely.
     */
    private readonly IDLE_TTL_MS = 1500;

    /**
     * How the registry constructs an iScored client. Overridable in tests so the
     * per-account serialization + idle logic can be exercised without launching
     * Playwright. Production always uses the default.
     */
    private clientFactory: (creds: IScoredCreds) => IScoredClient =
        (creds) => new IScoredClient({ username: creds.username, password: creds.password });

    /** Test-only: swap the client factory (pass null to restore the default). */
    public setClientFactoryForTests(factory: ((creds: IScoredCreds) => IScoredClient) | null): void {
        this.clientFactory = factory ?? ((creds) => new IScoredClient({ username: creds.username, password: creds.password }));
    }

    private constructor() {}

    public static getInstance(): IScoredSessionRegistry {
        if (!IScoredSessionRegistry.instance) {
            IScoredSessionRegistry.instance = new IScoredSessionRegistry();
        }
        return IScoredSessionRegistry.instance;
    }

    /**
     * Run `fn` against an iScored Playwright session for `creds`. Calls for the
     * same account serialize: only one `fn` runs at a time. The session is
     * reused across calls within `IDLE_TTL_MS` to avoid the ~3-9s login cost
     * for back-to-back batches.
     *
     * If a connect attempt fails, `fn` is not invoked and the error propagates
     * to the caller.
     */
    public async withSession<T>(
        creds: IScoredCreds,
        fn: (client: IScoredClient) => Promise<T>,
    ): Promise<T> {
        const key = this.accountKey(creds);

        // Take the current tail (whatever's already queued for this account)
        // and chain ourselves behind it. Even on failure we resolve our own
        // done-promise so subsequent waiters don't deadlock.
        const previous = this.chains.get(key) ?? Promise.resolve();
        let resolveMyDone!: () => void;
        const myDone = new Promise<void>((resolve) => {
            resolveMyDone = resolve;
        });
        this.chains.set(key, myDone);

        try {
            await previous;

            const client = await this.acquireClient(key, creds);
            try {
                return await fn(client);
            } finally {
                this.scheduleIdleClose(key);
            }
        } finally {
            resolveMyDone();
            // If no one queued behind us, clear the chain entry so the next
            // caller starts a fresh chain (gets a Promise.resolve()).
            if (this.chains.get(key) === myDone) {
                this.chains.delete(key);
            }
        }
    }

    /**
     * Returns the existing client for this account, or opens a fresh one.
     * Cancels any pending idle-close so the session stays alive for the new
     * caller.
     */
    private async acquireClient(key: string, creds: IScoredCreds): Promise<IScoredClient> {
        const existing = this.sessions.get(key);
        if (existing) {
            if (existing.idleTimer) {
                clearTimeout(existing.idleTimer);
                existing.idleTimer = null;
            }
            return existing.client;
        }

        const client = this.clientFactory(creds);
        try {
            await client.connect();
        } catch (err) {
            // Don't leave a half-connected session in the map; let the caller
            // retry on the next withSession call.
            try { await client.disconnect(); } catch {}
            throw err;
        }
        const entry: SessionEntry = { client, idleTimer: null, creds };
        this.sessions.set(key, entry);
        logInfo(`IScoredSessionRegistry: opened session for ${creds.gameroomName} (${creds.source})`);
        return client;
    }

    /**
     * Schedule the open session to disconnect after IDLE_TTL_MS of inactivity.
     * If another caller acquires before the timer fires, `acquireClient` will
     * cancel it.
     */
    private scheduleIdleClose(key: string): void {
        const entry = this.sessions.get(key);
        if (!entry) return;
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => {
            // Double-check the entry is still us — guards against the race
            // where the session got replaced between schedule and fire.
            if (this.sessions.get(key) !== entry) return;
            this.sessions.delete(key);
            entry.client.disconnect()
                .then(() => logInfo(`IScoredSessionRegistry: closed idle session for ${entry.creds.gameroomName}`))
                .catch((err) => logWarn(`IScoredSessionRegistry: error closing idle session for ${entry.creds.gameroomName}:`, err));
        }, this.IDLE_TTL_MS);
    }

    /**
     * Force-close all open sessions. Used during shutdown / reload paths.
     */
    public async shutdown(): Promise<void> {
        const entries = Array.from(this.sessions.entries());
        this.sessions.clear();
        this.chains.clear();
        for (const [key, entry] of entries) {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            try {
                await entry.client.disconnect();
            } catch (err) {
                logError(`IScoredSessionRegistry: error closing session ${key} during shutdown:`, err);
            }
        }
    }

    /** Account-level identity. Username is the iScored login; case-insensitive. */
    private accountKey(creds: IScoredCreds): string {
        return creds.username.toLowerCase();
    }
}
