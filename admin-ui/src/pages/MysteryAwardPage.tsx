import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LogIn, ArrowLeft } from 'lucide-react';
import MysteryAward from '../components/MysteryAward';
import NeonButton from '../components/NeonButton';
import TournamentPoolTopper from '../components/TournamentPoolTopper';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { useToast } from '../components/Toast';
import { getPortal } from '../lib/portal';

/**
 * Standalone Mystery Award page (v2.0.1) — shareable URL for Discord.
 *
 * Mounts the existing MysteryAward modal full-screen; fetches the room context
 * once so available-games list is populated. Logged-in players can add the
 * picked game to their queue; anonymous viewers get a Log-in CTA.
 *
 * When ENABLE_GAME_PICK_AWARD is OFF for the room, redirects to the scoreboard.
 */

interface GameAvailabilityEntry {
    name: string;
    available: boolean;
}

interface TournamentInfo {
    id: string;
    name?: string;
    type?: string;
    is_active?: boolean;
}

interface AvailabilityData {
    tournament: TournamentInfo;
    games: GameAvailabilityEntry[];
}

export default function MysteryAwardPage() {
    const { slug } = useParams<{ slug: string }>();
    const navigate = useNavigate();
    const { toast } = useToast();
    const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
    const { loading: gateLoading, enabled: gateEnabled } = usePickAwardEnabled(slug);

    const [roomId, setRoomId] = useState<string | null>(null);
    const [roomName, setRoomName] = useState<string>('');
    const [roomLogo, setRoomLogo] = useState<string>('');
    const [availableGames, setAvailableGames] = useState<string[]>([]);
    // v2.2.6 — full tournament list so the user can switch pools.
    const [tournaments, setTournaments] = useState<TournamentInfo[]>([]);
    const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    // S18 — reads the already-cached portal (PublicLayout resolved it for the
    // same slug) via getPortal instead of fetching the full rooms list.
    useEffect(() => {
        if (!slug) return;
        getPortal(slug)
            .then(portal => {
                setRoomId(portal.roomId);
                setRoomName(portal.name);
                if (portal.logo_url) setRoomLogo(portal.logo_url);
            })
            .catch(() => {});
    }, [slug]);

    useEffect(() => {
        if (!roomId) return;
        fetch(`/api/rooms/${roomId}/tournaments`)
            .then(r => r.ok ? r.json() : [])
            .then((ts: Array<{ id: string; name: string; type: string; is_active: boolean }>) => {
                // v2.2.6 — keep every active tournament so the user can pick
                // the pool. Default to the first active one on initial load.
                const actives = ts.filter(t => t.is_active);
                setTournaments(actives);
                if (actives.length > 0 && !selectedTournamentId) {
                    setSelectedTournamentId(actives[0].id);
                }
            })
            .catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomId]);

    useEffect(() => {
        if (!roomId || !selectedTournamentId) return;
        setReady(false);
        setAvailableGames([]);
        fetch(`/api/rooms/${roomId}/game-availability/${selectedTournamentId}`)
            .then(r => r.ok ? r.json() : null)
            .then((data: AvailabilityData | null) => {
                if (!data) return;
                setAvailableGames(data.games.filter(g => g.available).map(g => g.name));
                setReady(true);
            })
            .catch(() => setReady(true));
    }, [roomId, selectedTournamentId]);

    const handlePick = useCallback(async (gameName: string) => {
        if (!roomId || !playerToken || !selectedTournamentId) return;
        try {
            const res = await fetch(`/api/rooms/${roomId}/pick-game`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
                body: JSON.stringify({ tournamentId: selectedTournamentId, gameName }),
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Pick failed');
            if (result.status === 'activated') {
                toast(`${result.gameName} is now active!`, 'success');
            } else {
                toast(`${result.gameName} queued for you`, 'success');
            }
        } catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to queue game', 'error');
        }
    }, [roomId, playerToken, selectedTournamentId, toast]);

    // Defense-in-depth: if the room has the pick flow off, bounce to the scoreboard.
    if (!gateLoading && !gateEnabled && slug) {
        navigate(`/${slug}`, { replace: true });
        return null;
    }

    if (gateLoading || !slug || !ready) {
        return (
            <div className="min-h-screen bg-deep flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
            </div>
        );
    }

    if (availableGames.length < 2) {
        return (
            <div className="min-h-screen bg-deep flex items-center justify-center px-4">
                <div className="bg-surface border border-border rounded-lg p-6 max-w-md w-full text-center">
                    <h1 className="font-display text-lg text-primary mb-2">Not enough available games</h1>
                    <p className="text-xs text-muted mb-4">Mystery Award needs at least 2 available tables to spin. Check back after the next rotation.</p>
                    <Link to={`/${slug}/picks`} className="text-neon-cyan text-xs hover:underline">← Back to Picks</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="relative min-h-screen bg-deep">
            {/* Header — back link (left) + login CTA (right). The tournament
                pool selector is now rendered as a "cabinet topper" inside
                the MysteryAward component instead of in this top nav row. */}
            <div className="fixed top-0 left-0 right-0 z-[60] px-4 py-3 flex items-center justify-between gap-2 pointer-events-none">
                <Link
                    to={`/${slug}`}
                    className="pointer-events-auto inline-flex items-center gap-1 text-xs text-muted hover:text-neon-cyan no-underline"
                >
                    <ArrowLeft size={12} /> <span className="truncate max-w-[140px] sm:max-w-none">{roomName || slug}</span>
                </Link>

                {!discordUser && (
                    <div className="flex items-center gap-1.5">
                        <NeonButton
                            onClick={() => loginWithDiscord(slug)}
                            className="pointer-events-auto inline-flex items-center gap-1 text-xs px-3 py-1.5"
                        >
                            <LogIn size={12} /> <span className="hidden sm:inline">Log in to queue</span>
                        </NeonButton>
                        <button
                            type="button"
                            onClick={() => loginWithGoogle(slug)}
                            className="pointer-events-auto inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-border bg-surface text-primary hover:bg-raised transition-colors cursor-pointer"
                        >
                            <LogIn size={12} /> <span className="hidden sm:inline">Google</span>
                        </button>
                    </div>
                )}
            </div>

            <MysteryAward
                availableGames={availableGames}
                onClose={() => navigate(`/${slug}`)}
                roomName={roomName}
                backglassUrl={roomLogo || undefined}
                onPickGame={discordUser ? handlePick : undefined}
                topper={tournaments.length > 1 ? (
                    <TournamentPoolTopper
                        tournaments={tournaments}
                        selectedId={selectedTournamentId}
                        onChange={setSelectedTournamentId}
                    />
                ) : undefined}
            />
        </div>
    );
}
