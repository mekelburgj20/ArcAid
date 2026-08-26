import { useCallback, useEffect, useState } from 'react';
import NeonButton from './NeonButton';
import { api } from '../lib/api';
import { roundStatusLabel, formatRelative } from '../lib/eventDisplay';
import type { EventRoundRow, Tournament } from '../lib/tournamentFormPayload';

/**
 * Run-an-event panel (v2.135.0, ADR 0017) — the host's control surface while a
 * Live Event is actually happening.
 *
 * Two jobs: see who is in, and override the clock when the room is not running
 * to schedule. Everything else about an event is configured in the tournament
 * form; this is the during-the-night view.
 *
 * Uses `api.*` deliberately: this panel is a ROOM-ADMIN surface reached from
 * /:slug/admin/tournaments, where the admin token is the right credential and
 * the admin client's 401 -> /:slug/login redirect is the right behaviour.
 * Player-facing surfaces must use `lib/playerApi.ts` instead.
 *
 * "Start now" / "End now" do NOT flip a status directly — they call the server,
 * which rewrites the round's schedule and drives one scheduler tick. That keeps
 * board creation, announcements, cache invalidation and the event-finished
 * transition on a single path, and keeps the round's window honest (every
 * score's elapsed time is measured from the stored start).
 */

/** One score's outcome from a sync (or a preview of one). */
interface SyncRow {
    atgamesAccount: number;
    userName: string;
    score: number;
    atIso: string | null;
    decision: 'ingested' | 'duplicate' | 'out_of_window' | 'unmatched_game' | 'bad_timestamp';
    roundNo: number | null;
    roundName: string | null;
    linkedUserId: string | null;
}

interface SyncResult {
    ingested: number;
    duplicates: number;
    outOfWindow: number;
    unmatchedGame: number;
    unlinkedAccounts: number;
    unmatchedGameIds: number[];
    dryRun: boolean;
    rows: SyncRow[];
}

interface AtGamesAccount {
    atgamesAccountId: number;
    userName: string;
    scoreCount: number;
    linkedUserId: string | null;
    linkedDisplayName: string | null;
}

interface MemberOption {
    userId: string;
    displayName: string;
}

/** Plain-English reason a score is or isn't on the board. */
const DECISION_LABEL: Record<SyncRow['decision'], string> = {
    ingested: 'counted',
    duplicate: 'already had it',
    out_of_window: 'outside the round window',
    unmatched_game: 'that game is not in this event',
    bad_timestamp: "AtGames sent a time we couldn't read",
};

interface ParticipantRow {
    user_id: string;
    checked_in_at: string;
    source: 'checkin' | 'qualifier' | 'admin';
    added_by: string | null;
    /** Resolved server-side at read time — null for an id with no profile yet. */
    display_name: string | null;
}

interface EventRoundsPanelProps {
    roomId: string;
    /** For the shareable public event URL. */
    roomSlug: string;
    tournament: Tournament;
    onClose: () => void;
    onChanged: () => void;
    toast: (message: string, kind?: 'success' | 'error') => void;
}

