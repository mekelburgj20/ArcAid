import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import type { Browser } from 'playwright';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import {
    CABINET_FRAME_GLOBAL, CABINET_FRAME_READY_GLOBAL, type CabinetFrameInput,
} from './cabinetFrameTypes.js';

/**
 * W132.2 (ADR 0046, docs/cabinet-frames-plan.md "Rendering") - draws cabinet
 * frames: JPEG pictures of the app's own `/cabinet-frame` page (W132.3) for a
 * Legends Pinball's backglass (1920x1080) and DMD (1920x1200).
 *
 *   - ONE shared headless Chromium, launched on first use with
 *     `--disable-dev-shm-usage` (prod's Docker /dev/shm is 64 MB) and closed
 *     after 5 minutes idle.
 *   - ONE render at a time through a de-duplicating queue (a frame already
 *     queued, rendering or on disk is never queued again); each render has a
 *     20 s budget, after which the browser is closed and the frame skipped
 *     (the next manifest queues it again).
 *   - Each page has service workers blocked (the app's sw.js caches catalogue
 *     art cache-first). The page gets its input through `page.addInitScript`
 *     (`window.__CABINET_FRAME__`) and says it is done with
 *     `window.__cabinetFrameReady = true`. Nothing else goes into the page: no
 *     device token, no cookie.
 *   - Files: `data/cabinet-frames/<id>.jpg` (the public pair pictures under
 *     `pair/`, so the unauthenticated pair route can never serve a player's
 *     picture). Written to a temp name and renamed, so a half-written picture
 *     is never served. A read touches the mtime; pruning keeps pictures read in
 *     the last 7 days, capped at 500 MB (oldest read first).
 *   - Under vitest it is INERT (nothing queued, no browser) unless a test
 *     installs a capture stub with `setForTests`, like
 *     `IScoredSnapshotService.setRootForTests`.
 */

/** Which store a picture lives in: a device's (player-auth or device-auth reads) or the public pair store. */
export type CabinetFrameScope = 'device' | 'pair';

/** Writes one picture of `input` to `file` (JPEG) within `budgetMs`. */
export type CabinetFrameCapture = (input: CabinetFrameInput, file: string, budgetMs: number) => Promise<void>;

export const CABINET_FRAME_RENDER_BUDGET_MS = 20_000;
export const CABINET_FRAME_IDLE_CLOSE_MS = 5 * 60_000;
export const CABINET_FRAME_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const CABINET_FRAME_MAX_BYTES = 500 * 1024 * 1024;
export const CABINET_FRAME_JPEG_QUALITY = 85;
/** Jobs waiting beyond this are not queued (the next manifest asks again); bounds memory under a flood. */
export const CABINET_FRAME_MAX_QUEUE = 200;
const PRUNE_EVERY_MS = 10 * 60_000;
/** A temp file older than this is a crashed render's leftover. */
const TEMP_MAX_AGE_MS = 60 * 60_000;

const FRAME_ID_RE = /^[0-9a-f]{32}$/;
const FRAME_FILE_RE = /^[0-9a-f]{32}\.jpg$/;
const TEMP_FILE_RE = /^[0-9a-f]{32}\.jpg\.tmp-[0-9a-f]+\.jpg$/;

/** A frame id is exactly 32 lowercase hex characters; validated before it touches a path. */
export function isCabinetFrameId(value: unknown): value is string {
    return typeof value === 'string' && FRAME_ID_RE.test(value);
}

/** The panel size a frame is drawn at. */
export function cabinetFrameViewport(kind: CabinetFrameInput['kind']): { width: number; height: number } {
    return kind === 'dmd' ? { width: 1920, height: 1200 } : { width: 1920, height: 1080 };
}

interface Job { input: CabinetFrameInput; file: string }

export class CabinetFrameRenderer {
    private static root = path.join(process.cwd(), 'data', 'cabinet-frames');
    private static captureOverride: CabinetFrameCapture | null = null;
    private static maxBytes = CABINET_FRAME_MAX_BYTES;
    private static maxAgeMs = CABINET_FRAME_MAX_AGE_MS;

