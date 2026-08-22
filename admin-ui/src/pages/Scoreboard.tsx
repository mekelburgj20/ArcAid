import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useRoom } from '../contexts/RoomContext';
import { useViewerAuth, useViewerHeaders, usePlayerHeaders } from '../contexts/ViewerAuthContext';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import ScoreboardSurface from '../components/scoreboard/ScoreboardSurface';
import type { LeaderboardWithViewer } from '../components/scoreboard/ScoreboardSurface';
import { tournamentCardTitleLink, tournamentCardTitleClick } from '../components/scoreboard/tournamentCardTitle';
import RoomScoresView from '../components/RoomScoresView';
import GlobalScoresView from '../components/GlobalScoresView';
import GameQuickView from '../components/GameQuickView';
import SubmissionSheet from '../components/SubmissionSheet';
import { DISPLAY_SETTINGS_SAVED_EVENT } from '../components/DisplaySettingsHost';
import { TAB_LABELS } from '../lib/scoresCopy';

type ScoresTab = 'tournaments' | 'room' | 'global';

/**
 * Tournaments | Room Scores | Global tab chips (F2 3-tab unification).
 *
 * Owner-asked header compression (2026-08-08) — hoisted out of `headerExtras` so it can render on
 * the SAME control row as each tab's search bar instead of always sitting up
 * in the measured title/logo zone. `aboveCards` renders it for the
 * Tournaments tab; `RoomScoresView`/`GlobalScoresView` receive the same
 * element as a `tabSwitcher` prop so their own control rows carry it too —
 * one definition, three call sites, byte-identical chips everywhere.
 */
