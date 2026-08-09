import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import { Flame, TrendingUp, Target, Trophy, Gamepad2, Star, Users, Hourglass } from 'lucide-react';
import ScoreboardSurface from '../components/scoreboard/ScoreboardSurface';
import { deriveCardProps, deriveScoreboardConfig } from '../lib/scoreboardConfig';
import { getSocket } from '../lib/websocket';
import { getPortal } from '../lib/portal';

/**
 * v2.90.0 — kiosk migration onto the shared `ScoreboardSurface` (the same
 * component the public Scoreboard and admin Leaderboard render through). Prior
 * to this the kiosk kept a near-verbatim hand clone of the whole card-grid
 * surface, including its own `<style>` block, which had already drifted from
 * the public page in several small ways (see the three surface props below).
 *
 * What stays HERE (page-level, kiosk-only chrome — not the surface's job):
 *   - Room/config resolution, the approval-room gate, the KIOSK_ENABLED gate.
 *   - Data fetching + polling (KIOSK_REFRESH_SECONDS) + the room socket join
 *     and its score:new / leaderboard:updated handlers.
 *   - The TV-scaled score toast (passed into the surface's `overlays` slot).
 *   - The lobby-feed ticker (icons, item list, distance-based scroll speed).
 *   - The attract-mode auto-scroll ping-pong over the horizontal card rail.
 *   - The scanline overlay.
 *
 * What the surface now owns (deleted from here): card rendering
 * (CardRouter/GameCard), rankings rendering, the title/logo header zone + its
 * own height measurement, the background-image layer, QR/layout/zoom
 * derivation, and the duplicated `<style>` block.
 */
