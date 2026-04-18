import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import SubmissionSheet from '../components/SubmissionSheet';

/**
 * Standalone score-submit page (e.g. the QR code target from scoreboard cards).
 *
 * Sprint 10 — rewritten as a thin wrapper over SubmissionSheet. Resolves the
 * room + game from the URL, then mounts SubmissionSheet in page context. All
 * anonymous-flow / cooldown / draft-handoff logic lives in SubmissionSheet.
 */
export default function ScoreSubmit() {
    const { slug, gameId } = useParams<{ slug: string; gameId: string }>();
    const navigate = useNavigate();

    const [roomId, setRoomId] = useState<string | null>(null);
    const [gameName, setGameName] = useState<string | null>(null);
    const [gameStatus, setGameStatus] = useState<string | undefined>(undefined);
    const [requirePhoto, setRequirePhoto] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!slug || !gameId) return;
        setError(null);
        let cancelled = false;
        (async () => {
            try {
                const portal = await fetch(`/api/portal?slug=${encodeURIComponent(slug)}`);
                if (!portal.ok) throw new Error('Room not found');
                const { id } = await portal.json();
                if (cancelled) return;
                setRoomId(id);

                const info = await fetch(`/api/rooms/${id}/games/${gameId}/info`);
                if (!info.ok) throw new Error('Game not found');
                const data = await info.json();
                if (cancelled) return;
                setGameName(data.name);
                setGameStatus(data.status);
                setRequirePhoto(!!data.requirePhoto);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load game');
            }
        })();
        return () => { cancelled = true; };
    }, [slug, gameId]);

    if (error) {
        return (
            <div className="min-h-screen bg-deep flex items-center justify-center px-4">
                <div className="bg-surface border border-border rounded-lg p-6 max-w-md w-full text-center">
                    <p className="text-neon-amber font-display text-sm mb-4">{error}</p>
                    <Link to={`/${slug}`} className="text-neon-cyan hover:underline text-sm">
                        Back to scoreboard
                    </Link>
                </div>
            </div>
        );
    }

    if (!roomId || !gameName) {
        return (
            <div className="min-h-screen bg-deep flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <SubmissionSheet
            target={{ kind: 'tournament', roomId, gameName, gameStatus, requirePhoto }}
            roomSlug={slug}
            onClose={() => navigate(`/${slug}`)}
            onSubmitted={() => navigate(`/${slug}`)}
        />
    );
}
