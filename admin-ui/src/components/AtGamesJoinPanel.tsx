import { useState } from 'react';
import { playerApi } from '../lib/playerApi';

/**
 * "Join on AtGames" for an event linked to an AtGames private tournament
 * (v2.232.0, A33).
 *
 * Joining has to be done as the player's own AtGames account, so the player
 * signs in with their AtGames email and password. Arcaid uses them for this one
 * request and forgets them (owner 2026-11-08: ask every time, store nothing).
 * The invitation code is filled in by the server. Joining also links the
 * account, so the player's cabinet scores carry their name.
 *
 * `AtGamesJoinForm` is the sign-in form alone; the event page wraps it in this
 * panel and the scoreboard card in a dialog (v2.234.0, A36).
 */

/** The joined message, or null while not yet joined. */
export function AtGamesJoinForm({ roomId, eventId, playerToken, onJoined, onCancel }: {
    roomId: string;
    eventId: string;
    playerToken: string | null;
    onJoined: (message: string) => void;
    onCancel: () => void;
}) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const join = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await playerApi.post<{ tournamentName: string; linkConflict: boolean }>(
                `/rooms/${roomId}/events/${eventId}/atgames-join`, { email, password }, { token: playerToken },
            );
            onJoined(res.linkConflict
                ? `You joined ${res.tournamentName}. That AtGames account is linked to a different Arcaid player, so your scores will show under that player.`
                : `You joined ${res.tournamentName}. Play on your cabinet; your score posts when you exit the table.`);
        } catch (err) {
            setError((err as Error)?.message || 'Could not join on AtGames.');
        } finally {
            // The password never outlives the attempt, success or not.
            setPassword('');
            setBusy(false);
        }
    };

    return (
        <form
            className="grid gap-3"
            onSubmit={e => { e.preventDefault(); if (email && password && !busy) void join(); }}
        >
            <p className="text-xs text-faint">
                Sign in with your AtGames account. Arcaid uses it once to join you and does not keep your password.
            </p>
            <label className="text-xs text-muted grid gap-1">
                AtGames email
                <input
                    type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
                    className="px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan"
                />
            </label>
            <label className="text-xs text-muted grid gap-1">
                AtGames password
                <input
                    type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
                    className="px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan"
                />
            </label>
            {error && <p className="text-xs text-neon-magenta">{error}</p>}
            <div className="flex gap-2">
                <button
                    type="submit" disabled={!email || !password || busy}
                    className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors disabled:opacity-50"
                >{busy ? 'Joining…' : 'Join tournament'}</button>
                <button
                    type="button" onClick={() => { setPassword(''); setError(''); onCancel(); }}
                    className="px-4 py-2 rounded border border-border bg-raised text-primary text-sm"
                >Cancel</button>
            </div>
        </form>
    );
}

interface Props {
    roomId: string;
    eventId: string;
    playerToken: string | null;
    /** Null when the viewer is signed out (the server withholds it). */
    code: string | null;
    signedIn: boolean;
    onLogin: () => void;
}

export default function AtGamesJoinPanel({ roomId, eventId, playerToken, code, signedIn, onLogin }: Props) {
    const [open, setOpen] = useState(false);
    const [done, setDone] = useState<string | null>(null);

    return (
        <section className="mb-6 p-4 rounded border border-border bg-surface" data-testid="atgames-join">
            <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-0">
                    <p className="text-sm text-primary">Playing on an AtGames cabinet?</p>
                    <p className="text-xs text-faint mt-0.5">
                        Join this event's AtGames tournament and your cabinet scores come in on their own.
                        {code && <> Or join on the cabinet with code <span className="font-mono font-bold text-neon-cyan">{code}</span>.</>}
                    </p>
                </div>
                <div className="ml-auto">
                    {done ? null : signedIn ? (
                        !open && (
                            <button
                                type="button" onClick={() => setOpen(true)}
                                className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors"
                            >Join on AtGames</button>
                        )
                    ) : (
                        <button
                            type="button" onClick={onLogin}
                            className="px-4 py-2 rounded border border-border bg-raised text-primary text-sm hover:border-neon-cyan transition-colors"
                        >Log in to join</button>
                    )}
                </div>
            </div>

            {done && <p className="text-sm text-neon-green mt-3">{done}</p>}

            {open && !done && (
                <div className="mt-4 pt-3 border-t border-border/40 sm:max-w-sm">
                    <AtGamesJoinForm
                        roomId={roomId} eventId={eventId} playerToken={playerToken}
                        onJoined={msg => { setDone(msg); setOpen(false); }}
                        onCancel={() => setOpen(false)}
                    />
                </div>
            )}
        </section>
    );
}
