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
    tournament: Tournament;
    onClose: () => void;
    onChanged: () => void;
    toast: (message: string, kind?: 'success' | 'error') => void;
}

export default function EventRoundsPanel({ roomId, tournament, onClose, onChanged, toast }: EventRoundsPanelProps) {
    const [rounds, setRounds] = useState<EventRoundRow[]>(tournament.rounds ?? []);
    const [participants, setParticipants] = useState<ParticipantRow[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [addUserId, setAddUserId] = useState('');
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const [list, people] = await Promise.all([
                api.get<Tournament[]>(`/rooms/${roomId}/tournaments`),
                api.get<ParticipantRow[]>(`/rooms/${roomId}/events/${tournament.id}/participants`),
            ]);
            setRounds(list.find(t => t.id === tournament.id)?.rounds ?? []);
            setParticipants(people);
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
            </div>
        </div>
    );
}