export default function EventRoundsPanel({ roomId, roomSlug, tournament, onClose, onChanged, toast }: EventRoundsPanelProps) {
    const [rounds, setRounds] = useState<EventRoundRow[]>(tournament.rounds ?? []);
    const [participants, setParticipants] = useState<ParticipantRow[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [addUserId, setAddUserId] = useState('');
    const [loading, setLoading] = useState(true);
    const [atgamesId, setAtgamesId] = useState(tournament.atgames_tournament_id ?? '');
    const [inviteCode, setInviteCode] = useState(tournament.atgames_invite_code ?? '');
    const [copied, setCopied] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [accounts, setAccounts] = useState<AtGamesAccount[]>([]);
    const [members, setMembers] = useState<MemberOption[]>([]);
    const [linkChoice, setLinkChoice] = useState<Record<number, string>>({});

    const refresh = useCallback(async () => {
        try {
            const [list, people, atgamesAccounts, roomMembers] = await Promise.all([
                api.get<Tournament[]>(`/rooms/${roomId}/tournaments`),
                api.get<ParticipantRow[]>(`/rooms/${roomId}/events/${tournament.id}/participants`),
                // Both are best-effort: a room with no AtGames scores yet is the
                // normal case, and neither should be able to break the panel.
                api.get<AtGamesAccount[]>(`/rooms/${roomId}/admin/tournaments/${tournament.id}/atgames-accounts`).catch(() => []),
                api.get<MemberOption[]>(`/rooms/${roomId}/members`).catch(() => []),
            ]);
            setRounds(list.find(t => t.id === tournament.id)?.rounds ?? []);
            setParticipants(people);
            setAccounts(atgamesAccounts ?? []);
            setMembers(roomMembers ?? []);
        } catch (err) {
            toast((err as Error)?.message || 'Could not load event details', 'error');
        } finally {
            setLoading(false);
        }
    }, [roomId, tournament.id, toast]);

    useEffect(() => { void refresh(); }, [refresh]);

    const runAction = async (roundNo: number, action: 'start-now' | 'end-now') => {
        setBusy(`${roundNo}-${action}`);
        try {
            const res = await api.post<{ rounds: EventRoundRow[] }>(
                `/rooms/${roomId}/events/${tournament.id}/rounds/${roundNo}/${action}`, {},
            );
            setRounds(res.rounds);
            toast(action === 'start-now' ? `Round ${roundNo} is live` : `Round ${roundNo} closed`, 'success');
            onChanged();
        } catch (err) {
            toast((err as Error)?.message || 'Action failed', 'error');
        } finally {
            setBusy(null);
        }
    };

    const addParticipant = async () => {
        const userId = addUserId.trim();
        if (!userId) return;
        setBusy('add');
        try {
            await api.post(`/rooms/${roomId}/events/${tournament.id}/participants`, { userId });
            setAddUserId('');
            await refresh();
            toast('Player added', 'success');
        } catch (err) {
            toast((err as Error)?.message || 'Could not add player', 'error');
        } finally {
            setBusy(null);
        }
    };

    const removeParticipant = async (userId: string) => {
        setBusy(`rm-${userId}`);
        try {
            await api.delete(`/rooms/${roomId}/events/${tournament.id}/participants/${encodeURIComponent(userId)}`);
            await refresh();
        } catch (err) {
            toast((err as Error)?.message || 'Could not remove player', 'error');
        } finally {
            setBusy(null);
        }
    };

    const runSync = async (dryRun: boolean) => {
        setBusy(dryRun ? 'preview' : 'sync');
        try {
            const result = await api.post<SyncResult>(
                `/rooms/${roomId}/admin/tournaments/${tournament.id}/atgames-sync`,
                { atgamesTournamentId: atgamesId.trim() || undefined, dryRun },
            );
            setSyncResult(result);
            if (!dryRun) {
                await refresh();
                onChanged();
                toast(`${result.ingested} score${result.ingested === 1 ? '' : 's'} pulled in`, 'success');
            }
        } catch (err) {
            toast((err as Error)?.message || 'AtGames sync failed', 'error');
        } finally {
            setBusy(null);
        }
    };

    const linkAccount = async (atgamesAccountId: number) => {
        const userId = linkChoice[atgamesAccountId];
        if (!userId) return;
        setBusy(`link-${atgamesAccountId}`);
        try {
            const res = await api.post<{ rowsAttributed: number }>(
                `/rooms/${roomId}/admin/tournaments/${tournament.id}/atgames-links`,
                { atgamesAccountId, userId },
            );
            await refresh();
            onChanged();
            toast(`Linked — ${res.rowsAttributed} score${res.rowsAttributed === 1 ? '' : 's'} now count for them`, 'success');
        } catch (err) {
            toast((err as Error)?.message || 'Could not link that account', 'error');
        } finally {
            setBusy(null);
        }
    };

    const unlinkAccount = async (atgamesAccountId: number) => {
        setBusy(`link-${atgamesAccountId}`);
        try {
            await api.delete(`/rooms/${roomId}/admin/tournaments/${tournament.id}/atgames-links/${atgamesAccountId}`);
            await refresh();
            onChanged();
        } catch (err) {
            toast((err as Error)?.message || 'Could not unlink that account', 'error');
        } finally {
            setBusy(null);
        }
    };

    const createOnAtGames = async () => {
        setBusy('atg-create');
        try {
            const res = await api.post<{ atgamesTournamentId: string; inviteCode: string | null }>(
                `/rooms/${roomId}/admin/tournaments/${tournament.id}/atgames-create`, {},
            );
            setAtgamesId(res.atgamesTournamentId);
            setInviteCode(res.inviteCode ?? '');
            onChanged();
            toast(res.inviteCode
                ? `Created on AtGames — players join with code ${res.inviteCode}`
                : 'Created on AtGames', 'success');
        } catch (err) {
            toast((err as Error)?.message || 'Could not create the AtGames tournament', 'error');
        } finally {
            setBusy(null);
        }
    };

    const eventUrl = `${window.location.origin}/${roomSlug}/events/${tournament.id}`;
    const copyEventUrl = async () => {
        try {
            await navigator.clipboard.writeText(eventUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            toast('Could not copy — the link is shown next to the button', 'error');
        }
    };

    // "Who is this?" options: room members PLUS this event's checked-in
    // players. A fresh test room has no members at all — the admin adds
    // themselves to the event by hand, plays, and then found an empty picker
    // and a greyed Link button (first live test, 2026-08-26). Participants are
    // already loaded for the check-in list above; the server accepts them too.
    const linkOptions = (() => {
        const byId = new Map<string, MemberOption>();
        for (const m of members) byId.set(m.userId, m);
        for (const p of participants) {
            if (!byId.has(p.user_id)) {
                byId.set(p.user_id, { userId: p.user_id, displayName: p.display_name || p.user_id });
            }
        }
        return [...byId.values()];
    })();

    const finished = !!tournament.event_finished_at;

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between mb-4 gap-4">
                    <div>
                        <h2 className="font-display text-lg font-bold">{tournament.name}</h2>
                        <p className="text-xs text-muted mt-0.5">
                            {finished
                                ? 'This event has finished — its standings are frozen.'
                                : 'Rounds open and close on their own. Use these only to override the clock.'}
                        </p>
                    </div>
                    <NeonButton variant="ghost" onClick={onClose} className="text-xs px-3 py-1">Close</NeonButton>
                </div>

                {/* The event page is where players check in and watch standings,
                    and nothing else in the product surfaces its URL — a host who
                    can't hand out the link has an event nobody can join
                    (2026-08-25). */}
                <div className="flex items-center gap-2 mb-4 p-2 rounded border border-border bg-raised flex-wrap">
                    <span className="text-xs font-display uppercase tracking-wider text-muted">Share</span>
                    <code className="text-xs text-primary font-mono truncate flex-1 min-w-[10rem]">{eventUrl}</code>
                    <NeonButton variant="ghost" className="text-xs px-2 py-1" onClick={copyEventUrl}>
                        {copied ? 'Copied!' : 'Copy link'}
                    </NeonButton>
                </div>

                <h3 className="font-display text-xs font-bold uppercase tracking-wider text-muted mb-2">Rounds</h3>
                <div className="space-y-2 mb-6">
                    {rounds.length === 0 && <p className="text-sm text-faint">No rounds configured.</p>}
                    {rounds.map(round => {
                        const live = round.status === 'ACTIVE';
                        const scheduled = round.status === 'SCHEDULED';
                        return (
                            <div key={round.id} className="flex items-center gap-3 p-3 rounded border border-border bg-raised flex-wrap">
                                <span className="text-xs font-display uppercase tracking-wider text-muted w-8">R{round.round_no}</span>
                                <span className="text-sm text-primary flex-1 min-w-[8rem]">{round.name}</span>
                                <span className={`text-xs px-2 py-0.5 rounded border ${
                                    live ? 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/40'
                                        : scheduled ? 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40'
                                            : 'bg-border/30 text-muted border-border'
                                }`}>{roundStatusLabel(round.status)}</span>
                                <span className="text-xs text-faint min-w-[6rem]">
                                    {live
                                        ? `ends ${formatRelative(round.scheduled_end_at)}`
                                        : scheduled
                                            ? `starts ${formatRelative(round.scheduled_start_at)}`
                                            : ''}
                                </span>
                                <div className="flex gap-2 ml-auto">
                                    {scheduled && (
                                        <NeonButton
                                            variant="ghost" className="text-xs px-2 py-1"
                                            disabled={busy === `${round.round_no}-start-now`}
                                            onClick={() => runAction(round.round_no, 'start-now')}
                                        >Start now</NeonButton>
                                    )}
                                    {live && (
                                        <NeonButton
                                            variant="secondary" className="text-xs px-2 py-1"
                                            disabled={busy === `${round.round_no}-end-now`}
                                            onClick={() => runAction(round.round_no, 'end-now')}
                                        >End now</NeonButton>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                <h3 className="font-display text-xs font-bold uppercase tracking-wider text-muted mb-2">
                    Checked in <span className="text-faint normal-case tracking-normal">({participants.length})</span>
                </h3>
                {tournament.checkin_required === 0 && (
                    <p className="text-xs text-faint mb-2">
                        This event does not require check-in — anyone in the room can post a score.
                    </p>
                )}
                <div className="space-y-1 mb-3">
                    {loading && <p className="text-sm text-faint">Loading…</p>}
                    {!loading && participants.length === 0 && <p className="text-sm text-faint">Nobody has checked in yet.</p>}
                    {participants.map(p => (
                        <div key={p.user_id} className="flex items-center gap-2 text-sm py-1">
                            {/* Name when we have one, id when we do not — an
                                unresolved id is still the only handle the admin
                                can act on, so it is never hidden entirely. */}
                            <span className="flex-1 truncate">
                                {p.display_name
                                    ? <span className="text-primary">{p.display_name}</span>
                                    : <span className="font-mono text-xs text-muted">{p.user_id}</span>}
                            </span>
                            {p.source === 'admin' && (
                                <span className="text-xs px-2 py-0.5 rounded bg-neon-amber/15 text-neon-amber border border-neon-amber/40">added</span>
                            )}
                            <button
                                type="button" onClick={() => removeParticipant(p.user_id)}
                                disabled={busy === `rm-${p.user_id}`}
                                className="px-2 py-0.5 text-xs rounded border border-border text-muted hover:text-neon-magenta hover:border-neon-magenta transition-colors"
                            >Remove</button>
                        </div>
                    ))}
                </div>

                <div className="flex gap-2 items-center">
                    <input
                        type="text" placeholder="Discord user ID" value={addUserId}
                        onChange={e => setAddUserId(e.target.value)}
                        className="flex-1 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors font-mono"
                    />
                    <NeonButton
                        variant="ghost" className="text-xs px-3 py-2"
                        disabled={!addUserId.trim() || busy === 'add'}
                        onClick={addParticipant}
                    >Add player</NeonButton>
                </div>
                <p className="text-xs text-faint mt-1.5">
                    Adding a player by hand works even after check-in has closed — that is what it is for.
                </p>

                {/* P7 — pull scores off an AtGames private tournament. Manual by
                    design for now: the host presses it, and pressing it twice is
                    harmless because the ingest drops duplicates. */}
                <h3 className="font-display text-xs font-bold uppercase tracking-wider text-muted mt-6 mb-2">AtGames scores</h3>
                <p className="text-xs text-faint mb-2">
                    Reads scores straight off an AtGames private tournament, so players on a cabinet
                    don't have to type anything in. Paste the number from the end of the tournament's
                    address on atgames.net. Preview first — it shows what would happen and changes nothing.
                </p>
                {inviteCode && (
                    <p className="text-xs text-neon-cyan mb-2">
                        Players join on their cabinet with invitation code <span className="font-mono font-bold">{inviteCode}</span>.
                    </p>
                )}
                <div className="flex gap-2 items-center flex-wrap">
                    {!atgamesId.trim() && (
                        <NeonButton
                            variant="secondary" className="text-xs px-3 py-2"
                            disabled={busy === 'atg-create'}
                            onClick={createOnAtGames}
                        >{busy === 'atg-create' ? 'Creating…' : 'Create on AtGames'}</NeonButton>
                    )}
                    <input
                        type="text" placeholder="AtGames tournament id or invite code" value={atgamesId}
                        onChange={e => setAtgamesId(e.target.value)}
                        className="flex-1 min-w-[10rem] px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors font-mono"
                    />
                    <NeonButton
                        variant="ghost" className="text-xs px-3 py-2"
                        disabled={!atgamesId.trim() || busy === 'preview'}
                        onClick={() => runSync(true)}
                    >Preview</NeonButton>
                    <NeonButton
                        variant="secondary" className="text-xs px-3 py-2"
                        disabled={!atgamesId.trim() || busy === 'sync'}
                        onClick={() => runSync(false)}
                    >Pull scores</NeonButton>
                </div>

                {syncResult && (
                    <div className="mt-3 p-3 rounded border border-border bg-raised">
                        <p className="text-sm text-primary mb-1">
                            {syncResult.dryRun ? 'Preview — nothing was saved. ' : ''}
                            {syncResult.ingested} counted, {syncResult.duplicates} already had,{' '}
                            {syncResult.outOfWindow} outside a round window, {syncResult.unmatchedGame} not in this event.
                        </p>
                        {syncResult.unlinkedAccounts > 0 && (
                            <p className="text-xs text-neon-amber mb-1">
                                {syncResult.unlinkedAccounts} score{syncResult.unlinkedAccounts === 1 ? '' : 's'} came
                                from an AtGames account nobody has claimed yet — say who they are below and their
                                scores will count for them.
                            </p>
                        )}
                        {syncResult.rows.length > 0 && (
                            <div className="mt-2 space-y-1 max-h-56 overflow-y-auto">
                                {syncResult.rows.map((row, i) => (
                                    <div key={`${row.atgamesAccount}-${i}`} className="flex items-baseline gap-2 text-xs flex-wrap">
                                        <span className="text-primary font-medium min-w-[6rem]">{row.userName}</span>
                                        <span className="text-muted font-mono">{row.score.toLocaleString()}</span>
                                        <span className="text-faint">
                                            {row.roundNo ? `R${row.roundNo} ${row.roundName ?? ''}` : '—'}
                                        </span>
                                        <span className={row.decision === 'ingested' ? 'text-neon-cyan ml-auto' : 'text-faint ml-auto'}>
                                            {DECISION_LABEL[row.decision]}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {accounts.length > 0 && (
                    <div className="mt-3">
                        <h3 className="font-display text-xs font-bold uppercase tracking-wider text-muted mb-1">Who is who</h3>
                        <p className="text-xs text-faint mb-2">
                            Arcaid never guesses which player an AtGames name belongs to — two similar handles
                            would end up owning each other's scores. Say who each one is once, and their past
                            and future scores in this event count for them.
                        </p>
                        <div className="space-y-2">
                            {accounts.map(acc => (
                                <div key={acc.atgamesAccountId} className="flex items-center gap-2 flex-wrap p-2 rounded border border-border bg-raised">
                                    <span className="text-sm text-primary flex-1 min-w-[7rem] truncate">
                                        {acc.userName}
                                        <span className="text-faint text-xs ml-2">
                                            {acc.scoreCount} score{acc.scoreCount === 1 ? '' : 's'}
                                        </span>
                                    </span>
                                    {acc.linkedUserId ? (
                                        <>
                                            <span className="text-xs px-2 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/40">
                                                {acc.linkedDisplayName || acc.linkedUserId}
                                            </span>
                                            <button
                                                type="button" onClick={() => unlinkAccount(acc.atgamesAccountId)}
                                                disabled={busy === `link-${acc.atgamesAccountId}`}
                                                className="px-2 py-0.5 text-xs rounded border border-border text-muted hover:text-neon-magenta hover:border-neon-magenta transition-colors"
                                            >Unlink</button>
                                        </>
                                    ) : (
                                        <>
                                            <select
                                                value={linkChoice[acc.atgamesAccountId] ?? ''}
                                                onChange={e => setLinkChoice(prev => ({ ...prev, [acc.atgamesAccountId]: e.target.value }))}
                                                className="px-2 py-1 bg-surface border border-border rounded text-primary text-xs focus:outline-none focus:border-neon-cyan"
                                            >
                                                <option value="">Who is this?</option>
                                                {linkOptions.map(m => (
                                                    <option key={m.userId} value={m.userId}>{m.displayName}</option>
                                                ))}
                                            </select>
                                            <NeonButton
                                                variant="ghost" className="text-xs px-2 py-1"
                                                disabled={!linkChoice[acc.atgamesAccountId] || busy === `link-${acc.atgamesAccountId}`}
                                                onClick={() => linkAccount(acc.atgamesAccountId)}
                                            >Link</NeonButton>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