    /** Waiting jobs keyed by file path (insertion order = render order). */
    private static queue = new Map<string, Job>();
    private static current: string | null = null;
    private static draining: Promise<void> | null = null;
    private static browser: Browser | null = null;
    private static launching: Promise<Browser> | null = null;
    private static idleTimer: NodeJS.Timeout | null = null;
    private static lastPruneAt = 0;

    /**
     * Test seam. `capture` replaces the browser (and switches the renderer on
     * under vitest); `root` points the store at a temp dir; `null` restores a
     * default. Clears the queue.
     */
    static setForTests(opts: {
        root?: string | null; capture?: CabinetFrameCapture | null; maxBytes?: number | null; maxAgeMs?: number | null;
    }): void {
        if ('root' in opts) CabinetFrameRenderer.root = opts.root ?? path.join(process.cwd(), 'data', 'cabinet-frames');
        if ('capture' in opts) CabinetFrameRenderer.captureOverride = opts.capture ?? null;
        if ('maxBytes' in opts) CabinetFrameRenderer.maxBytes = opts.maxBytes ?? CABINET_FRAME_MAX_BYTES;
        if ('maxAgeMs' in opts) CabinetFrameRenderer.maxAgeMs = opts.maxAgeMs ?? CABINET_FRAME_MAX_AGE_MS;
        CabinetFrameRenderer.queue.clear();
        CabinetFrameRenderer.lastPruneAt = 0;
    }

    /** False under vitest unless a test installed a capture stub: no browser, no files. */
    private static enabled(): boolean {
        return !(process.env.VITEST && !CabinetFrameRenderer.captureOverride);
    }

    /** The picture's path, or null for an invalid id. */
    static fileFor(id: string, scope: CabinetFrameScope): string | null {
        if (!isCabinetFrameId(id)) return null;
        const dir = scope === 'pair' ? path.join(CabinetFrameRenderer.root, 'pair') : CabinetFrameRenderer.root;
        return path.join(dir, `${id}.jpg`);
    }

