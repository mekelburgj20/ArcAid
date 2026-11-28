import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, UserPlus, Users } from 'lucide-react';
import Button from './parts/Button';
import { ConfirmDialog } from './parts/Dialog';

/**
 * W131.3 (ADR 0045, docs/shared-device-plan.md §3, §4, §7) - the people on one
 * Witness device, under that device on Account Settings.
 *
 * - **Playing as** (a shared device only): who the device's plays go to now.
 *   Anyone on the device may switch it, to anyone on it.
 * - **People on this device**: owners marked, "you" marked. An owner adds a
 *   player by a single-use invite link, removes a player, makes a player an
 *   owner and picks who plays when nobody chose. Anyone may leave; an owner
 *   steps down. The rules are the server's (`WitnessDevicePlayersService`);
 *   a refusal's own words are shown.
 *
 * A second person waits for a Witness build that reports its clock
 * (`householdReady`, ruling 5), so Add a player says to update first.
 */

export type PeopleDevice = {
    atgamesUniqueId: string;
    deviceType?: 'atgames' | 'desktop';
    /** Absent on an older server: treated as an owner, as before W131.1. */
    role?: 'owner' | 'player';
    playerCount?: number;
    playingAs?: { userId: string; label: string | null; isDefault: boolean; isYou: boolean } | null;
    householdReady?: boolean;
};

type Person = {
    userId: string;
    label: string | null;
    role: 'owner' | 'player';
    addedAt: string;
    pairedDevice: boolean;
    isYou: boolean;
};

type Confirm =
    | { kind: 'leave' }
    | { kind: 'remove'; person: Person }
    | { kind: 'step-down' };

const nameOf = (p: { label: string | null }) => p.label || 'A player';

