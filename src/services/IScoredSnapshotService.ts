import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { normalizeIScoredScoreResponse } from '../utils/iscoredScores.js';
import type { IScoredApiGameScores, IScoredApiScore } from '../engine/IScoredApiClient.js';
import type { IScoredClient } from '../engine/IScoredClient.js';
import type { IScoredCreds } from '../utils/iscoredCreds.js';

/**
 * iScored room snapshots (v2.117.0).
 *
 * Rollback safety for the destructive half of the iScored integration. iScored
 * has no undo: a wrong `deleteGame` (maintenance rotation, cleanup, admin
 * delete, reconcile, unpin) takes the game AND every score on it with it. A
 * snapshot is a cheap JSON copy of one iScored gameroom's public state —
 * captured automatically just before those paths mutate, plus nightly — from
 * which a wrongly-deleted game can be recreated and its per-player best scores
 * replayed.
 *
 * Deliberately NOT captured: photos, per-game style (DOM-driven, far too slow
 * for a pre-mutation hook), per-score ids (the public API exposes none).
 */

export type SnapshotReason =
    | 'maintenance'
    | 'cleanup'
    | 'reconcile'
    | 'admin-delete'
    | 'delete-game'
    | 'unpin'
    | 'nightly'
    | 'manual';

export interface SnapshotGame {
    id: string;
    name: string;
    hidden: boolean;
    locked: boolean;
    tags: string[];
    scores: IScoredApiScore[];
}

export interface IScoredSnapshot {
    v: 1;
    capturedAt: string;
    reason: SnapshotReason;
    account: {
        gameroomName: string;
        publicUrl: string;
        username: string;
        source: 'room' | 'env';
    };
    /** Arcaid room ids sharing this iScored account at capture time. */
    roomIds: string[];
    /** `getGamesOnIScored` produced a trustworthy list (see the double-read rule below). */
    gamesCaptured: boolean;
    /** `getAllScores` succeeded. */
    scoresCaptured: boolean;
    scoresError?: string;
    counts: { games: number; scores: number };
    games: SnapshotGame[];
    /**
     * Score groups whose iScored game id matched no game in `games` — kept, never
     * dropped, so a snapshot taken while the game list read failed still carries
     * every score it could see.
     */
    orphanScores: IScoredApiGameScores[];
}

export interface SnapshotListEntry {
    gameroom: string;
    name: string;
    capturedAt: string;
    reason: string;
    games: number;
    scores: number;
    size: number;
    gamesCaptured: boolean;
    scoresCaptured: boolean;
}

export interface CaptureResult {
    ok: boolean;
    /** Snapshot filename (`<ts>.json`) when a file was written. */
    name?: string;
    /** True when the debounce window suppressed this capture. */
    skipped?: boolean;
    error?: string;
    snapshot?: IScoredSnapshot;
}

export interface RestorePlanGame {
    id: string;
    name: string;
    hidden: boolean;
    locked: boolean;
    tags: string[];
    /** Per-player BEST scores only — iScored keeps one best per player and rejects lower. */
    scores: Array<{ name: string; score: number }>;
    scoreCount: number;
    /** Local `games` rows currently pointing at the snapshot's (now dead) iScored id. */
    localGameRows: Array<{ id: string; name: string }>;
}

export interface RestorePlan {
    /** Snapshot games whose name already exists on iScored — skipped. */
    alreadyPresent: Array<{ id: string; name: string; liveId: string }>;
    toCreate: RestorePlanGame[];
}

export interface RestoreGameResult {
    snapshotId: string;
    newId: string | null;
    name: string;
    scoresSubmitted: number;
    scoresRejected: number;
    relinkedLocalGames: number;
    error?: string;
}

const DEFAULT_DEBOUNCE_MS = 600_000; // 10 min
const DEFAULT_RETENTION_DAYS = 30;