export default function KioskScoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [configLoaded, setConfigLoaded] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [feedEvents, setFeedEvents] = useState<Array<{ id: number; type: string; title: string; created_at: string }>>([]);
  const [scoreToast, setScoreToast] = useState<{ player: string; score: number; game: string } | null>(null);
  // v2.39.0 (approval rooms) — kiosk has no login flow, so it can only ever
  // render the graceful gate message for an 'approval' room (see contract:
  // "NOT supported this release" — no KIOSK_KEY pairing mechanism yet).
  const [gated, setGated] = useState(false);

  // Resolve room and fetch scoreboard config
  useEffect(() => {
    if (!slug) return;
    getPortal(slug)
      .then(portal => {
        setRoomName(portal.name);
        setRoomId(portal.roomId);
        const isGated = portal.join_policy === 'approval'
          && (portal.viewer_status ?? 'none') !== 'admin' && (portal.viewer_status ?? 'none') !== 'member';
        setGated(isGated);
        return fetch(`/api/rooms/${portal.roomId}/scoreboard-config`);
      })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => { setConfig(cfg || {}); setConfigLoaded(true); })
      .catch(() => { setConfigLoaded(true); });
  }, [slug]);

  const loadData = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/leaderboard`);
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
    try {
      const res = await fetch(`/api/rooms/${roomId}/rankings`);
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
    try {
      const res = await fetch(`/api/rooms/${roomId}/lobby/feed?limit=15`);
      if (res.ok) {
        const events = await res.json();
        setFeedEvents(events.filter((e: any) => !e.target_user_id));
      }
    } catch { /* ignore */ }
  }, [roomId]);

  // Initial load + auto-refresh
  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const refreshSeconds = parseInt(config.KIOSK_REFRESH_SECONDS || '60', 10);
    if (refreshSeconds > 0) {
      const interval = setInterval(loadData, refreshSeconds * 1000);
      return () => clearInterval(interval);
    }
  }, [loadData, config.KIOSK_REFRESH_SECONDS]);

  // S4: live updates over the room-scoped socket channel. The 60s poll above
  // stays as a backstop. Joins room:<id>, refreshes on leaderboard:updated, and
  // shows a TV-scaled toast on score:new.
  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('join:room', roomId);
    // Re-join on every (re)connect — room membership is per-connection and does
    // not survive a socket reconnect (long-running TV kiosk / idle tab).
    const onConnect = () => socket.emit('join:room', roomId);
    socket.on('connect', onConnect);
    const onScore = (data?: { playerName?: string; score?: number; gameName?: string }) => {
      loadData();
      if (data?.playerName && data?.gameName) {
        setScoreToast({ player: data.playerName, score: data.score ?? 0, game: data.gameName });
        setTimeout(() => setScoreToast(null), 6000);
      }
    };
    const onUpdate = () => { loadData(); };
    socket.on('score:new', onScore);
    socket.on('leaderboard:updated', onUpdate);
    return () => {
      socket.emit('leave:room', roomId);
      socket.off('connect', onConnect);
      socket.off('score:new', onScore);
      socket.off('leaderboard:updated', onUpdate);
    };
  }, [roomId, loadData]);

  const TICKER_ICONS: Record<string, typeof Flame> = {
    new_high_score: Flame, rank_change: TrendingUp, score_posted: Target,
    tournament_results: Trophy, tournament_active: Gamepad2,
    player_milestone: Star, friend_score: Users,
    // Static title only (no countdown) — same reasoning as ScoreboardTicker.
    pick_prompt: Hourglass,
  };

  const tickerItems = useMemo(() => feedEvents.map(e => {
    const ago = (() => {
      const s = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 1000);
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    })();
    return { id: e.id, title: e.title, ago, Icon: TICKER_ICONS[e.type] || Target };
  }), [feedEvents]);

  // s21 — distance-based ticker speed (constant px/s); a fixed 60s duration
  // crawled when the feed had few items. Mirrors ScoreboardTicker.tsx.
  const tickerTrackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const track = tickerTrackRef.current;
    if (!track) return;
    const distance = track.scrollWidth / 2;
    const seconds = Math.min(90, Math.max(15, distance / 70));
    track.style.setProperty('--ticker-duration', `${seconds}s`);
  }, [tickerItems]);

  // v2.90.0 — the horizontal-scroll card rail now lives inside
  // ScoreboardSurface (wrapped in HorizontalScrollNav), so there's no ref
  // handed down to attach to directly. `rootRef` scopes a DOM query to this
  // page's own subtree instead of touching the shared surface/nav components
  // for a kiosk-only ref. `effectiveLayout`/`visibleCount` mirror (just
  // enough of) the surface's own layout derivation SOLELY to know when that
  // DOM region appears/changes — not used for any rendering here. If the
  // surface's layout-selection formula ever changes, update this shadow copy
  // too (deriveScoreboardConfig / deriveCardProps stay the shared source of
  // truth either way).
  const rootRef = useRef<HTMLDivElement>(null);
  const newConfig = deriveScoreboardConfig(config, roomName);
  const legacyProps = deriveCardProps(config, roomName);
  const useNewCards = !!config.SCOREBOARD_STYLE;
  const isBanner = useNewCards && newConfig.style === 'banner';
  const layout = useNewCards ? newConfig.layout : legacyProps.layout;
  const effectiveLayout = isBanner ? 'scroll' : layout;
  const hideEmpty = useNewCards ? newConfig.hideEmpty : legacyProps.hideEmpty;
  const visibleCount = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0).length : leaderboards.length;

  // Kiosk attract mode — when the horizontal card row overflows the screen
  // (typical once Kiosk Zoom is raised for TV distance), slowly ping-pong the
  // row so every card gets screen time. Room toggle KIOSK_AUTO_SCROLL
  // (default on); skipped under prefers-reduced-motion; pauses on user input.
  const autoScrollEnabled = config.KIOSK_AUTO_SCROLL !== 'false';
  useEffect(() => {
    const el = rootRef.current?.querySelector<HTMLDivElement>('.scoreboard-hscroll-layout');
    if (!el || !autoScrollEnabled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const SPEED_PX_PER_SEC = 40;
    const END_DWELL_MS = 3000;
    const INTERACT_PAUSE_MS = 10000;
    let raf = 0;
    let last = 0;
    let dir = 1;
    // Own float accumulator — assigning back each frame; browsers round
    // scrollLeft, so accumulating on the element itself stalls at low speeds.
    let pos = el.scrollLeft;
    let pauseUntil = performance.now() + END_DWELL_MS;

    const onInteract = () => {
      pauseUntil = performance.now() + INTERACT_PAUSE_MS;
      pos = el.scrollLeft;
    };
    el.addEventListener('wheel', onInteract, { passive: true });
    el.addEventListener('touchstart', onInteract, { passive: true });
    el.addEventListener('pointerdown', onInteract);

    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      if (now < pauseUntil) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 4) return;
      pos = Math.min(max, Math.max(0, pos + dir * SPEED_PX_PER_SEC * dt));
      el.scrollLeft = pos;
      if (pos >= max || pos <= 0) {
        dir = -dir;
        pauseUntil = now + END_DWELL_MS;
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('wheel', onInteract);
      el.removeEventListener('touchstart', onInteract);
      el.removeEventListener('pointerdown', onInteract);
    };
  }, [autoScrollEnabled, effectiveLayout, visibleCount]);

  // Guard: wait for config to load, then check if kiosk is enabled
  if (!configLoaded) {
    return <div className="min-h-screen bg-deep" />;
  }
  // Available unless explicitly disabled — matches the Settings "Kiosk Mode"
  // toggle, which defaults ON (defaultOn: true). Gating on === 'true' treated
  // an absent (never-saved) value as disabled, contradicting that default.
  if (config.KIOSK_ENABLED === 'false') {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <p className="text-muted font-display text-lg">Kiosk mode is not available for this room</p>
      </div>
    );
  }
  // v2.39.0 (approval rooms) — kiosk mode isn't supported on approval rooms
  // this release. Without it, the leaderboard/rankings/lobby fetches below
  // would each silently 403 and render an empty-looking board; show an
  // explicit message instead.
  if (gated) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center text-center px-6">
        <p className="text-muted font-display text-lg">
          {roomName || 'This room'} requires approval to join — kiosk display isn't available for approval rooms yet.
        </p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="min-h-screen bg-deep text-primary relative">
      <ScoreboardSurface
        embedded
        config={config}
        roomName={roomName}
        roomId={roomId}
        slug={slug || ''}
        leaderboards={leaderboards}
        rankingGroups={rankingGroups}
        // S21 — kiosk pages zoom by kioskZoom (TV/distance tuning), not the
        // legacy SCOREBOARD_ZOOM directly. deriveScoreboardConfig's fallback
        // chain (KIOSK_ZOOM -> SCOREBOARD_ZOOM -> 100) means existing TVs
        // with only SCOREBOARD_ZOOM set keep their current zoom untouched.
        zoomPercent={newConfig.kioskZoom}
        // "Kiosk only" QR mode exists so the submit QR can appear on the TV
        // without also appearing on the public page.
        qrKioskOnlyEnabled
        // Preserves the kiosk's historical (larger) header spacing.
        kioskHeaderSpacing
        // s21 — bottom-anchored ticker; reserve room so it doesn't cover the
        // last row of cards (mirrors Scoreboard.tsx's own ticker reservation).
        scrollPaddingBottom={feedEvents.length > 0 ? 60 : undefined}
        overlays={
          scoreToast && (
            <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
              <div className="bg-surface border-2 border-neon-cyan/50 rounded-2xl shadow-2xl px-10 py-6 text-center">
                <div className="text-2xl font-bold text-neon-cyan tracking-wider uppercase">New Score</div>
                <div className="text-4xl font-extrabold text-primary mt-2">{scoreToast.player}</div>
                <div className="text-2xl text-primary/85 mt-2">
                  <span className="text-neon-cyan font-bold">{scoreToast.score.toLocaleString()}</span> — {scoreToast.game}
                </div>
              </div>
            </div>
          )
        }
      />

      {/* Lobby feed ticker */}
      {tickerItems.length > 0 && (
        // s20: safe-area-inset-bottom accommodation — see ScoreboardTicker.tsx
        // for the box-sizing rationale (height grows, padding-bottom keeps the
        // 46px content pinned above the unsafe strip on notched devices).
        <div
          className="fixed bottom-0 left-0 right-0 z-40 bg-deep/90 border-t border-border/30 backdrop-blur-sm overflow-hidden"
          style={{ height: 'calc(46px + max(0px, env(safe-area-inset-bottom)))', paddingBottom: 'max(0px, env(safe-area-inset-bottom))' }}
        >
          <div ref={tickerTrackRef} className="kiosk-ticker flex items-center gap-10 whitespace-nowrap h-full px-4">
            {/* Double the items for seamless loop */}
            {[...tickerItems, ...tickerItems].map((item, i) => {
              const Icon = item.Icon;
              return (
                <span key={`${item.id}-${i}`} className="inline-flex items-center gap-2 text-base">
                  <Icon size={16} className="text-neon-cyan flex-shrink-0" />
                  <span className="text-primary/80">{item.title}</span>
                  <span className="text-faint ml-1">{item.ago}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes kiosk-ticker-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .kiosk-ticker {
          animation: kiosk-ticker-scroll var(--ticker-duration, 60s) linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .kiosk-ticker {
            animation: none;
            overflow-x: auto;
          }
        }
      `}</style>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
