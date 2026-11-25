/**
 * G23 - loading a pop-up part on demand.
 *
 * base-ui adds tens of kB gzip to whatever chunk imports it, so a pop-up part
 * keeps its base-ui half in its own chunk and the page draws a working
 * stand-in until that chunk arrives (style plan decision 3; the room
 * switcher's menu was first, `components/RoomSwitcher.tsx`, whose loading
 * this is taken from):
 *
 * - one download per chunk, shared by every caller on the page;
 * - after a failure the promise is forgotten, so the next call tries again;
 * - a browser keeps a failed module fetch in its module map and refuses the
 *   same URL again without asking the network (Chromium, checked 2026-11-23),
 *   so a retry asks for the chunk under `?retry=N` of the URL that failed.
 *   Its own imports keep their normal URLs, so React and the rest stay the
 *   same instances.
 *
 * Each part is registered under a name, so a test can swap its import
 * (`setPartImporterForTests`) without reaching into the component.
 */

export interface LazyPart<M> {
    /** The module, if it has arrived; never waits. */
    loaded(): M | null;
    /** The module, fetched once for every caller; rejects when the chunk cannot load. */
    load(): Promise<M>;
    /** Fetch it when the browser is idle (once; again after a failed try). */
    prefetch(): void;
}

interface PartState {
    importer: () => Promise<unknown>;
    module: unknown;
    pending: Promise<unknown> | null;
    failures: number;
    failedChunkUrl: string | null;
    prefetchQueued: boolean;
}

const parts = new Map<string, PartState>();
/** Each part's own import, kept for `setPartImporterForTests` to go back to. */
const ownImporters = new Map<string, () => Promise<unknown>>();

/** The chunk's URL from the browser's failure message (Chrome and Firefox name it; Safari does not). */
export function chunkUrlOf(err: unknown): string | null {
    const message = err instanceof Error ? err.message : String(err);
    // A module script's URL only, never some other link in the message.
    return /https?:\/\/[^\s'"?#]+\.(?:m?js|[jt]sx?)(?=[\s'"?#]|$)/.exec(message)?.[0] ?? null;
}

/** When the browser is idle (a fixed wait where it cannot say). */
function whenIdle(run: () => void): void {
    if (typeof window === 'undefined') return;
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 4000 });
        return;
    }
    window.setTimeout(run, 1500);
}

function fresh(importer: () => Promise<unknown>): PartState {
    return { importer, module: null, pending: null, failures: 0, failedChunkUrl: null, prefetchQueued: false };
}

function importOnce(state: PartState): Promise<unknown> {
    if (state.failures > 0 && state.failedChunkUrl) {
        return import(/* @vite-ignore */ `${state.failedChunkUrl}?retry=${state.failures}`);
    }
    return state.importer();
}

function load(state: PartState): Promise<unknown> {
    if (state.module) return Promise.resolve(state.module);
    if (!state.pending) {
        state.pending = importOnce(state).then(
            mod => {
                state.module = mod;
                return mod;
            },
            err => {
                state.pending = null;
                state.failures += 1;
                state.failedChunkUrl = chunkUrlOf(err) ?? state.failedChunkUrl;
                throw err;
            },
        );
    }
    return state.pending;
}

/**
 * Registers a part under `name` (once; a second call returns the same part).
 * `importer` is the part's `() => import('./Chunk')`, written at the call site
 * so the bundler splits it out.
 */
export function lazyPart<M>(name: string, importer: () => Promise<M>): LazyPart<M> {
    if (!parts.has(name)) {
        parts.set(name, fresh(importer));
        ownImporters.set(name, importer);
    }
    const state = () => parts.get(name)!;
    return {
        loaded: () => (state().module as M | null) ?? null,
        load: () => load(state()) as Promise<M>,
        prefetch: () => {
            const s = state();
            if (s.module || s.pending || s.prefetchQueued) return;
            s.prefetchQueued = true;
            whenIdle(() => {
                load(s).catch(() => {
                    // Let the next mount queue another try.
                    s.prefetchQueued = false;
                });
            });
        },
    };
}

/** Tests only: start the part over with this import (or its own again, given none). */
export function setPartImporterForTests(name: string, importer?: () => Promise<unknown>): void {
    const use = importer ?? ownImporters.get(name);
    if (use) parts.set(name, fresh(use));
}