/** `<ISO with : and . replaced by ->`.json — same format BackupManager uses for its dirs. */
const SNAPSHOT_NAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;
const GAMEROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class IScoredSnapshotService {
    private static root = path.join(process.cwd(), 'data', 'iscored-snapshots');

    /**
     * Last SUCCESSFUL capture per account key, epoch ms. In-memory only: a
     * restart re-arms every account, which is the safe direction (one extra
     * snapshot, never a missing one).
     */
    private static lastSuccessAt: Map<string, number> = new Map();

    /**
     * True once a test has pointed the root somewhere safe. Under vitest,
     * capture is INERT until this happens: the pre-mutation hook is wired into
     * maintenance/cleanup/delete paths that dozens of unrelated tests exercise,
     * and without this guard those tests would hit the real iScored API using
     * whatever creds `.env` happens to hold and litter the repo's `data/` dir.
     */
    private static rootOverridden = false;

    /** Test seam — point the snapshot root at an `fs.mkdtemp` dir. `null` restores the default. */
    static setRootForTests(root: string | null): void {
        IScoredSnapshotService.root = root ?? path.join(process.cwd(), 'data', 'iscored-snapshots');
        IScoredSnapshotService.rootOverridden = root !== null;
    }

    /** Test seam — clear the debounce map between cases. */
    static resetDebounceForTests(): void {
        IScoredSnapshotService.lastSuccessAt.clear();
    }

    static getRoot(): string {
        return IScoredSnapshotService.root;
    }

    // ── Capture ──────────────────────────────────────────────────────────────

    /**
     * Pre-mutation safety net. Wraps {@link capture} so it can NEVER throw into
     * a caller and never blocks the mutation that follows: tournaments running
     * beats snapshots existing. A failure here is logged at ERROR (the safety
     * net itself failing is not a warning-level event) and execution continues.
     *
     * `client` is the caller's ALREADY-AUTHENTICATED session client — every hook
     * site sits inside `IScoredSessionRegistry.withSession`, so no extra login
     * is paid and no second Playwright context is opened.
     */
    static async captureBeforeMutation(
        client: IScoredClient,
        creds: IScoredCreds,
        reason: SnapshotReason,
        roomIds: string[],
    ): Promise<void> {
        try {
            await IScoredSnapshotService.capture(client, creds, reason, roomIds);
        } catch (err) {
            logError(`iScored snapshot (${reason}) failed for ${creds.gameroomName} — continuing with the mutation:`, err);
        }
    }

    /**
     * Capture one iScored gameroom's state to `<root>/<gameroom>/<ts>.json`.
     *
     * Debounced per account (`creds.username` lowercased — the same key the
     * session registry uses) so the Wed 22:00 rtx_pinball fire (4 weeklies + DG
     * on one account, all inside ~5ms) writes exactly ONE snapshot. `force`
     * bypasses (nightly + manual).
     *
     * A partial capture still writes a file — a partial snapshot beats none —
     * but does NOT arm the debounce, so the next mutation retries immediately.
     */
    static async capture(
        client: IScoredClient,
        creds: IScoredCreds,
        reason: SnapshotReason,
        roomIds: string[],
        opts?: { force?: boolean },
    ): Promise<CaptureResult> {
        if (process.env.VITEST && !IScoredSnapshotService.rootOverridden) {
            // See `rootOverridden` — never touch the network or `data/` from a
            // test that did not explicitly opt in with `setRootForTests`.
            return { ok: false, skipped: true, error: 'snapshots inert under test' };
        }
        if (!(await IScoredSnapshotService.isEnabled())) {
            return { ok: false, skipped: true, error: 'snapshots disabled' };
        }

        const key = creds.username.toLowerCase();
        if (!opts?.force) {
            const last = IScoredSnapshotService.lastSuccessAt.get(key);
            const window = IScoredSnapshotService.debounceMs();
            if (last !== undefined && Date.now() - last < window) {
                return { ok: true, skipped: true };
            }
        }

        // ── games (authenticated, via the caller's session) ──
        let games: Array<{ id: string; name: string; hidden: boolean; locked: boolean; tags: string[] }> = [];
        let gamesCaptured = true;
        try {
            games = await client.getGamesOnIScored();
            if (games.length === 0) {
                // `getGamesOnIScored` returns [] on transport/parse failure too,
                // so a single empty read is ambiguous. Only a SECOND empty read
                // is accepted as "verified empty".
                games = await client.getGamesOnIScored();
            }
        } catch (err) {
            gamesCaptured = false;
            games = [];
            logWarn(`iScored snapshot (${reason}) for ${creds.gameroomName}: game list unavailable — ${err instanceof Error ? err.message : String(err)}`);
        }

        // ── scores (public REST) ──
        let grouped: IScoredApiGameScores[] = [];
        let scoresCaptured = true;
        let scoresError: string | undefined;
        try {
            const { IScoredApiClient } = await import('../engine/IScoredApiClient.js');
            const api = new IScoredApiClient({ publicUrl: creds.publicUrl });
            grouped = normalizeIScoredScoreResponse(await api.getAllScores(), {
                context: `iScored snapshot[${creds.gameroomName}]`,
            });
        } catch (err) {
            scoresCaptured = false;
            scoresError = err instanceof Error ? err.message : String(err);
            logWarn(`iScored snapshot (${reason}) for ${creds.gameroomName}: scores unavailable — ${scoresError}`);
        }

        if (gamesCaptured && games.length === 0 && grouped.length > 0) {
            // `getGamesOnIScored` swallows transport failures into [] — two empty
            // reads while the public API still shows scores means the LIST read
            // failed, not that the room is empty. Flag it so the snapshot is
            // honest (and so the debounce stays un-armed and retries).
            gamesCaptured = false;
            logWarn(`iScored snapshot (${reason}) for ${creds.gameroomName}: game list came back empty twice while ${grouped.length} game(s) have scores — treating the list as MISSING.`);
        }

        const byGameId = new Map<string, IScoredApiGameScores>();
        for (const g of grouped) byGameId.set(String(g.GameID), g);

        let scoreCount = 0;
        const snapshotGames: SnapshotGame[] = games.map((g) => {
            const match = byGameId.get(String(g.id));
            if (match) byGameId.delete(String(g.id));
            const scores = match?.scores ?? [];
            scoreCount += scores.length;
            return { id: g.id, name: g.name, hidden: g.hidden, locked: g.locked, tags: g.tags, scores };
        });

        // Everything left over belongs to a game the list read didn't cover.
        const orphanScores = Array.from(byGameId.values());
        for (const o of orphanScores) scoreCount += o.scores.length;

        const capturedAt = new Date();
        const snapshot: IScoredSnapshot = {
            v: 1,
            capturedAt: capturedAt.toISOString(),
            reason,
            account: {
                gameroomName: creds.gameroomName,
                publicUrl: creds.publicUrl,
                username: creds.username,
                source: creds.source,
            },
            roomIds,
            gamesCaptured,
            scoresCaptured,
            ...(scoresError ? { scoresError } : {}),
            counts: { games: snapshotGames.length, scores: scoreCount },
            games: snapshotGames,
            orphanScores,
        };

        const name = `${capturedAt.toISOString().replace(/[:.]/g, '-')}.json`;
        const dir = path.join(IScoredSnapshotService.root, creds.gameroomName);
        try {
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, name), JSON.stringify(snapshot, null, 2), 'utf-8');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`iScored snapshot (${reason}) for ${creds.gameroomName}: could not write ${name}:`, err);
            return { ok: false, error: message };
        }

        if (!gamesCaptured || !scoresCaptured) {
            logWarn(`iScored snapshot ${creds.gameroomName}/${name} is PARTIAL (games: ${gamesCaptured ? 'ok' : 'MISSING'}, scores: ${scoresCaptured ? 'ok' : 'MISSING'}) — written anyway.`);
        } else {
            // Only a complete capture arms the debounce; a partial one must not
            // suppress the next attempt for the whole window.
            IScoredSnapshotService.lastSuccessAt.set(key, Date.now());
            logInfo(`iScored snapshot ${creds.gameroomName}/${name} (${reason}): ${snapshot.counts.games} game(s), ${snapshot.counts.scores} score(s).`);
        }

        return { ok: true, name, snapshot };
    }

    // ── Listing / files ──────────────────────────────────────────────────────

    /** All snapshots across every gameroom dir, newest first. Files are small — parsed, not stat'd. */
    static async list(): Promise<SnapshotListEntry[]> {
        const root = IScoredSnapshotService.root;
        if (!fs.existsSync(root)) return [];

        const out: SnapshotListEntry[] = [];
        const dirs = await fsp.readdir(root, { withFileTypes: true });
        for (const dir of dirs) {
            if (!dir.isDirectory() || !GAMEROOM_RE.test(dir.name)) continue;
            let files: string[];
            try {
                files = await fsp.readdir(path.join(root, dir.name));
            } catch {
                continue;
            }
            for (const file of files) {
                if (!SNAPSHOT_NAME_RE.test(file)) continue;
                const full = path.join(root, dir.name, file);
                try {
                    const stat = await fsp.stat(full);
                    const parsed = JSON.parse(await fsp.readFile(full, 'utf-8')) as Partial<IScoredSnapshot>;
                    out.push({
                        gameroom: dir.name,
                        name: file,
                        capturedAt: parsed.capturedAt ?? new Date(IScoredSnapshotService.parseSnapshotTimestamp(file) ?? stat.birthtimeMs).toISOString(),
                        reason: parsed.reason ?? 'unknown',
                        games: parsed.counts?.games ?? (parsed.games?.length ?? 0),
                        scores: parsed.counts?.scores ?? 0,
                        size: stat.size,
                        gamesCaptured: parsed.gamesCaptured !== false,
                        scoresCaptured: parsed.scoresCaptured !== false,
                    });
                } catch (err) {
                    logWarn(`iScored snapshot list: skipping unreadable ${dir.name}/${file}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
        return out;
    }

    /**
     * Resolve `<gameroom>/<name>` to an absolute path, refusing anything that
     * doesn't match both name patterns or that escapes the snapshot root.
     * Same guard doctrine as `BackupService.isValidBackupName`, tightened to a
     * positive pattern because both segments are machine-generated.
     */
    static resolvePath(gameroom: string, name: string): string | null {
        if (!GAMEROOM_RE.test(gameroom)) return null;
        if (!SNAPSHOT_NAME_RE.test(name)) return null;
        const root = path.resolve(IScoredSnapshotService.root);
        const full = path.resolve(path.join(root, gameroom, name));
        if (full !== path.join(root, gameroom, name)) return null;
        if (!full.startsWith(root + path.sep)) return null;
        return full;
    }

    static async read(gameroom: string, name: string): Promise<IScoredSnapshot | null> {
        const full = IScoredSnapshotService.resolvePath(gameroom, name);
        if (!full || !fs.existsSync(full)) return null;
        return JSON.parse(await fsp.readFile(full, 'utf-8')) as IScoredSnapshot;
    }

    static async delete(gameroom: string, name: string): Promise<boolean> {
        const full = IScoredSnapshotService.resolvePath(gameroom, name);
        if (!full || !fs.existsSync(full)) return false;
        await fsp.rm(full, { force: true });
        logInfo(`Deleted iScored snapshot ${gameroom}/${name}.`);
        return true;
    }

    /**
     * Delete snapshots older than `retentionDays` (default
     * `ISCORED_SNAPSHOT_RETENTION_DAYS` ?? 30), per gameroom dir. The NEWEST
     * file in a dir is never deleted — an old snapshot beats no snapshot.
     * Files whose name isn't in the timestamp format are ignored entirely.
     */
    static async prune(retentionDays?: number): Promise<number> {
        const root = IScoredSnapshotService.root;
        if (!fs.existsSync(root)) return 0;

        const days = retentionDays ?? IScoredSnapshotService.retentionDays();
        if (!Number.isFinite(days) || days <= 0) return 0;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        let pruned = 0;
        const dirs = await fsp.readdir(root, { withFileTypes: true });
        for (const dir of dirs) {
            if (!dir.isDirectory()) continue;
            const dirPath = path.join(root, dir.name);
            let files: string[];
            try {
                files = (await fsp.readdir(dirPath)).filter((f) => SNAPSHOT_NAME_RE.test(f));
            } catch {
                continue;
            }
            if (files.length <= 1) continue; // never leave a gameroom with nothing

            const withTs: Array<{ file: string; ts: number }> = [];
            for (const file of files) {
                let ts = IScoredSnapshotService.parseSnapshotTimestamp(file);
                if (ts === null) {
                    try {
                        ts = (await fsp.stat(path.join(dirPath, file))).birthtimeMs;
                    } catch {
                        continue;
                    }
                }
                withTs.push({ file, ts });
            }
            withTs.sort((a, b) => b.ts - a.ts);

            for (const entry of withTs.slice(1)) { // index 0 = newest, always kept
                if (entry.ts >= cutoff) continue;
                try {
                    await fsp.rm(path.join(dirPath, entry.file), { force: true });
                    pruned++;
                } catch (err) {
                    logWarn(`iScored snapshot prune: could not delete ${dir.name}/${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        if (pruned > 0) logInfo(`iScored snapshot prune: removed ${pruned} old snapshot(s).`);
        return pruned;
    }

    // ── Restore ──────────────────────────────────────────────────────────────

    /**
     * Pure planner. Compares a snapshot's games against what is live on iScored
     * right now and against the local `games` rows that still reference the
     * snapshot's (dead) iScored ids.
     *
     * Name comparison is normalised — trim, lowercase, apostrophes removed —
     * because iScored silently strips apostrophes when it stores a game name
     * (see `IScoredClient.createGame`).
     */
    static planRestore(
        snapshot: IScoredSnapshot,
        liveGames: Array<{ id: string; name: string }>,
        localRows: Array<{ id: string; name: string; iscored_id: string | null }>,
        gameIds?: string[],
    ): RestorePlan {
        const wanted = gameIds && gameIds.length > 0 ? new Set(gameIds.map(String)) : null;
        const selected = (snapshot.games ?? []).filter((g) => !wanted || wanted.has(String(g.id)));

        const liveByName = new Map<string, string>();
        for (const g of liveGames) liveByName.set(normalizeGameNameForMatch(g.name), g.id);

        const alreadyPresent: RestorePlan['alreadyPresent'] = [];
        const toCreate: RestorePlanGame[] = [];

        for (const g of selected) {
            const liveId = liveByName.get(normalizeGameNameForMatch(g.name));
            if (liveId !== undefined) {
                alreadyPresent.push({ id: g.id, name: g.name, liveId });
                continue;
            }
            const best = bestPerPlayer(g.scores ?? []);
            toCreate.push({
                id: g.id,
                name: g.name,
                hidden: !!g.hidden,
                locked: !!g.locked,
                tags: Array.isArray(g.tags) ? g.tags : [],
                scores: best,
                scoreCount: best.length,
                localGameRows: localRows
                    .filter((r) => r.iscored_id !== null && String(r.iscored_id) === String(g.id))
                    .map((r) => ({ id: r.id, name: r.name })),
            });
        }

        return { alreadyPresent, toCreate };
    }

    /**
     * Recreate the planned games on iScored, sequentially, inside the caller's
     * session. Known and documented losses (the admin modal states all four):
     * iScored assigns NEW game ids, score DATES become restore time, photos are
     * not restored, and only per-player BEST scores come back.
     *
     * A throw on one game is recorded on that game's result and the loop
     * continues — one bad game never strands the rest.
     */
    static async executeRestore(
        client: IScoredClient,
        creds: IScoredCreds,
        plan: RestorePlan,
    ): Promise<RestoreGameResult[]> {
        const { getDatabase } = await import('../database/database.js');
        const db = await getDatabase();

        const useApi = process.env.ISCORED_API_ENABLED !== 'false';
        let api: { submitScore(gameId: string, name: string, score: number): Promise<unknown> } | null = null;
        if (useApi) {
            const { IScoredApiClient } = await import('../engine/IScoredApiClient.js');
            api = new IScoredApiClient({ publicUrl: creds.publicUrl });
        }

        const results: RestoreGameResult[] = [];
        for (const game of plan.toCreate) {
            const result: RestoreGameResult = {
                snapshotId: game.id,
                newId: null,
                name: game.name,
                scoresSubmitted: 0,
                scoresRejected: 0,
                relinkedLocalGames: 0,
            };
            try {
                const newId = await client.createGame(game.name);
                result.newId = newId;

                // One call per tag — the method types a single tag + Enter into
                // Tagify. Comma-joining produces one bogus combined tag.
                for (const tag of game.tags) {
                    try {
                        await client.setGameTags(newId, tag);
                    } catch (err) {
                        logWarn(`Snapshot restore: tag "${tag}" failed for "${game.name}" (continuing):`, err);
                    }
                }

                // Scores go in while the game is OPEN: iScored rejects submissions
                // to a locked game, so the snapshot's locked/hidden state is applied
                // only AFTER the replay (same open-first shape as pinGameToScoreboard).
                await client.setGameStatus(newId, { hidden: false, locked: false });

                for (const s of game.scores) {
                    try {
                        if (api) await api.submitScore(newId, s.name, s.score);
                        else await client.submitScore(newId, s.name, s.score);
                        result.scoresSubmitted++;
                    } catch (err) {
                        result.scoresRejected++;
                        logWarn(`Snapshot restore: score rejected (${s.name} / ${s.score}) on "${game.name}": ${err instanceof Error ? err.message : String(err)}`);
                    }
                }

                if (game.hidden || game.locked) {
                    await client.setGameStatus(newId, { hidden: game.hidden, locked: game.locked });
                }

                // The re-link is what makes ScoreSyncPoller pick the game back up.
                const relink = await db.run(
                    'UPDATE games SET iscored_id = ? WHERE iscored_id = ?',
                    newId, game.id,
                );
                result.relinkedLocalGames = relink?.changes ?? 0;

                logInfo(`Snapshot restore: "${game.name}" recreated as ${newId} (${result.scoresSubmitted} score(s) submitted, ${result.scoresRejected} rejected, ${result.relinkedLocalGames} local row(s) re-linked).`);
            } catch (err) {
                result.error = err instanceof Error ? err.message : String(err);
                logError(`Snapshot restore failed for "${game.name}" (continuing with the next game):`, err);
            }
            results.push(result);
        }
        return results;
    }

    // ── Config ───────────────────────────────────────────────────────────────

    /**
     * Global kill-switch. Unlike backups this defaults ON when unset — a safety
     * net has to work out of the box. Env/global-settings only; no settings UI.
     */
    static async isEnabled(): Promise<boolean> {
        if (process.env.ISCORED_SNAPSHOTS_ENABLED === 'false') return false;
        try {
            const { SettingsService } = await import('./SettingsService.js');
            return (await SettingsService.get('ISCORED_SNAPSHOTS_ENABLED')) !== 'false';
        } catch {
            return true; // settings unreadable → keep the safety net armed
        }
    }

    private static debounceMs(): number {
        const raw = parseInt(process.env.ISCORED_SNAPSHOT_DEBOUNCE_MS || '', 10);
        return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS;
    }

    private static retentionDays(): number {
        const raw = parseInt(process.env.ISCORED_SNAPSHOT_RETENTION_DAYS || '', 10);
        return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
    }

    /** `2026-08-20T14-03-11-123Z.json` → epoch ms; null when the name isn't in that format. */
    private static parseSnapshotTimestamp(name: string): number | null {
        const m = name.match(SNAPSHOT_NAME_RE);
        if (!m) return null;
        const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
        return Number.isNaN(ms) ? null : ms;
    }
}

/** trim + lowercase + apostrophes removed — iScored strips apostrophes on save. */
function normalizeGameNameForMatch(name: string): string {
    return String(name ?? '').trim().toLowerCase().replace(/['’]/g, '');
}

/**
 * One entry per player, highest score wins. iScored keeps a single best per
 * player and rejects anything lower, so replaying every historical entry is
 * pure noise (and N× the submissions).
 */
function bestPerPlayer(scores: IScoredApiScore[]): Array<{ name: string; score: number }> {
    const best = new Map<string, { name: string; score: number }>();
    for (const s of scores) {
        const name = String(s?.name ?? '').trim();
        if (!name) continue;
        const value = Number(String(s?.score ?? '0').replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(value)) continue;
        const key = name.toLowerCase();
        const existing = best.get(key);
        if (!existing || value > existing.score) best.set(key, { name, score: value });
    }
    return Array.from(best.values());
}
