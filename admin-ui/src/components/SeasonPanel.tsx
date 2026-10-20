import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, X } from 'lucide-react';
import NeonButton from './NeonButton';
import { DateTimeField } from './EventSettingsFields';
import { parseCadence } from './TournamentForm';
import { api } from '../lib/api';
import { DEFAULT_TIMEZONE } from '../lib/timezone';
import { getSocket } from '../lib/websocket';
import { utcIsoToWallTime, wallTimeToUtcIso } from '../lib/eventTime';
import { TIE_RULE_LABEL, zoneLabel, type PollTieRule as SeasonTieRule } from '../lib/pollForm';
import type { Tournament } from '../lib/tournamentFormPayload';

/**
 * Season / Polls panel (docs/season-format-plan.md §8.2, §13) — the admin's
 * control surface for a Season (progress, pause/resume) and for Pick by poll
 * (the poll QUEUE that picks each next table). Since v2.162.0 (ADR 0026) the
 * two are independent: a Season renders progress + pause only, a poll-picked
 * tournament renders the queue only, a poll-picked Season renders both.
 *
 * Every poll is a row in `season_polls`; the server's `SeasonScheduler` posts a
 * draft when its open time arrives, closes and resolves it, and queues the
 * winner. This panel only edits drafts and overrides the clock (Close now,
 * Cancel, Repost) — it never flips a status itself.
 *
 * Uses `api.*` deliberately (room-admin surface, admin token), same as
 * `EventRoundsPanel`. Refetches on the room socket's `season:poll` event, which
 * the server emits on every tally or state change.
 *
 * Times are shown — and absolute overrides entered — in the TOURNAMENT's
 * timezone (its cadence), because that is the clock the rotation runs on.
 */

type PollStatus = 'draft' | 'open' | 'resolved' | 'cancelled';

interface PollCandidate {
    position: number;
    game_name: string;
    global_game_id: string | null;
    discord_answer_id: number | null;
    votes: number;
}

interface PollVoter {
    user_id: string;
    display_name: string | null;
    position: number;
    source: 'web' | 'discord';
    voted_at: string;
}

export interface SeasonPoll {
    id: string;
    slot_no: number;
    status: PollStatus;
    question: string;
    question_custom: string | null;
    opens_at: string | null;
    closes_at: string | null;
    posted_at: string | null;
    discord_channel_id: string | null;
    discord_message_id: string | null;
    discord_url: string | null;
    tie_rule: SeasonTieRule | null;
    effective_tie_rule: SeasonTieRule;
    result_game_name: string | null;
    result_queued_game_id: string | null;
    result_queued_status: string | null;
    tied: boolean;
    tied_positions: number[];
    can_choose: boolean;
    resolved_at: string | null;
    created_at: string;
    beyond_bound: boolean;
    candidates: PollCandidate[];
    total_votes: number;
    voters: PollVoter[];
}

export interface SeasonQueue {
    tournament_id: string;
    poll_picks: boolean;
    /** null for a poll-only (season-less) tournament. */
    table_count: number | null;
    tables_done: number | null;
    resolved_count: number;
    bound_reached: boolean;
    paused: boolean;
    finished: boolean;
    polls: SeasonPoll[];
}

interface CandidateOption {
    global_game_id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    played_before: boolean;
}

interface DraftCandidate {
    game_name: string;
    global_game_id: string | null;
}

/** Editor state. `pollId: null` = a new draft. */
interface EditorState {
    pollId: string | null;
    status: 'draft' | 'open';
    question: string;
    candidates: DraftCandidate[];
    /** keep = leave the stored times alone (edit only); derived = season defaults; exact = the two fields below. */
    timeMode: 'keep' | 'derived' | 'exact';
    opensLocal: string;
    closesLocal: string;
    /** The open poll's current close time — a new one must be earlier. */
    originalClosesAt: string | null;
    channel: string;
    tieRule: '' | SeasonTieRule;
}

const MAX_CANDIDATES = 10;

const inputClass = 'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';
const labelClass = 'block text-xs font-display uppercase tracking-wider text-muted mb-1.5';
const smallBtn = 'text-xs px-3 py-1.5 min-h-9';

