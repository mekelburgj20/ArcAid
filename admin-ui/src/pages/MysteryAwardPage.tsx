import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LogIn, ArrowLeft } from 'lucide-react';
import MysteryAward from '../components/MysteryAward';
import NeonButton from '../components/NeonButton';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { useToast } from '../components/Toast';

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
}

interface AvailabilityData {
    tournament: TournamentInfo;
    games: GameAvailabilityEntry[];
}

export default function MysteryAwardPage() {
    const { slug } = useParams<{ slug: string }>();
    const navigate = useNavigate();
    const { toast } = useToast();
    const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
    const { loading: gateLoading, enabled: gateEnabled } = usePickAwardEnabled(slug);

    const [roomId, setRoomId] = useState<string | null>(null);
    const [roomName, setRoomName] = useState<string>('');
    const [roomLogo, setRoomLogo] = useState<string>('');
    const [availableGames, setAvailableGames] = useState<string[]>([]);
    const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!slug) return;
        fetch('/api/rooms')
            .then(r => r.ok ? r.json() : [])
            .then((rooms: Array<{ id: string; slug: string; name: string; logo_url: string | null }>) => {
                const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
                if (!found) return;
                setRoomId(found.id);
                setRoomName(found.name);
                if (found.logo_url) setRoomLogo(found.logo_url);
            })
            .catch(() => {});
    }, [slug]);

    useEffect(() => {
        if (!roomId) return;
        fetch(`/api/rooms/${roomId}/tournaments`)
            .then(r => r.ok ? r.json() : [])
            .then((ts: Array<{ id: string; is_active: boolean }>) => {
                const active = ts.find(t => t.is_active);
                if (active) setSelectedTournamentId(active.id);
            })
            .catch(() => {});
    }, [roomId]);

    useEffect(() => {
        if (!roomId || !selectedTournamentId) return;
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
            {/* Header overlay — back link + login CTA for anon viewers */}
            <div className="absolute top-0 left-0 right-0 z-10 px-4 py-3 flex items-center justify-between pointer-events-none">
                <Link
                    to={`/${slug}`}
                    className="pointer-events-auto inline-flex items-center gap-1 text-xs text-muted hover:text-neon-cyan no-underline"
                >
                    <ArrowLeft size={12} /> {roomName || slug}
                </Link>
                {!discordUser && (
                    <NeonButton
                        onClick={() => loginWithDiscord(slug)}
                        className="pointer-events-auto inline-flex items-center gap-1 text-xs px-3 py-1.5"
                    >
                        <LogIn size={12} /> Log in to queue
                    </NeonButton>
                )}
            </div>

            <MysteryAward
                availableGames={availableGames}
                onClose={() => navigate(`/${slug}`)}
                roomName={roomName}
                backglassUrl={roomLogo || undefined}
                onPickGame={discordUser ? handlePick : undefined}
            />
        </div>
    );
}
