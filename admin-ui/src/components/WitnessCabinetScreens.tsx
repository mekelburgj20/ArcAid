import { useCallback, useEffect, useRef, useState } from 'react';
import { CABINET_SCREEN_CHOICES, type CabinetScreenKey } from '../lib/cabinetFrameTypes';
import { playerApi } from '../lib/playerApi';
import Button from './parts/Button';
import { Select } from './parts/Field';
import { Skeleton } from './parts/Skeleton';

/**
 * W132.3 (ADR 0046) - "Cabinet screens" under a paired cabinet on Account
 * Settings: which Arcaid screens the cabinet's backglass and DMD show while it
 * waits, how long each stays up, and a strip of the pictures as the cabinet
 * will get them.
 *
 *   GET/PUT /api/me/witness-devices/:id/cabinet-screens  { screens, seconds }
 *   GET     /api/me/witness-devices/:id/cabinet-frames   { screens: [...] }
 *
 * The choice is the signed-in player's own on that device (the cabinet shows
 * whoever is playing). A picture that is not drawn yet shows a skeleton and the
 * strip asks again until it is. The pictures need the player's token, so they
 * are fetched as blobs (an <img> cannot send a header).
 */

const LABELS: Record<Exclude<CabinetScreenKey, 'pair'>, { name: string; help: string }> = {
    attract: { name: 'Attract', help: 'Who is playing and where scores are going.' },
    card: { name: "My rooms' games", help: 'The open tables in your rooms, one picture each.' },
    global: { name: 'Global scoreboard', help: 'How you stand on a table against everyone.' },
    standings: { name: 'Standings', help: 'Your rooms’ seasons and rankings.' },
    activity: { name: 'Activity', help: 'What just happened in your rooms.' },
    event: { name: 'Live event', help: 'The round on now, or the next one.' },
};

const SECONDS_CHOICES = [6, 8, 10, 12, 15, 20, 25, 30] as const;
const DEFAULT_SECONDS = 10;
const MIN_SECONDS = 6;
const MAX_SECONDS = 30;
const POLL_MS = 4000;
const MAX_POLLS = 30;

type Prefs = { screens: string[]; seconds: number };
type PrefsResponse = Prefs & { defaults?: Prefs };
export type CabinetPreviewScreen = {
    key: string; label: string; secs: number;
    backglassUrl: string | null; dmdUrl: string | null; ready: boolean;
};

const ALL_ON: string[] = [...CABINET_SCREEN_CHOICES];
const clampSeconds = (n: unknown): number => {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_SECONDS;
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, v));
};
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

/** One picture, fetched with the player's token. A failure says so in words instead of a broken image. */
function PreviewImage({ url, token, alt, kind }: { url: string; token: string | null; alt: string; kind: 'backglass' | 'dmd' }) {
    const [src, setSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let live = true;
        let made: string | null = null;
        (async () => {
            try {
                const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
                if (!res.ok) throw new Error(String(res.status));
                const blob = await res.blob();
                made = URL.createObjectURL(blob);
                if (live) setSrc(made); else URL.revokeObjectURL(made);
            } catch {
                if (live) setFailed(true);
            }
        })();
        return () => { live = false; if (made) URL.revokeObjectURL(made); };
    }, [url, token]);
    const box = kind === 'backglass' ? 'aspect-[16/9]' : 'aspect-[8/5]';
    if (failed) return <p className={`${box} text-xs text-muted flex items-center justify-center text-center`}>Could not load this picture.</p>;
    if (!src) return <Skeleton className={`block w-full ${box}`} height="auto" />;
    return <img src={src} alt={alt} className={`w-full ${box} rounded object-cover`} />;
}

