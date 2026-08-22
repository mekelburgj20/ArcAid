import { useEffect, useMemo, useRef, useState } from 'react';
import { Flame, TrendingUp, Target, Trophy, Gamepad2, Star, Users, Crown, Hourglass } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { relativeTimeFrom } from '../lib/format';

interface TickerFeedEvent {
  id: number;
  type: string;
  title: string;
  target_user_id?: string | null;
  created_at: string;
}

// S14 — kept intentionally distinct from KioskScoreboard's TICKER_ICONS map
// (same icon set, extended with streak_extended + staleness_challenge).
const TICKER_ICONS: Record<string, typeof Flame> = {
  new_high_score: Flame,
  rank_change: TrendingUp,
  score_posted: Target,
  tournament_results: Trophy,
  tournament_active: Gamepad2,
  player_milestone: Star,
  friend_score: Users,
  streak_extended: Flame,
  staleness_challenge: Crown,
  // The ticker shows the static title only — never the live countdown. A
  // marquee that scrolls past once is the wrong surface for a ticking number,
  // and the title alone ("<player>, pick the next game for <tournament>")
  // stays true after the window closes.
  pick_prompt: Hourglass,
};

interface ScoreboardTickerProps {
  roomId: string;
}

/**
 * S14 — Fixed-bottom marquee of recent lobby feed activity for the public
 * Scoreboard page (all three tabs). Seeded from the lobby feed REST endpoint,
 * then kept live over the shared `lobby:<roomId>` socket channel (push model,
 * mirrors Lobby.tsx's seenIds-dedupe discipline) rather than KioskScoreboard's
 * poll-on-room-event approach.
 */
export default function ScoreboardTicker({ roomId }: ScoreboardTickerProps) {
  const [events, setEvents] = useState<TickerFeedEvent[]>([]);
  const seenIds = useRef(new Set<number>());

  // Seed from the lobby feed REST endpoint
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/lobby/feed?limit=15`)
      .then(r => r.ok ? r.json() : [])
      .then((data: TickerFeedEvent[]) => {
        if (cancelled) return;
        const filtered = (data || []).filter(e => !e.target_user_id);
        seenIds.current = new Set(filtered.map(e => e.id));
        setEvents(filtered);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  // Live updates over the shared lobby socket channel. The socket is a shared
  // singleton (see Lobby.tsx / v2.18 lesson) so handler refs are passed to
  // `off` — a bare `socket.off('lobby:event')` would also kill Lobby.tsx's
  // handler for the same event.
  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('join:lobby', roomId);

    const handler = (event: TickerFeedEvent) => {
      if (event.target_user_id) return;
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      setEvents(prev => [event, ...prev].slice(0, 15));
    };
    socket.on('lobby:event', handler);

    return () => {
      socket.emit('leave:lobby', roomId);
      socket.off('lobby:event', handler);
    };
  }, [roomId]);

  const tickerItems = useMemo(() => events.map(e => {
    const ago = relativeTimeFrom(e.created_at);
    return { id: e.id, title: e.title, ago, Icon: TICKER_ICONS[e.type] || Target };
  }), [events]);

  // s21 — distance-based marquee speed. The animation travels half the track
  // width (the doubled item set), so a fixed 60s duration crawled when the
  // feed had few items and raced when full. Constant px/s instead.
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const distance = track.scrollWidth / 2;
    const seconds = Math.min(90, Math.max(15, distance / 70));
    track.style.setProperty('--ticker-duration', `${seconds}s`);
  }, [tickerItems]);

  if (tickerItems.length === 0) return null;

  return (
    // s21 — in-flow bar (was fixed bottom-0, which painted over PublicLayout's
    // Privacy/Terms footer). PublicLayout mounts this above the footer; the
    // footer now owns the safe-area inset, so the s20 height-calc hack is gone.
    <div className="flex-shrink-0 h-9 bg-deep/90 border-t border-border/30 overflow-hidden">
      <div ref={trackRef} className="scoreboard-ticker-track flex items-center gap-10 whitespace-nowrap h-full px-4">
        {/* Double the items for a seamless loop */}
        {[...tickerItems, ...tickerItems].map((item, i) => {
          const Icon = item.Icon;
          return (
            <span key={`${item.id}-${i}`} className="inline-flex items-center gap-1.5 text-xs">
              <Icon size={12} className="text-neon-cyan flex-shrink-0" />
              <span className="text-primary/80">{item.title}</span>
              <span className="text-faint ml-1">{item.ago}</span>
            </span>
          );
        })}
      </div>
      <style>{`
        @keyframes scoreboard-ticker-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .scoreboard-ticker-track {
          animation: scoreboard-ticker-scroll var(--ticker-duration, 60s) linear infinite;
        }
        .scoreboard-ticker-track:hover {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .scoreboard-ticker-track {
            animation: none;
            overflow-x: auto;
          }
        }
      `}</style>
    </div>
  );
}