function TabSwitcher({ tab, onSelect }: { tab: ScoresTab; onSelect: (next: ScoresTab) => void }) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Leaderboard tabs">
      {/* s20: outer button carries the ≥44px hit area; inner span keeps the
          original compact tab-chip visual. */}
      {(['tournaments', 'room', 'global'] as const).map(t => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => onSelect(t)}
          className="min-h-11 min-w-11 inline-flex items-center justify-center cursor-pointer"
        >
          <span className={`px-3 py-1 text-xs rounded-lg border transition-colors whitespace-nowrap ${
            tab === t
              ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
              : 'border-border/50 text-muted hover:text-primary'
          }`}>
            {TAB_LABELS[t]}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function Scoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<LeaderboardWithViewer[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [flash, setFlash] = useState(false);
  const [scoreToast, setScoreToast] = useState<{ player: string; score: number; game: string } | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const { roomId, roomName } = useRoom();
  const [selectedGame, setSelectedGame] = useState<GameLeaderboard | null>(null);
  // v2.13.12 — game quick-view modal triggered by title click on tournament cards.
  // RoomScoresView / GlobalScoresView own their own modal state for their tabs.
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);
  const [tournamentSearch, setTournamentSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  // F2 — 3-tab unification: Tournaments | Room Scores | Global. Legacy
  // `all-games` / `games` links (old 2-tab toggle) redirect to `room`.
  const initialTab = (() => {
    const t = searchParams.get('tab');
    if (t === 'room' || t === 'global') return t;
    if (t === 'all-games' || t === 'games') return 'room';
    return 'tournaments';
  })();
  const [tab, setTab] = useState<'tournaments' | 'room' | 'global'>(initialTab);

  const selectTab = (next: 'tournaments' | 'room' | 'global') => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'tournaments') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  // Normalize legacy URL state on mount: strip the stale `played-here` param
  // (the old GamesTabView toggle no longer exists) and rewrite legacy tab
  // values (`all-games`/`games` → `room`) so shared URLs stay canonical (F2).
  useEffect(() => {
    const legacyTab = searchParams.get('tab') === 'all-games' || searchParams.get('tab') === 'games';
    if (!searchParams.has('played-here') && !legacyTab) return;
    const params = new URLSearchParams(searchParams);
    params.delete('played-here');
    if (legacyTab) params.set('tab', 'room');
    setSearchParams(params, { replace: true });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
  const viewerHeaders = useViewerHeaders();
  // S4: the leaderboard/rankings viewer-rank ("Your best — Rank #N") needs the
  // PLAYER token (Discord session), not the admin token (null for public viewers).
  const playerHeaders = usePlayerHeaders();
  const { discordUser, playerToken } = useViewerAuth();

  const deviceType = window.innerWidth <= 640 ? 'mobile' : 'desktop';

  /** Fetch user prefs for current device, merge with room config, apply theme */
  const applyUserPrefs = async (cfg: Record<string, string>, token: string) => {
    try {
      const prefsRes = await fetch(`/api/me/scoreboard-preferences?device=${deviceType}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (prefsRes.ok) {
        const prefs = await prefsRes.json();
        // v2.132.0 — this page no longer touches theme resolution at all. It
        // used to call `setPublicTheme(prefs.UI_THEME)`, which OVERWROTE the
        // room default in the provider (unrecoverable, and it buried the
        // personal theme). The per-room override moved out of these
        // per-device prefs entirely and `ThemeProvider` owns it now; the
        // legacy `UI_THEME` key that may still be in `prefs` is inert.
        setConfig({ ...cfg, ...prefs });
        return true;
      }
    } catch { /* fall through */ }
    return false;
  };

  // Fetch scoreboard config (merged with user prefs if logged in). S18 —
  // roomId now comes from RoomContext (resolved once in PublicLayout)
  // instead of this effect fetching /api/portal itself.
  useEffect(() => {
    if (!roomId) return;
    (async () => {
      try {
        const cfgRes = await fetch(`/api/rooms/${roomId}/scoreboard-config`, { headers: viewerHeaders });
        const cfg = cfgRes.ok ? await cfgRes.json() : {};
        if (playerToken) {
          if (await applyUserPrefs(cfg || {}, playerToken)) return;
        }
        setConfig(cfg || {});
      } catch { /* ignore */ }
    })();
  }, [roomId, playerToken]);

  // v2.132.0 — the Display settings sheet itself is mounted app-wide by
  // `DisplaySettingsHost` (so the user-menu item works on every page). This
  // page no longer owns it; it only reacts to a save, re-merging the viewer's
  // overrides over the room config exactly as the old `onSaved` callback did.
  useEffect(() => {
    if (!roomId || !playerToken) return;
    const handler = () => {
      (async () => {
        try {
          const cfgRes = await fetch(`/api/rooms/${roomId}/scoreboard-config`, { headers: viewerHeaders });
          const cfg = cfgRes.ok ? await cfgRes.json() : {};
          if (!(await applyUserPrefs(cfg || {}, playerToken))) setConfig(cfg || {});
        } catch { /* ignore */ }
      })();
    };
    window.addEventListener(DISPLAY_SETTINGS_SAVED_EVENT, handler);
    return () => window.removeEventListener(DISPLAY_SETTINGS_SAVED_EVENT, handler);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [roomId, playerToken]);

  const loadData = async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/leaderboard`, { headers: playerHeaders });
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
  };

  const loadRankings = async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/rankings`, { headers: playerHeaders });
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!roomId) return;
    loadData();
    loadRankings();

    const socket = getSocket();
    socket.emit('join:room', roomId);
    // Re-join on every (re)connect — socket.io room membership is per-connection
    // and doesn't survive a reconnect, so an idle/backgrounded tab or a TV kiosk
    // whose socket drops would otherwise silently stop receiving room events.
    const onConnect = () => socket.emit('join:room', roomId);
    socket.on('connect', onConnect);
    const onScore = (data?: { playerName?: string; score?: number; gameName?: string }) => {
      setFlash(true);
      loadData();
      loadRankings();
      setTimeout(() => setFlash(false), 1500);
      if (data?.playerName && data?.gameName) {
        setScoreToast({ player: data.playerName, score: data.score ?? 0, game: data.gameName });
        setTimeout(() => setScoreToast(null), 5000);
      }
    };
    const onLeaderboard = () => { loadData(); loadRankings(); };
    const onRotated = () => { loadData(); };
    // v2.116.0 — a room admin saved the room's appearance. Same refetch the
    // prefs modal does on save (viewer prefs are re-applied over the new room
    // config, so a viewer's own overrides survive the room changing).
    const onSettings = () => {
      (async () => {
        try {
          const cfgRes = await fetch(`/api/rooms/${roomId}/scoreboard-config`, { headers: viewerHeaders });
          const cfg = cfgRes.ok ? await cfgRes.json() : {};
          if (playerToken && await applyUserPrefs(cfg || {}, playerToken)) return;
          setConfig(cfg || {});
        } catch { /* ignore */ }
      })();
    };
    socket.on('score:new', onScore);
    socket.on('leaderboard:updated', onLeaderboard);
    socket.on('game:rotated', onRotated);
    socket.on('settings:updated', onSettings);

    return () => {
      socket.emit('leave:room', roomId);
      socket.off('connect', onConnect);
      // Pass handler refs: the socket is a shared singleton, so a bare
      // socket.off('score:new') would also kill the admin Leaderboard's and
      // Kiosk's handlers for the same event (S4 fix).
      socket.off('score:new', onScore);
      socket.off('leaderboard:updated', onLeaderboard);
      socket.off('game:rotated', onRotated);
      socket.off('settings:updated', onSettings);
    };
  }, [roomId, playerToken]);

  const viewerUsername = discordUser?.username || undefined;
  // Not a rendering derivation — the surface owns every one of those. This one
  // feeds SubmissionSheet, which is page-owned.
  const requirePhoto = config.REQUIRE_SCORE_PHOTO === 'true';

  return (
    <>
      <ScoreboardSurface
        config={config}
        roomName={roomName}
        roomId={roomId}
        slug={slug || ''}
        leaderboards={leaderboards}
        rankingGroups={rankingGroups}
        viewerUsername={viewerUsername}
        onSubmitScore={(lb) => setSelectedGame(lb)}
        titleLinkTo={tournamentCardTitleLink(slug || '')}
        titleLinkOnClick={tournamentCardTitleClick(setQuickViewLb)}
        // v2.109.0 (score-gesture-photos) — a click that opens the popup
        // (once a row is expanded, or immediately for a single-score row)
        // opens the same quick popup the title opens.
        onOpenQuickView={setQuickViewLb}
        searchFilter={tournamentSearch}
        // S14: reserve room for the fixed-bottom lobby ticker so it doesn't
        // cover the last row of cards.
        scrollPaddingBottom={roomId ? 40 : undefined}
        overlays={
          <>
            {/* Score flash overlay */}
            {flash && (
              <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
            )}

            {/* Score toast notification */}
            {scoreToast && (
              <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-slideDown">
                <div className="bg-surface border border-neon-cyan/40 rounded-lg shadow-lg px-6 py-3 text-sm text-primary">
                  <span className="text-neon-cyan font-bold">{scoreToast.player}</span>
                  {' '}posted{' '}
                  <span className="text-neon-cyan font-bold">{scoreToast.score.toLocaleString()}</span>
                  {' '}on{' '}
                  <span className="text-neon-cyan font-bold">{scoreToast.game}</span>!
                </div>
              </div>
            )}
          </>
        }
        aboveCards={
          /* Owner-asked header compression (2026-08-08), revised per owner
             feedback on the first pass: the Tournaments/Room Scores/Global
             chips must be TRULY centered on the row (centered against the
             full row width), not just pushed into leftover flex space. A
             3-column grid (`1fr auto 1fr`) does that — left/right tracks are
             equal width, so the auto-sized center track sits dead-center
             regardless of how much content is in the side tracks. Tournaments
             has no right-side content, so only two grid items are rendered;
             the empty 1fr third track still reserves the space, which is
             exactly what keeps the chips centered. Collapses to one column
             (stacked rows, search then chips) below `sm` — same
             never-horizontal-scroll guarantee as the flex-wrap it replaces. */
          <div className="px-4 sm:px-6 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="relative min-w-0 max-w-sm">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  placeholder="Search active games..."
                  value={tournamentSearch}
                  onChange={e => setTournamentSearch(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
                  aria-label="Search active games"
                />
              </div>
              <div className="min-w-0 flex justify-center">
                <TabSwitcher tab={tab} onSelect={selectTab} />
              </div>
            </div>
          </div>
        }
        contentOverride={
          tab === 'room' ? (
            <RoomScoresView roomId={roomId} slug={slug || ''} config={config} roomName={roomName} viewerUsername={viewerUsername} tabSwitcher={<TabSwitcher tab={tab} onSelect={selectTab} />} />
          ) : tab === 'global' ? (
            <GlobalScoresView roomId={roomId} slug={slug || ''} config={config} roomName={roomName} viewerUsername={viewerUsername} tabSwitcher={<TabSwitcher tab={tab} onSelect={selectTab} />} />
          ) : undefined
        }
      />

      {/* v2.13.12 — game quick-view modal (lightweight preview triggered by
          title click on tournament cards). Falls through to GameDetail via
          "View full info →" or to GlobalGameDetail via "Global Leaderboard →". */}
      {quickViewLb && (
        <GameQuickView
          lb={quickViewLb}
          slug={slug || ''}
          fromTab="tournaments"
          // v2.108.0 (F4) — passing roomId turns on the per-row delete
          // affordances inside the popup (own rows for players, any row for
          // admins of this room).
          roomId={roomId}
          onScoreDeleted={() => { loadData(); loadRankings(); }}
          onClose={() => setQuickViewLb(null)}
        />
      )}

      {/* Score submission — SubmissionSheet (Sprint 10) handles anonymous flow.
          v2.79.0 — login is required room-wide; the sheet gates on its own. */}
      {selectedGame && roomId && (
        <SubmissionSheet
          target={{ kind: 'tournament', roomId, gameName: selectedGame.gameName, gameStatus: selectedGame.gameStatus, requirePhoto }}
          roomSlug={slug}
          discordEnabled={config.DISCORD_ENABLED !== 'false'}
          onClose={() => setSelectedGame(null)}
          onSubmitted={() => { loadData(); loadRankings(); setSelectedGame(null); }}
        />
      )}

    </>
  );
}