export default function WitnessDevicePeople({ device, playerToken, onChanged }: {
    device: PeopleDevice;
    playerToken: string | null;
    onChanged: () => void;
}) {
    const id = device.atgamesUniqueId;
    const isOwner = device.role !== 'player';
    const shared = (device.playerCount ?? 1) > 1;
    const what = device.deviceType === 'desktop' ? 'PC' : 'cabinet';

    const [open, setOpen] = useState(false);
    const [people, setPeople] = useState<Person[] | null>(null);
    const [defaultPlayerId, setDefaultPlayerId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirm, setConfirm] = useState<Confirm | null>(null);

    const auth = playerToken ? { Authorization: `Bearer ${playerToken}` } : undefined;
    const base = `/api/me/witness/devices/${encodeURIComponent(id)}`;

    /** The people and the default player, or null when they could not be read. Sets no state itself. */
    const fetchPeople = useCallback(async (): Promise<{ players: Person[]; defaultPlayerId: string | null } | null> => {
        if (!playerToken) return null;
        try {
            const res = await fetch(`${base}/players`, { headers: { Authorization: `Bearer ${playerToken}` } });
            if (!res.ok) return null;
            const body = await res.json();
            if (!Array.isArray(body.players)) return null;
            return { players: body.players, defaultPlayerId: typeof body.defaultPlayerId === 'string' ? body.defaultPlayerId : null };
        } catch {
            return null;
        }
    }, [base, playerToken]);

    /** A failed read keeps the list as it was; the next open or write reads it again. */
    const apply = useCallback((found: { players: Person[]; defaultPlayerId: string | null } | null) => {
        if (!found) return;
        setPeople(found.players);
        setDefaultPlayerId(found.defaultPlayerId);
    }, []);

    const loadPeople = async () => apply(await fetchPeople());

    // The Playing as choices need the names, so a shared device reads them at once.
    useEffect(() => {
        if (!shared && !open) return;
        let live = true;
        void fetchPeople().then(found => { if (live) apply(found); });
        return () => { live = false; };
    }, [shared, open, fetchPeople, apply]);

    /** One write; on success reload the people and the device list. */
    const act = async (path: string, init: RequestInit, after?: () => void): Promise<boolean> => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`${base}${path}`, {
                ...init,
                headers: { ...auth, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body.error || 'That did not work. Try again.'); return false; }
            after?.();
            await loadPeople();
            onChanged();
            return true;
        } catch {
            setError('That did not work. Try again.');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const switchTo = (userId: string) =>
        void act('/session', { method: 'POST', body: JSON.stringify({ userId }) });

    const makeInvite = async () => {
        setBusy(true); setError(null); setCopied(false);
        try {
            const res = await fetch(`${base}/invites`, { method: 'POST', headers: auth });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body.error || 'Could not make an invite link.'); return; }
            setInvite({ url: `${window.location.origin}${body.path}`, expiresAt: body.expiresAt });
        } catch {
            setError('Could not make an invite link.');
        } finally {
            setBusy(false);
        }
    };

    const copyInvite = async () => {
        if (!invite) return;
        try { await navigator.clipboard.writeText(invite.url); setCopied(true); } catch { /* the link is on screen to copy by hand */ }
    };

    const me = people?.find(p => p.isYou) ?? null;
    const owners = people?.filter(p => p.role === 'owner').length ?? 0;
    const playing = device.playingAs;

    const runConfirm = async () => {
        if (!confirm) return;
        if (confirm.kind === 'remove') {
            await act(`/players/${encodeURIComponent(confirm.person.userId)}`, { method: 'DELETE' });
        } else if (confirm.kind === 'leave' && me) {
            await act(`/players/${encodeURIComponent(me.userId)}`, { method: 'DELETE' });
        } else if (confirm.kind === 'step-down' && me) {
            await act(`/players/${encodeURIComponent(me.userId)}`, { method: 'PATCH', body: JSON.stringify({ role: 'player' }) });
        }
        setConfirm(null);
    };

    return (
        <div className="mt-2" data-testid={`witness-people-${id}`}>
            {shared && playing && (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">Playing as</span>
                    <select
                        aria-label="Playing as"
                        value={playing.userId}
                        disabled={busy || !people}
                        onChange={e => switchTo(e.target.value)}
                        className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary cursor-pointer"
                    >
                        {(people ?? [{ userId: playing.userId, label: playing.label, isYou: playing.isYou } as Person]).map(p => (
                            <option key={p.userId} value={p.userId}>{nameOf(p)}{p.isYou ? ' (you)' : ''}</option>
                        ))}
                    </select>
                    {!playing.isYou && (
                        <Button variant="secondary" size="xs" disabled={busy || !me} onClick={() => me && switchTo(me.userId)}>
                            I'm playing
                        </Button>
                    )}
                </div>
            )}
            {shared && playing && (
                <p className="mt-1 text-xs text-faint">
                    {playing.isDefault
                        ? `Nobody has chosen, so plays on this ${what} go to ${nameOf(playing)}. `
                        : `Plays on this ${what} go to ${playing.isYou ? 'you' : nameOf(playing)} until someone switches. `}
                    Switch before you start a game; a game already under way stays with whoever was playing when it began.
                </p>
            )}

            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-primary cursor-pointer"
            >
                <Users size={12} aria-hidden="true" />
                {open ? 'Hide people on this device' : `People on this device (${device.playerCount ?? 1})`}
            </button>

            {open && (
                <div className="mt-2 space-y-2" data-testid={`witness-people-list-${id}`}>
                    {!people && <p className="text-xs text-muted">Loading…</p>}
                    {people && (
                        <ul className="divide-y divide-border border border-border rounded">
                            {people.map(p => (
                                <li key={p.userId} className="px-3 py-2 flex flex-wrap items-center gap-2">
                                    <span className="text-sm text-primary">{nameOf(p)}</span>
                                    {p.isYou && <span className="text-xs text-faint">(you)</span>}
                                    {p.role === 'owner' && (
                                        <span className="px-1.5 py-px rounded text-xs border border-neon-cyan/40 text-neon-cyan">Owner</span>
                                    )}
                                    {shared && defaultPlayerId === p.userId && (
                                        <span className="text-xs text-faint">plays when nobody chose</span>
                                    )}
                                    <span className="ml-auto flex flex-wrap gap-1.5">
                                        {isOwner && !p.isYou && p.role === 'player' && (
                                            <>
                                                <Button
                                                    variant="secondary" size="xs" disabled={busy}
                                                    onClick={() => void act(`/players/${encodeURIComponent(p.userId)}`, { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) })}
                                                >
                                                    Make owner
                                                </Button>
                                                <Button variant="danger" size="xs" disabled={busy} onClick={() => setConfirm({ kind: 'remove', person: p })}>
                                                    Remove
                                                </Button>
                                            </>
                                        )}
                                        {p.isYou && p.role === 'owner' && owners > 1 && (
                                            <Button variant="secondary" size="xs" disabled={busy} onClick={() => setConfirm({ kind: 'step-down' })}>
                                                Step down
                                            </Button>
                                        )}
                                        {p.isYou && (p.role === 'player' || owners > 1) && (
                                            <Button variant="danger" size="xs" disabled={busy} onClick={() => setConfirm({ kind: 'leave' })}>
                                                Leave
                                            </Button>
                                        )}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {isOwner && shared && people && (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted">When nobody chose, plays go to</span>
                            <select
                                aria-label="When nobody chose, plays go to"
                                value={defaultPlayerId ?? ''}
                                disabled={busy}
                                onChange={e => void act('/default-player', { method: 'PATCH', body: JSON.stringify({ userId: e.target.value }) })}
                                className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary cursor-pointer"
                            >
                                {people.map(p => (
                                    <option key={p.userId} value={p.userId}>{nameOf(p)}{p.isYou ? ' (you)' : ''}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {isOwner && (
                        device.householdReady === false ? (
                            <p className="text-xs text-muted" data-testid="witness-people-not-ready">
                                To add a player, update Arcaid Witness on this {what} first: sharing a {what} needs a
                                build that reports its clock, so each game goes to whoever was playing when it started.
                            </p>
                        ) : (
                            <div>
                                <Button variant="secondary" size="xs" disabled={busy} onClick={() => void makeInvite()}>
                                    <UserPlus size={12} aria-hidden="true" /> Add a player
                                </Button>
                                {invite && (
                                    <div className="mt-2 text-xs" data-testid="witness-invite-link">
                                        <p className="text-muted mb-1">
                                            Send this link to the player. It works once, for 7 days. Everyone on this {what} sees
                                            every play on it.
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <code className="font-mono break-all text-primary bg-raised border border-border rounded px-2 py-1 min-w-0">{invite.url}</code>
                                            <Button variant="secondary" size="xs" onClick={() => void copyInvite()} className="shrink-0">
                                                {copied ? <><Check size={12} aria-hidden="true" /> Copied</> : <><Copy size={12} aria-hidden="true" /> Copy</>}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    )}
                </div>
            )}

            {error && <p className="mt-1 text-xs ink-danger" role="alert">{error}</p>}

            <ConfirmDialog
                open={confirm !== null}
                onCancel={() => setConfirm(null)}
                onConfirm={() => void runConfirm()}
                busy={busy}
                title={
                    confirm?.kind === 'remove' ? `Remove ${nameOf(confirm.person)}?`
                    : confirm?.kind === 'step-down' ? 'Step down as owner?'
                    : `Leave this ${what}?`
                }
                message={
                    confirm?.kind === 'remove' ? `Their plays so far stay theirs. New plays on this ${what} stop going to them.`
                    : confirm?.kind === 'step-down' ? `You stay on this ${what} as a player. Another owner can make you an owner again.`
                    : `Your plays so far stay yours. To come back you need a new invite link from an owner.`
                }
                confirmLabel={confirm?.kind === 'remove' ? 'Remove' : confirm?.kind === 'step-down' ? 'Step down' : 'Leave'}
                tone={confirm?.kind === 'step-down' ? 'pink' : 'red'}
            />
        </div>
    );
}