const STATUS_META: Record<PollStatus, { label: string; tone: string }> = {
    draft: { label: 'Draft', tone: 'bg-border/30 text-muted border-border' },
    open: { label: 'Open', tone: 'bg-neon-green/15 text-neon-green border-neon-green/40' },
    resolved: { label: 'Resolved', tone: 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40' },
    cancelled: { label: 'Cancelled', tone: 'bg-neon-magenta/10 text-neon-magenta border-neon-magenta/40' },
};

/** SQLite `datetime('now')` ships without a zone; everything else is ISO UTC. */
function parseServerTime(value: string | null | undefined): number {
    if (!value) return NaN;
    const v = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    return Date.parse(v);
}

function formatWhen(value: string | null | undefined, timeZone: string): string | null {
    const ms = parseServerTime(value);
    if (Number.isNaN(ms)) return null;
    try {
        return new Date(ms).toLocaleString(undefined, {
            timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
    } catch {
        return new Date(ms).toLocaleString();
    }
}

function emptyEditor(): EditorState {
    return {
        pollId: null, status: 'draft', question: '', candidates: [], timeMode: 'derived',
        opensLocal: '', closesLocal: '', originalClosesAt: null, channel: '', tieRule: '',
    };
}

function editorFor(poll: SeasonPoll, tz: string): EditorState {
    return {
        pollId: poll.id,
        status: poll.status === 'open' ? 'open' : 'draft',
        question: poll.question_custom ?? '',
        candidates: poll.candidates
            .slice()
            .sort((a, b) => a.position - b.position)
            .map(c => ({ game_name: c.game_name, global_game_id: c.global_game_id })),
        timeMode: 'keep',
        opensLocal: utcIsoToWallTime(poll.opens_at, tz),
        closesLocal: utcIsoToWallTime(poll.closes_at, tz),
        originalClosesAt: poll.closes_at,
        channel: poll.discord_channel_id ?? '',
        tieRule: poll.tie_rule ?? '',
    };
}

/** Client-side mirror of the server's time rules; the server also checks "closes before the next rotation". */
function editorTimeError(ed: EditorState, tz: string, now: number = Date.now()): string | null {
    if (ed.status === 'open') {
        const closes = wallTimeToUtcIso(ed.closesLocal, tz);
        if (!closes) return 'Pick a close time.';
        const ms = Date.parse(closes);
        if (ed.originalClosesAt && ms >= parseServerTime(ed.originalClosesAt)) {
            return 'An open poll can only close earlier — Discord cannot extend a poll.';
        }
        if (ms <= now) return 'That time has already passed — use "Close now" instead.';
        return null;
    }
    if (ed.timeMode !== 'exact') return null;
    const opens = wallTimeToUtcIso(ed.opensLocal, tz);
    const closes = wallTimeToUtcIso(ed.closesLocal, tz);
    if (!opens || !closes) return 'Set both the open and the close time.';
    if (Date.parse(closes) - Date.parse(opens) < 3600_000) return 'The poll must stay open for at least 1 hour.';
    return null;
}

/** The request body for the editor's save. */
function editorBody(ed: EditorState, tz: string): Record<string, unknown> {
    if (ed.status === 'open') {
        return { closes_at: wallTimeToUtcIso(ed.closesLocal, tz) };
    }
    const body: Record<string, unknown> = {
        candidates: ed.candidates.map(c => ({ game_name: c.game_name, global_game_id: c.global_game_id ?? null })),
    };
    const isNew = ed.pollId === null;
    const question = ed.question.trim();
    if (question || !isNew) body.question = question || null;
    if (ed.timeMode === 'exact') {
        body.opens_at = wallTimeToUtcIso(ed.opensLocal, tz);
        body.closes_at = wallTimeToUtcIso(ed.closesLocal, tz);
    } else if (ed.timeMode === 'derived' && !isNew) {
        body.opens_at = null;
        body.closes_at = null;
    }
    const channel = ed.channel.trim();
    if (channel || !isNew) body.discord_channel_id = channel || null;
    if (ed.tieRule || !isNew) body.tie_rule = ed.tieRule || null;
    return body;
}

/** Search the approved catalogue for candidates that pass the tournament's platform rules. */
function CandidatePicker({ roomId, tournamentId, chosen, onAdd }: {
    roomId: string;
    tournamentId: string;
    chosen: DraftCandidate[];
    onAdd: (c: DraftCandidate) => void;
}) {
    const [q, setQ] = useState('');
    const [unplayed, setUnplayed] = useState(true);
    const [results, setResults] = useState<CandidateOption[]>([]);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const handle = setTimeout(async () => {
            setSearching(true);
            try {
                const params = new URLSearchParams();
                if (q.trim()) params.set('q', q.trim());
                if (unplayed) params.set('unplayed', '1');
                params.set('limit', '25');
                const res = await api.get<{ candidates: CandidateOption[] }>(
                    `/rooms/${roomId}/tournaments/${tournamentId}/season/candidates?${params.toString()}`,
                );
                if (!cancelled) setResults(res.candidates ?? []);
            } catch {
                if (!cancelled) setResults([]);
            } finally {
                if (!cancelled) setSearching(false);
            }
        }, 250);
        return () => { cancelled = true; clearTimeout(handle); };
    }, [roomId, tournamentId, q, unplayed]);

    const full = chosen.length >= MAX_CANDIDATES;
    const isChosen = (r: CandidateOption) =>
        chosen.some(c => (c.global_game_id && c.global_game_id === r.global_game_id) || c.game_name.toLowerCase() === r.name.toLowerCase());

    return (
        <div className="rounded border border-border/60 p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <input
                    type="search" value={q} onChange={e => setQ(e.target.value)}
                    placeholder="Search the catalogue" aria-label="Search candidates"
                    className={`${inputClass} sm:flex-1`}
                />
                <label className="flex items-center gap-2 cursor-pointer text-sm text-muted whitespace-nowrap min-h-9">
                    <input type="checkbox" checked={unplayed} onChange={e => setUnplayed(e.target.checked)} className="accent-neon-cyan" />
                    Not yet played
                </label>
            </div>
            {full && <p className="text-xs text-neon-amber">That's {MAX_CANDIDATES} — Discord polls hold at most {MAX_CANDIDATES} answers.</p>}
            <ul className="max-h-56 overflow-y-auto divide-y divide-border/30" aria-label="Candidate search results">
                {searching && results.length === 0 && <li className="py-2 text-xs text-faint">Searching…</li>}
                {!searching && results.length === 0 && <li className="py-2 text-xs text-faint">No eligible tables match.</li>}
                {results.map(r => {
                    const taken = isChosen(r);
                    return (
                        <li key={r.global_game_id} className="flex items-center gap-2 py-1.5">
                            <span className="min-w-0 flex-1 text-sm text-primary break-words">
                                {r.name}
                                {(r.manufacturer || r.year) && (
                                    <span className="text-xs text-faint"> ({[r.manufacturer, r.year].filter(Boolean).join(' ')})</span>
                                )}
                                {r.played_before && (
                                    <span className="ml-2 text-[10px] uppercase tracking-wider text-neon-amber whitespace-nowrap">Played before</span>
                                )}
                            </span>
                            <NeonButton
                                variant="ghost" className={smallBtn} disabled={taken || full}
                                onClick={() => onAdd({ game_name: r.name, global_game_id: r.global_game_id })}
                                aria-label={`Add ${r.name}`}
                            >
                                {taken ? 'Added' : 'Add'}
                            </NeonButton>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function PollEditor({ roomId, tournamentId, tz, defaultTieRule, editor, setEditor, onSave, onCancel, saving }: {
    roomId: string;
    tournamentId: string;
    tz: string;
    defaultTieRule: SeasonTieRule;
    editor: EditorState;
    setEditor: (e: EditorState) => void;
    onSave: () => void;
    onCancel: () => void;
    saving: boolean;
}) {
    const locked = editor.status === 'open';
    const patch = (p: Partial<EditorState>) => setEditor({ ...editor, ...p });
    const move = (i: number, delta: -1 | 1) => {
        const next = editor.candidates.slice();
        const j = i + delta;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        patch({ candidates: next });
    };
    const timeError = editorTimeError(editor, tz);

    return (
        <section className="rounded-lg border border-neon-cyan/40 bg-raised/40 p-3 sm:p-4 space-y-4" aria-label="Poll editor">
            <div className="flex items-start justify-between gap-2">
                <h3 className="font-display text-sm font-bold uppercase tracking-wider text-neon-cyan">
                    {editor.pollId === null ? 'New poll' : locked ? 'Open poll — change close time' : 'Edit draft'}
                </h3>
                <NeonButton variant="ghost" className={smallBtn} onClick={onCancel} aria-label="Close editor"><X size={14} /></NeonButton>
            </div>
            {locked && (
                <p className="text-xs text-neon-amber">
                    This poll is live on Discord, so its question, candidates and open time are frozen. It can only close earlier.
                    To change anything else, cancel it and repost.
                </p>
            )}

            <div>
                <label className={labelClass} htmlFor="season-poll-question">Question <span className="normal-case tracking-normal text-faint">(blank = default)</span></label>
                <input
                    id="season-poll-question" type="text" value={editor.question} disabled={locked} maxLength={300}
                    onChange={e => patch({ question: e.target.value })}
                    placeholder="e.g. Which table should we play next week?"
                    className={`${inputClass} disabled:opacity-60`}
                />
            </div>

            <div>
                <p className={labelClass}>
                    Candidates ({editor.candidates.length}/{MAX_CANDIDATES})
                    <span className="normal-case tracking-normal text-faint"> — order = "first nominated" for ties</span>
                </p>
                {editor.candidates.length === 0 ? (
                    <p className="text-xs text-faint mb-2">None yet. A poll needs at least two candidates before it can post.</p>
                ) : (
                    <ol className="space-y-1 mb-2" aria-label="Chosen candidates">
                        {editor.candidates.map((c, i) => (
                            <li key={`${c.game_name}-${i}`} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1">
                                <span className="font-mono text-xs text-faint w-5 text-right flex-shrink-0">{i + 1}</span>
                                <span className="min-w-0 flex-1 text-sm text-primary break-words">{c.game_name}</span>
                                {!locked && (
                                    <span className="flex gap-1 flex-shrink-0">
                                        <NeonButton variant="ghost" className={smallBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${c.game_name} up`}><ChevronUp size={14} /></NeonButton>
                                        <NeonButton variant="ghost" className={smallBtn} disabled={i === editor.candidates.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${c.game_name} down`}><ChevronDown size={14} /></NeonButton>
                                        <NeonButton variant="ghost" className={smallBtn} onClick={() => patch({ candidates: editor.candidates.filter((_, k) => k !== i) })} aria-label={`Remove ${c.game_name}`}><X size={14} /></NeonButton>
                                    </span>
                                )}
                            </li>
                        ))}
                    </ol>
                )}
                {!locked && (
                    <CandidatePicker
                        roomId={roomId} tournamentId={tournamentId} chosen={editor.candidates}
                        onAdd={c => { if (editor.candidates.length < MAX_CANDIDATES) patch({ candidates: [...editor.candidates, c] }); }}
                    />
                )}
            </div>

            <div>
                <p className={labelClass}>Times <span className="normal-case tracking-normal text-faint">({zoneLabel(tz)})</span></p>
                {locked ? (
                    <div className="max-w-sm">
                        <p className="text-xs text-muted mb-1">Close at</p>
                        <DateTimeField value={editor.closesLocal} onChange={v => patch({ closesLocal: v })} invalid={!!timeError} />
                    </div>
                ) : (
                    <div className="space-y-2">
                        <select
                            value={editor.timeMode} aria-label="Poll times"
                            onChange={e => {
                                const mode = e.target.value as EditorState['timeMode'];
                                patch({ timeMode: mode });
                            }}
                            className={`${inputClass} cursor-pointer sm:max-w-sm`}
                        >
                            {editor.pollId !== null && <option value="keep">Keep the current times</option>}
                            <option value="derived">Poll defaults (hours before the rotation)</option>
                            <option value="exact">Exact open and close times</option>
                        </select>
                        {editor.timeMode === 'exact' && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <p className="text-xs text-muted mb-1">Opens</p>
                                    <DateTimeField value={editor.opensLocal} onChange={v => patch({ opensLocal: v })} invalid={!!timeError} />
                                </div>
                                <div>
                                    <p className="text-xs text-muted mb-1">Closes</p>
                                    <DateTimeField value={editor.closesLocal} onChange={v => patch({ closesLocal: v })} invalid={!!timeError} />
                                </div>
                            </div>
                        )}
                        <p className="text-xs text-faint">The poll must close before the next rotation; the server will say so if it doesn't.</p>
                    </div>
                )}
                {timeError && <p className="text-xs text-neon-magenta mt-1" role="alert">{timeError}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className={labelClass} htmlFor="season-poll-channel">Discord channel <span className="normal-case tracking-normal text-faint">(blank = tournament's)</span></label>
                    <input
                        id="season-poll-channel" type="text" inputMode="numeric" value={editor.channel} disabled={locked}
                        onChange={e => patch({ channel: e.target.value })} placeholder="Channel ID"
                        className={`${inputClass} disabled:opacity-60`}
                    />
                </div>
                <div>
                    <label className={labelClass} htmlFor="season-poll-tie">Poll Tie-breaker</label>
                    <select
                        id="season-poll-tie" value={editor.tieRule} disabled={locked}
                        onChange={e => patch({ tieRule: e.target.value as EditorState['tieRule'] })}
                        className={`${inputClass} cursor-pointer disabled:opacity-60`}
                    >
                        <option value="">Tournament default — {TIE_RULE_LABEL[defaultTieRule]}</option>
                        {(Object.keys(TIE_RULE_LABEL) as SeasonTieRule[]).map(r => (
                            <option key={r} value={r}>{TIE_RULE_LABEL[r]}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
                <NeonButton variant="ghost" className={smallBtn} onClick={onCancel} disabled={saving}>Cancel</NeonButton>
                <NeonButton className={smallBtn} onClick={onSave} disabled={saving || !!timeError}>
                    {saving ? 'Saving…' : editor.pollId === null ? 'Create draft' : 'Save'}
                </NeonButton>
            </div>
        </section>
    );
}

interface SeasonPanelProps {
    roomId: string;
    tournament: Tournament;
    onClose: () => void;
    /** The tournaments list shows season progress — refresh it after pause/resume. */
    onChanged: () => void;
    toast: (message: string, kind?: 'success' | 'error') => void;
    /** The room's default zone (`ROOM_TIMEZONE`) — fills a cadence that carries none. */
    roomTimezone?: string;
}

export default function SeasonPanel({ roomId, tournament, onClose, onChanged, toast, roomTimezone: roomTz = DEFAULT_TIMEZONE }: SeasonPanelProps) {
    // The tournament's own cadence zone wins; the room's zone fills a cadence without one.
    const tz = useMemo(() => parseCadence(tournament.cadence, roomTz).timezone, [tournament.cadence, roomTz]);
    const defaultTieRule = (tournament.poll_tie_rule as SeasonTieRule) || 'admin';
    const base = `/rooms/${roomId}/tournaments/${tournament.id}/season`;

    const [queue, setQueue] = useState<SeasonQueue | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [editor, setEditor] = useState<EditorState | null>(null);

    const refresh = useCallback(async () => {
        try {
            setQueue(await api.get<SeasonQueue>(`${base}/polls`));
        } catch (err) {
            toast((err as Error)?.message || 'Could not load the season', 'error');
        }
    }, [base, toast]);

    // First load. Written out (not `refresh()`) so every setState sits in a
    // promise callback, never synchronously in the effect body.
    useEffect(() => {
        let alive = true;
        api.get<SeasonQueue>(`${base}/polls`)
            .then(q => { if (alive) setQueue(q); })
            .catch(err => { if (alive) toast((err as Error)?.message || 'Could not load the season', 'error'); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [base, toast]);

    // Live: the scheduler and the vote routes emit `season:poll` on `room:<id>`.
    useEffect(() => {
        const socket = getSocket();
        const join = () => socket.emit('join:room', roomId);
        join();
        socket.on('connect', join);
        const onPoll = (payload: { tournamentId?: string } | undefined) => {
            if (!payload?.tournamentId || payload.tournamentId === tournament.id) void refresh();
        };
        socket.on('season:poll', onPoll);
        return () => {
            socket.off('connect', join);
            socket.off('season:poll', onPoll);
        };
    }, [roomId, tournament.id, refresh]);

    const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
        setBusy(key);
        try {
            await fn();
            toast(success, 'success');
            await refresh();
        } catch (err) {
            toast((err as Error)?.message || 'That did not work', 'error');
        } finally {
            setBusy(null);
        }
    };

    const pollAction = (poll: SeasonPoll, action: 'close' | 'cancel' | 'repost', success: string, confirmText?: string) => {
        if (confirmText && !window.confirm(confirmText)) return;
        void run(`${poll.id}-${action}`, () => api.post(`${base}/polls/${poll.id}/${action}`, {}), success);
    };

    const reorder = (poll: SeasonPoll, target: SeasonPoll) =>
        run(`${poll.id}-reorder`, () => api.post(`${base}/polls/${poll.id}/reorder`, { slot_no: target.slot_no }), `Moved to week ${target.slot_no}`);

    const choose = (poll: SeasonPoll, position: number) => {
        const name = poll.candidates.find(c => c.position === position)?.game_name ?? 'that table';
        void run(`${poll.id}-choose`, () => api.post(`${base}/polls/${poll.id}/choose`, { position }), `${name} is queued instead`);
    };

    const setPaused = (pause: boolean) =>
        run(pause ? 'pause' : 'resume', async () => {
            await api.post(`${base}/${pause ? 'pause' : 'resume'}`, {});
            onChanged();
        }, pause ? 'Season paused' : 'Season resumed');

    const saveEditor = async () => {
        if (!editor) return;
        const body = editorBody(editor, tz);
        setBusy('editor');
        try {
            if (editor.pollId === null) {
                await api.post(`${base}/polls`, body);
                toast('Draft poll created', 'success');
            } else {
                await api.put(`${base}/polls/${editor.pollId}`, body);
                toast(editor.status === 'open' ? 'Close time moved' : 'Draft saved', 'success');
            }
            setEditor(null);
            await refresh();
        } catch (err) {
            toast((err as Error)?.message || 'Could not save the poll', 'error');
        } finally {
            setBusy(null);
        }
    };

    const polls = queue?.polls ?? [];
    const isSeason = (queue ? queue.table_count : tournament.season_table_count) != null;
    const pollPicks = queue ? queue.poll_picks : !!tournament.poll_picks;
    const tableCount = queue?.table_count ?? tournament.season_table_count ?? 0;
    const tablesDone = queue?.tables_done ?? 0;
    const finished = !!queue?.finished;
    const paused = !!queue?.paused;
    const week = Math.min(tablesDone + 1, tableCount);

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-surface border border-border rounded-lg p-4 sm:p-6 w-full max-w-3xl max-h-[92vh] overflow-y-auto">
                <div className="flex items-start justify-between mb-4 gap-3">
                    <div className="min-w-0">
                        <h2 className="font-display text-lg font-bold break-words">{tournament.name}</h2>
                        {isSeason && (
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                            <span className="text-sm text-primary font-medium" data-testid="season-progress">
                                {finished ? `Season finished · ${tablesDone} of ${tableCount} tables` : `Week ${week} of ${tableCount}`}
                            </span>
                            {paused && !finished && (
                                <span className="text-xs px-2 py-0.5 rounded border bg-neon-amber/15 text-neon-amber border-neon-amber/40">Paused</span>
                            )}
                            {finished && (
                                <span className="text-xs px-2 py-0.5 rounded border bg-border/30 text-muted border-border">Finished</span>
                            )}
                            {queue?.bound_reached && !finished && (
                                <span className="text-xs px-2 py-0.5 rounded border bg-neon-cyan/10 text-neon-cyan border-neon-cyan/40">Every table chosen</span>
                            )}
                        </div>
                        )}
                        {!isSeason && (
                            <p className="text-sm text-primary font-medium mt-1" data-testid="poll-heading">Pick by poll</p>
                        )}
                        <p className="text-xs text-muted mt-1">
                            {isSeason && paused
                                ? 'Paused: no poll posts and the table does not rotate until you resume.'
                                : pollPicks
                                    ? 'Polls post, close and queue their winner on their own. Use these controls only to change the plan.'
                                    : 'Pick by poll is off for this season — its tables are chosen by the Game Rotation settings. Turn it on in Edit to run polls.'}
                        </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
                        {isSeason && !finished && (
                            <NeonButton
                                variant={paused ? 'primary' : 'ghost'} className={smallBtn}
                                disabled={busy === 'pause' || busy === 'resume'}
                                onClick={() => setPaused(!paused)}
                            >
                                {paused ? 'Resume season' : 'Pause season'}
                            </NeonButton>
                        )}
                        <NeonButton variant="ghost" onClick={onClose} className={smallBtn}>Close</NeonButton>
                    </div>
                </div>

                {!pollPicks ? null : loading ? (
                    <p className="text-sm text-muted py-6 text-center">Loading the poll queue…</p>
                ) : (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted">Poll queue</h3>
                            {!editor && (
                                <NeonButton className={smallBtn} onClick={() => setEditor(emptyEditor())}>New poll</NeonButton>
                            )}
                        </div>

                        {editor && (
                            <PollEditor
                                roomId={roomId} tournamentId={tournament.id} tz={tz} defaultTieRule={defaultTieRule}
                                editor={editor} setEditor={setEditor} onSave={saveEditor}
                                onCancel={() => setEditor(null)} saving={busy === 'editor'}
                            />
                        )}

                        {polls.length === 0 && !editor && (
                            <p className="text-sm text-faint py-4 text-center">No polls yet. Add the first one so the next table can be voted on.</p>
                        )}

                        <ol className="space-y-3" aria-label="Poll queue">
                            {polls.map((poll, idx) => (
                                <PollCard
                                    key={poll.id} poll={poll} tz={tz} busy={busy}
                                    prev={idx > 0 ? polls[idx - 1] : null}
                                    next={idx < polls.length - 1 ? polls[idx + 1] : null}
                                    onEdit={() => setEditor(editorFor(poll, tz))}
                                    onAction={pollAction}
                                    onReorder={reorder}
                                    onChoose={choose}
                                />
                            ))}
                        </ol>
                    </div>
                )}
            </div>
        </div>
    );
}

function PollCard({ poll, tz, busy, prev, next, onEdit, onAction, onReorder, onChoose }: {
    poll: SeasonPoll;
    tz: string;
    busy: string | null;
    prev: SeasonPoll | null;
    next: SeasonPoll | null;
    onEdit: () => void;
    onAction: (poll: SeasonPoll, action: 'close' | 'cancel' | 'repost', success: string, confirmText?: string) => void;
    onReorder: (poll: SeasonPoll, target: SeasonPoll) => void;
    onChoose: (poll: SeasonPoll, position: number) => void;
}) {
    const [showVoters, setShowVoters] = useState(false);
    const meta = STATUS_META[poll.status];
    const maxVotes = Math.max(0, ...poll.candidates.map(c => c.votes));
    const candidates = poll.candidates.slice().sort((a, b) => a.position - b.position);
    const nameAt = (pos: number) => candidates.find(c => c.position === pos)?.game_name ?? `#${pos}`;
    const isBusy = (action: string) => busy === `${poll.id}-${action}`;
    const opens = formatWhen(poll.opens_at, tz);
    const closes = formatWhen(poll.closes_at, tz);
    const posted = formatWhen(poll.posted_at, tz);

    return (
        <li className="rounded-lg border border-border bg-surface p-3 sm:p-4" data-testid={`poll-${poll.id}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-sm font-bold text-primary">Week {poll.slot_no}</span>
                <span className={`text-xs px-2 py-0.5 rounded border ${meta.tone}`}>{meta.label}</span>
                {poll.tied && (
                    <span className="text-xs px-2 py-0.5 rounded border bg-neon-amber/15 text-neon-amber border-neon-amber/40">Tie</span>
                )}
                {poll.discord_url && (
                    <a
                        href={poll.discord_url} target="_blank" rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-xs text-neon-cyan hover:underline"
                    >
                        Discord <ExternalLink size={12} />
                    </a>
                )}
            </div>
            <p className="text-sm text-primary mt-1 break-words">{poll.question}</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted">
                <dt className="text-faint">Opens</dt><dd>{opens ?? 'From the poll defaults when it is next in line'}</dd>
                <dt className="text-faint">Closes</dt><dd>{closes ?? '—'}</dd>
                {posted && (<><dt className="text-faint">Posted</dt><dd>{posted}</dd></>)}
                {poll.tie_rule && (<><dt className="text-faint">Tie-breaker</dt><dd>{TIE_RULE_LABEL[poll.tie_rule]}</dd></>)}
            </dl>

            {poll.beyond_bound && (
                <p className="text-xs text-neon-amber mt-2">
                    The season's table count is already reached, so this draft will not post. Raise the table count to use it.
                </p>
            )}

            {candidates.length === 0 ? (
                <p className="text-xs text-neon-magenta mt-2">No candidates yet — this poll cannot post until it has some.</p>
            ) : (
                <ul className="mt-3 space-y-1.5" aria-label={`Week ${poll.slot_no} candidates`}>
                    {candidates.map(c => {
                        const winner = poll.result_game_name != null && c.game_name === poll.result_game_name;
                        const pct = maxVotes > 0 ? Math.round((c.votes / maxVotes) * 100) : 0;
                        return (
                            <li key={c.position} className="text-sm">
                                <div className="flex items-baseline gap-2">
                                    <span className="font-mono text-xs text-faint w-5 text-right flex-shrink-0">{c.position}</span>
                                    <span className={`min-w-0 flex-1 break-words ${winner ? 'text-neon-green font-medium' : 'text-primary'}`}>
                                        {c.game_name}
                                    </span>
                                    <span className="tabular-nums text-xs text-muted flex-shrink-0">
                                        {c.votes} vote{c.votes === 1 ? '' : 's'}
                                    </span>
                                </div>
                                <div className="ml-7 mt-0.5 h-1.5 rounded bg-raised overflow-hidden" aria-hidden="true">
                                    <div className={`h-full ${winner ? 'bg-neon-green' : 'bg-neon-cyan/60'}`} style={{ width: `${pct}%` }} />
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{poll.total_votes} vote{poll.total_votes === 1 ? '' : 's'} in total</span>
                {poll.result_game_name && (
                    <span>
                        Winner: <span className="text-neon-green break-words">{poll.result_game_name}</span>
                        {poll.result_queued_status && <span className="text-faint"> · {poll.result_queued_status.toLowerCase()}</span>}
                    </span>
                )}
                {poll.status === 'resolved' && !poll.result_game_name && !poll.tied && (
                    <span className="text-neon-magenta">No eligible winner — the rotation will hold until a table is activated.</span>
                )}
            </div>

            {poll.tied && poll.tied_positions.length > 0 && (
                <div className="mt-3 rounded border border-neon-amber/40 bg-neon-amber/5 p-2">
                    <p className="text-xs text-neon-amber">
                        Tie between {poll.tied_positions.map(nameAt).join(', ')}.
                        {!poll.result_game_name
                            ? ' No table queued — choose one. The rotation waits until you do.'
                            : poll.can_choose
                                ? ` You chose ${poll.result_game_name}; you can switch to another tied table until it starts.`
                                : ` You chose ${poll.result_game_name}; it has started, so it can no longer be changed.`}
                    </p>
                    {poll.can_choose && (
                        <div className="flex flex-wrap gap-2 mt-2">
                            {poll.tied_positions.map(pos => {
                                const current = nameAt(pos) === poll.result_game_name;
                                return (
                                    <NeonButton
                                        key={pos} variant={current ? 'secondary' : 'primary'} className={smallBtn}
                                        disabled={current || isBusy('choose')}
                                        onClick={() => onChoose(poll, pos)}
                                    >
                                        {current ? `${nameAt(pos)} (queued)` : `Play ${nameAt(pos)}`}
                                    </NeonButton>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {poll.voters.length > 0 && (
                <div className="mt-2">
                    <button
                        type="button" onClick={() => setShowVoters(v => !v)} aria-expanded={showVoters}
                        className="text-xs text-neon-cyan hover:underline cursor-pointer min-h-9"
                    >
                        {showVoters ? 'Hide voters' : `Show voters (${poll.voters.length})`}
                    </button>
                    {showVoters && (
                        <ul className="mt-1 divide-y divide-border/30 text-xs" aria-label={`Week ${poll.slot_no} voters`}>
                            {poll.voters.map(v => (
                                <li key={v.user_id} className="flex flex-wrap items-baseline gap-x-2 py-1">
                                    <span className="text-primary break-words">{v.display_name || v.user_id}</span>
                                    <span className="text-muted break-words">→ {nameAt(v.position)}</span>
                                    <span className="ml-auto text-faint">{v.source === 'discord' ? 'Discord' : 'Web'}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
                {poll.status === 'draft' && (
                    <>
                        <NeonButton variant="ghost" className={smallBtn} onClick={onEdit}>Edit</NeonButton>
                        <NeonButton
                            variant="ghost" className={smallBtn} aria-label={`Move week ${poll.slot_no} up`}
                            disabled={!prev || prev.status !== 'draft' || isBusy('reorder')}
                            onClick={() => prev && onReorder(poll, prev)}
                        ><ChevronUp size={14} /></NeonButton>
                        <NeonButton
                            variant="ghost" className={smallBtn} aria-label={`Move week ${poll.slot_no} down`}
                            disabled={!next || next.status !== 'draft' || isBusy('reorder')}
                            onClick={() => next && onReorder(poll, next)}
                        ><ChevronDown size={14} /></NeonButton>
                        <NeonButton
                            variant="danger" className={smallBtn} disabled={isBusy('cancel')}
                            onClick={() => onAction(poll, 'cancel', 'Draft cancelled', `Cancel the week ${poll.slot_no} draft?`)}
                        >Cancel</NeonButton>
                    </>
                )}
                {poll.status === 'open' && (
                    <>
                        <NeonButton variant="ghost" className={smallBtn} onClick={onEdit}>Change close time</NeonButton>
                        <NeonButton
                            className={smallBtn} disabled={isBusy('close')}
                            onClick={() => onAction(poll, 'close', 'Poll closed', `Close the week ${poll.slot_no} poll now and queue its winner?`)}
                        >Close now</NeonButton>
                        <NeonButton
                            variant="ghost" className={smallBtn} disabled={isBusy('repost')}
                            onClick={() => onAction(poll, 'repost', 'Cancelled — a new draft is ready to edit', `Cancel this poll and start a new draft in its place? Votes so far are discarded.`)}
                        >Cancel and repost</NeonButton>
                        <NeonButton
                            variant="danger" className={smallBtn} disabled={isBusy('cancel')}
                            onClick={() => onAction(poll, 'cancel', 'Poll cancelled', `Cancel the week ${poll.slot_no} poll? It is expired on Discord and nothing is queued.`)}
                        >Cancel</NeonButton>
                    </>
                )}
                {poll.status === 'cancelled' && (
                    <NeonButton
                        variant="ghost" className={smallBtn} disabled={isBusy('repost')}
                        onClick={() => onAction(poll, 'repost', 'A new draft is ready to edit')}
                    >Repost as a new draft</NeonButton>
                )}
            </div>
        </li>
    );
}
