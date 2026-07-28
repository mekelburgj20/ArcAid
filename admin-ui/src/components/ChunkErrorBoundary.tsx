import { Component, type ReactNode } from 'react';

/**
 * S17 — catches failed React.lazy chunk loads. The dominant cause: a deploy
 * replaced the hashed chunks while a user was mid-session, so their old
 * index.html requests a chunk that no longer exists. One automatic reload
 * picks up the new index.html; the sessionStorage timestamp latch (30s)
 * prevents a reload loop when the failure persists (e.g. truly offline), in
 * which case a manual retry screen renders instead. Non-chunk render errors
 * are rethrown so they fail as loudly as they did before this boundary
 * existed.
 */
const RELOAD_LATCH_KEY = 'arcaid-chunk-reload-at';

function isChunkLoadError(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err ?? '');
    return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(msg);
}

interface State { failed: boolean; }

export default class ChunkErrorBoundary extends Component<{ children: ReactNode }, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        if (!isChunkLoadError(error)) throw error;
        const lastReloadAt = Number(sessionStorage.getItem(RELOAD_LATCH_KEY) || 0);
        if (Date.now() - lastReloadAt > 30_000) {
            sessionStorage.setItem(RELOAD_LATCH_KEY, String(Date.now()));
            window.location.reload();
        }
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="flex flex-col items-center justify-center py-24 gap-4 text-center px-4">
                    <p className="text-primary font-display">A new version of Arcaid is available.</p>
                    <p className="text-muted text-sm">Reload to pick it up.</p>
                    <button
                        onClick={() => {
                            sessionStorage.removeItem(RELOAD_LATCH_KEY);
                            window.location.reload();
                        }}
                        className="px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10 transition-colors cursor-pointer"
                    >
                        Reload
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