    /** Is the picture on disk (rendered)? */
    static async has(id: string, scope: CabinetFrameScope): Promise<boolean> {
        const file = CabinetFrameRenderer.fileFor(id, scope);
        if (!file) return false;
        try {
            return (await fsp.stat(file)).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Queue a render of `input` as picture `id`. A picture already queued or
     * rendering is not queued twice; a full queue drops the job (the caller's
     * next manifest asks again). Returns at once; the render runs behind.
     * The caller has already checked `has`.
     */
    static enqueue(id: string, input: CabinetFrameInput, scope: CabinetFrameScope): void {
        if (!CabinetFrameRenderer.enabled()) return;
        const file = CabinetFrameRenderer.fileFor(id, scope);
        if (!file) return;
        if (CabinetFrameRenderer.queue.has(file) || CabinetFrameRenderer.current === file) return;
        if (CabinetFrameRenderer.queue.size >= CABINET_FRAME_MAX_QUEUE) return;
        CabinetFrameRenderer.queue.set(file, { input, file });
        CabinetFrameRenderer.drain();
    }

    /** Test seam: resolves once the queue is empty and nothing is rendering. */
    static async whenIdle(): Promise<void> {
        while (CabinetFrameRenderer.draining) await CabinetFrameRenderer.draining;
    }

    /** Jobs waiting (not counting the one rendering). */
    static queuedCount(): number {
        return CabinetFrameRenderer.queue.size;
    }

    /**
     * Open a rendered picture for sending, touching its mtime (the cache keeps
     * what was read lately). Null when the id is invalid or not rendered.
     */
    static async open(id: string, scope: CabinetFrameScope): Promise<{ stream: fs.ReadStream; size: number } | null> {
        const file = CabinetFrameRenderer.fileFor(id, scope);
        if (!file) return null;
        let size: number;
        try {
            const stat = await fsp.stat(file);
            if (!stat.isFile()) return null;
            size = stat.size;
        } catch {
            return null;
        }
        const now = new Date();
        await fsp.utimes(file, now, now).catch(() => undefined);
        return { stream: fs.createReadStream(file), size };
    }

    /** One render at a time; the loop restarts itself if a job arrived while it was finishing. */
    private static drain(): void {
        if (CabinetFrameRenderer.draining) return;
        CabinetFrameRenderer.clearIdleClose();
        CabinetFrameRenderer.draining = (async () => {
            while (CabinetFrameRenderer.queue.size > 0) {
                const [file, job] = CabinetFrameRenderer.queue.entries().next().value as [string, Job];
                CabinetFrameRenderer.queue.delete(file);
                CabinetFrameRenderer.current = file;
                try {
                    await CabinetFrameRenderer.renderOne(job);
                } catch (err) {
                    logWarn(`Cabinet frames: render of ${path.basename(file)} failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    CabinetFrameRenderer.current = null;
                }
            }
        })().finally(() => {
            CabinetFrameRenderer.draining = null;
            if (CabinetFrameRenderer.queue.size > 0) {
                CabinetFrameRenderer.drain();
                return;
            }
            CabinetFrameRenderer.armIdleClose();
            void CabinetFrameRenderer.maybePrune();
        });
    }

    /** Render to a temp file inside the budget, then rename into place. */
    private static async renderOne(job: Job): Promise<void> {
        if (await CabinetFrameRenderer.exists(job.file)) return;
        await fsp.mkdir(path.dirname(job.file), { recursive: true });
        const temp = `${job.file}.tmp-${randomBytes(6).toString('hex')}.jpg`;
        const capture = CabinetFrameRenderer.captureOverride ?? CabinetFrameRenderer.chromeCapture;
        try {
            await CabinetFrameRenderer.withBudget(capture(job.input, temp, CABINET_FRAME_RENDER_BUDGET_MS));
            await fsp.rename(temp, job.file);
        } finally {
            await fsp.rm(temp, { force: true }).catch(() => undefined);
        }
    }

    private static async exists(file: string): Promise<boolean> {
        try {
            return (await fsp.stat(file)).isFile();
        } catch {
            return false;
        }
    }

    /** A render that overruns its budget (plus a little for the browser's own timeouts) closes the browser. */
    private static async withBudget(work: Promise<void>): Promise<void> {
        let timer: NodeJS.Timeout | null = null;
        const overrun = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                void CabinetFrameRenderer.closeBrowser();
                reject(new Error('render budget exceeded'));
            }, CABINET_FRAME_RENDER_BUDGET_MS + 2_000);
            timer.unref?.();
        });
        try {
            await Promise.race([work, overrun]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** The page the renderer loads: the app's own, over loopback. */
    private static frameUrl(): string {
        const port = parseInt(process.env.PORT || '3001', 10) || 3001;
        return `http://127.0.0.1:${port}/cabinet-frame`;
    }

    /** The real capture: one page in the shared browser, input injected before load, JPEG at the panel size. */
    private static async chromeCapture(input: CabinetFrameInput, file: string, budgetMs: number): Promise<void> {
        const deadline = Date.now() + budgetMs;
        const left = () => Math.max(1, deadline - Date.now());
        const browser = await CabinetFrameRenderer.browserInstance();
        // Service workers blocked: the app's sw.js serves /api/catalogue-images/
        // cache-first, which could draw a stale picture.
        const page = await browser.newPage({
            viewport: cabinetFrameViewport(input.kind), deviceScaleFactor: 1, serviceWorkers: 'block',
        });
        try {
            await page.addInitScript(({ key, value }) => {
                (globalThis as Record<string, unknown>)[key] = value;
            }, { key: CABINET_FRAME_GLOBAL, value: input });
            await page.goto(CabinetFrameRenderer.frameUrl(), { waitUntil: 'load', timeout: left() });
            await page.waitForFunction(
                (key) => (globalThis as Record<string, unknown>)[key] === true,
                CABINET_FRAME_READY_GLOBAL, { timeout: left() },
            );
            await page.screenshot({ path: file, type: 'jpeg', quality: CABINET_FRAME_JPEG_QUALITY, timeout: left() });
        } finally {
            await page.close().catch(() => undefined);
        }
    }

    /** The shared browser, launched on first use (one launch even when asked twice at once). */
    private static async browserInstance(): Promise<Browser> {
        if (CabinetFrameRenderer.browser?.isConnected()) return CabinetFrameRenderer.browser;
        if (!CabinetFrameRenderer.launching) {
            CabinetFrameRenderer.launching = (async () => {
                const { chromium } = await import('playwright');
                const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
                browser.on('disconnected', () => {
                    if (CabinetFrameRenderer.browser === browser) CabinetFrameRenderer.browser = null;
                });
                CabinetFrameRenderer.browser = browser;
                logInfo('Cabinet frames: browser started');
                return browser;
            })().finally(() => { CabinetFrameRenderer.launching = null; });
        }
        return CabinetFrameRenderer.launching;
    }

    private static clearIdleClose(): void {
        if (CabinetFrameRenderer.idleTimer) clearTimeout(CabinetFrameRenderer.idleTimer);
        CabinetFrameRenderer.idleTimer = null;
    }

    /** Close the browser after 5 minutes with nothing to render. */
    private static armIdleClose(): void {
        CabinetFrameRenderer.clearIdleClose();
        if (!CabinetFrameRenderer.browser) return;
        CabinetFrameRenderer.idleTimer = setTimeout(() => {
            if (!CabinetFrameRenderer.draining) void CabinetFrameRenderer.closeBrowser();
        }, CABINET_FRAME_IDLE_CLOSE_MS);
        CabinetFrameRenderer.idleTimer.unref?.();
    }

    /** Close the shared browser (idle, overrun, shutdown). Never throws. */
    static async closeBrowser(): Promise<void> {
        const browser = CabinetFrameRenderer.browser;
        CabinetFrameRenderer.browser = null;
        CabinetFrameRenderer.clearIdleClose();
        if (!browser) return;
        try {
            await browser.close();
            logInfo('Cabinet frames: browser closed');
        } catch (err) {
            logError('Cabinet frames: closing the browser failed', err);
        }
    }

    private static async maybePrune(): Promise<void> {
        if (Date.now() - CabinetFrameRenderer.lastPruneAt < PRUNE_EVERY_MS) return;
        CabinetFrameRenderer.lastPruneAt = Date.now();
        try {
            await CabinetFrameRenderer.prune();
        } catch (err) {
            logWarn(`Cabinet frames: pruning failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Keep pictures read in the last 7 days, then delete the oldest-read until
     * the store is under 500 MB. Crashed renders' temp files go after an hour.
     */
    static async prune(nowMs: number = Date.now()): Promise<{ removed: number; bytes: number }> {
        const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
        let removed = 0;
        for (const dir of [CabinetFrameRenderer.root, path.join(CabinetFrameRenderer.root, 'pair')]) {
            let names: string[];
            try {
                names = await fsp.readdir(dir);
            } catch {
                continue;
            }
            for (const name of names) {
                const isFrame = FRAME_FILE_RE.test(name);
                if (!isFrame && !TEMP_FILE_RE.test(name)) continue;
                const file = path.join(dir, name);
                let stat: fs.Stats;
                try {
                    stat = await fsp.stat(file);
                } catch {
                    continue;
                }
                const age = nowMs - stat.mtimeMs;
                if (age > (isFrame ? CabinetFrameRenderer.maxAgeMs : TEMP_MAX_AGE_MS)) {
                    if (await CabinetFrameRenderer.remove(file)) removed += 1;
                } else if (isFrame) {
                    files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
                }
            }
        }
        files.sort((a, b) => a.mtimeMs - b.mtimeMs);
        let bytes = files.reduce((sum, f) => sum + f.size, 0);
        for (const f of files) {
            if (bytes <= CabinetFrameRenderer.maxBytes) break;
            if (await CabinetFrameRenderer.remove(f.file)) {
                removed += 1;
                bytes -= f.size;
            }
        }
        return { removed, bytes };
    }

    private static async remove(file: string): Promise<boolean> {
        try {
            await fsp.rm(file, { force: true });
            return true;
        } catch {
            return false;
        }
    }
}