export default function WitnessCabinetScreens({ deviceId, playerToken }: { deviceId: string; playerToken: string | null }) {
    const base = `/me/witness-devices/${encodeURIComponent(deviceId)}`;

    const [saved, setSaved] = useState<Prefs | null>(null);
    const [defaults, setDefaults] = useState<Prefs>({ screens: ALL_ON, seconds: DEFAULT_SECONDS });
    const [screens, setScreens] = useState<string[]>(ALL_ON);
    const [seconds, setSeconds] = useState<number>(DEFAULT_SECONDS);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

    const [preview, setPreview] = useState<CabinetPreviewScreen[] | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const polls = useRef(0);

    useEffect(() => {
        let live = true;
        playerApi.get<PrefsResponse>(`${base}/cabinet-screens`, { token: playerToken })
            .then(r => {
                if (!live) return;
                const got: Prefs = {
                    screens: Array.isArray(r?.screens) ? r.screens.filter(s => (ALL_ON as string[]).includes(s)) : ALL_ON,
                    seconds: clampSeconds(r?.seconds),
                };
                setSaved(got); setScreens(got.screens); setSeconds(got.seconds);
                if (r?.defaults) setDefaults({ screens: r.defaults.screens ?? ALL_ON, seconds: clampSeconds(r.defaults.seconds) });
            })
            .catch(() => { if (live) setLoadError('Could not load your cabinet screens.'); });
        return () => { live = false; };
    }, [base, playerToken]);

    const loadPreview = useCallback(async () => {
        try {
            const r = await playerApi.get<{ screens?: CabinetPreviewScreen[] }>(`${base}/cabinet-frames`, { token: playerToken });
            setPreview(Array.isArray(r?.screens) ? r.screens : []);
            setPreviewError(false);
            return Array.isArray(r?.screens) ? r.screens.some(s => !s.ready) : false;
        } catch {
            setPreviewError(true);
            return false;
        }
    }, [base, playerToken]);

    // First load, then ask again while any picture is still being drawn.
    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        polls.current = 0;
        const tick = async () => {
            const waiting = await loadPreview();
            if (!live) return;
            polls.current += 1;
            if (waiting && polls.current < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
        };
        void tick();
        return () => { live = false; if (timer) clearTimeout(timer); };
    }, [loadPreview]);

    const dirty = saved != null && (!sameSet(saved.screens, screens) || saved.seconds !== seconds);
    const none = screens.length === 0;

    const toggle = (key: string) => {
        setNote(null);
        setScreens(prev => (prev.includes(key) ? prev.filter(k => k !== key) : ALL_ON.filter(k => k === key || prev.includes(k))));
    };

    const save = async () => {
        setSaving(true); setNote(null);
        try {
            const body: Prefs = { screens, seconds };
            const r = await playerApi.put<PrefsResponse>(`${base}/cabinet-screens`, body, { token: playerToken });
            const now: Prefs = {
                screens: Array.isArray(r?.screens) ? r.screens : screens,
                seconds: r?.seconds != null ? clampSeconds(r.seconds) : seconds,
            };
            setSaved(now); setScreens(now.screens); setSeconds(now.seconds);
            setNote({ tone: 'ok', text: 'Saved. Your cabinet picks this up within a minute.' });
            polls.current = 0;
            void loadPreview();
        } catch (err) {
            setNote({ tone: 'bad', text: (err as Error).message || 'Could not save your cabinet screens.' });
        } finally {
            setSaving(false);
        }
    };

    const reset = () => { setNote(null); setScreens(defaults.screens); setSeconds(defaults.seconds); };
    const atDefaults = sameSet(defaults.screens, screens) && defaults.seconds === seconds;

    return (
        <div className="mt-2 pt-2 border-t border-border space-y-3" data-testid="witness-cabinet-screens">
            <div>
                <h4 className="text-sm text-primary">Cabinet screens</h4>
                <p className="text-xs text-muted">
                    What your cabinet's backglass and DMD show while it waits. It shows them for whoever is playing, so these are your choices on this cabinet.
                </p>
            </div>

            {loadError ? (
                <p className="text-xs text-rose-400" role="alert">{loadError}</p>
            ) : (
                <>
                    <ul className="grid gap-2 sm:grid-cols-2" aria-label="Screens to show">
                        {CABINET_SCREEN_CHOICES.map(key => {
                            const on = screens.includes(key);
                            const id = `cabinet-screen-${deviceId}-${key}`;
                            return (
                                <li key={key} className="flex items-start justify-between gap-3">
                                    <label htmlFor={id} className="min-w-0 cursor-pointer">
                                        <span className="block text-sm text-primary">{LABELS[key].name}</span>
                                        <span className="block text-xs text-muted">{LABELS[key].help}</span>
                                    </label>
                                    <button
                                        id={id}
                                        type="button"
                                        role="switch"
                                        aria-checked={on}
                                        disabled={saved == null}
                                        onClick={() => toggle(key)}
                                        className={`shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-neon-cyan/30 border-neon-cyan/50' : 'bg-surface border-border'}`}
                                    >
                                        <span className={`block w-4 h-4 rounded-full bg-primary transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>

                    <div className="flex flex-wrap items-end gap-3">
                        <Select
                            id={`cabinet-secs-${deviceId}`}
                            label="Seconds on each screen"
                            value={seconds}
                            disabled={saved == null}
                            onChange={e => { setNote(null); setSeconds(clampSeconds(Number(e.target.value))); }}
                            className="w-44"
                        >
                            {SECONDS_CHOICES.map(s => <option key={s} value={s}>{s} seconds</option>)}
                        </Select>
                        <Button size="sm" disabled={!dirty || saving || none} onClick={() => void save()}>
                            {saving ? 'Saving' : 'Save'}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={atDefaults || saving} onClick={reset}>Use the defaults</Button>
                    </div>
                    {none && <p className="text-xs text-rose-400">Pick at least one screen, or the cabinet has nothing to show.</p>}
                    {note && (
                        <p className={`text-xs ${note.tone === 'ok' ? 'text-neon-cyan' : 'text-rose-400'}`} role={note.tone === 'bad' ? 'alert' : 'status'}>{note.text}</p>
                    )}
                </>
            )}

            <div data-testid="cabinet-preview">
                <h5 className="text-xs text-muted tracking-wide uppercase mb-1">What it will show</h5>
                {previewError && <p className="text-xs text-rose-400">Could not load the preview.</p>}
                {!previewError && preview == null && <p className="text-xs text-muted">Loading the preview.</p>}
                {preview != null && preview.length === 0 && (
                    <p className="text-xs text-muted">Nothing to show yet. Open tables, standings and events in your rooms appear here when there are some.</p>
                )}
                {preview != null && preview.length > 0 && (
                    <ul className="flex gap-3 overflow-x-auto pb-2">
                        {preview.map(s => (
                            <li key={`${s.key}-${s.backglassUrl ?? s.dmdUrl ?? s.label}`} className="shrink-0 w-56 space-y-1" data-testid={`cabinet-preview-${s.key}`}>
                                <p className="text-xs text-primary">{s.label} <span className="text-muted">{s.secs} seconds</span></p>
                                {s.ready ? (
                                    <div className="space-y-1">
                                        {s.backglassUrl && <PreviewImage key={s.backglassUrl} url={s.backglassUrl} token={playerToken} kind="backglass" alt={`${s.label}, as the backglass shows it`} />}
                                        {s.dmdUrl && <PreviewImage key={s.dmdUrl} url={s.dmdUrl} token={playerToken} kind="dmd" alt={`${s.label}, as the DMD shows it`} />}
                                    </div>
                                ) : (
                                    <div className="space-y-1" role="status" aria-busy="true">
                                        <Skeleton className="block w-full aspect-[16/9]" height="auto" />
                                        <p className="text-xs text-muted">Being drawn. This takes a few seconds.</p>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
