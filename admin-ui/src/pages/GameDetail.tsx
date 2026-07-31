import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import StarRating from '../components/StarRating';
import Sparkline from '../components/Sparkline';
import SubmissionSheet from '../components/SubmissionSheet';
import ShareButton from '../components/ShareButton';
import { api } from '../lib/api';
import PlayerNameLink from '../components/PlayerNameLink';
import ProvenanceTags from '../components/ProvenanceTags';
import { getEngineCategoryLabel, getEngineDisplay } from '../lib/scoreProvenance';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useRoom } from '../contexts/RoomContext';
import { requiresAnyLogin, requiresDiscordOnly } from '../lib/loginPolicy';
import { Search, Trophy, TrendingUp, Target, Medal, Plus, Minus, Clock, Lightbulb, MessageCircle, Trash2, ChevronDown, ChevronUp, History, Download, Play, BookOpen, ExternalLink, Flag } from 'lucide-react';
import ReportProblemModal from '../components/ReportProblemModal';
import ReportContentModal from '../components/ReportContentModal';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';

/** Decode a player JWT and pull the role + gameRoomIds claims. The viewer
 *  could be a player, room_admin, or super_admin — public-page tokens carry
 *  whichever role the user actually has. Returns null on missing/invalid. */
function decodeViewerClaims(token: string | null): {
  role: 'player' | 'room_admin' | 'super_admin';
  gameRoomIds: string[];
  discordId: string | null;
} | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      role: (payload.role as 'player' | 'room_admin' | 'super_admin') || 'player',
      gameRoomIds: Array.isArray(payload.gameRoomIds) ? payload.gameRoomIds : [],
      discordId: (payload.discordId as string) || null,
    };
  } catch {
    return null;
  }
}

interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  score: number;
  /**
   * v2.5.0: per-row platform stamp. `null` for legacy rows the backfill
   * couldn't disambiguate (multi-platform games). `undefined` if a stale
   * cache returned a row without the field — treated the same as `null`.
   *
   * @deprecated v2.58.0 (ADR 0016) — display comes from engine/device.
   */
  platform?: string | null;
  /**
   * v2.58.0 (ADR 0016): what produced the score. `'unknown'` when nobody
   * recorded it. `undefined` only from a pre-P3 cached blob (migration 127
   * flushes those), in which case `ProvenanceTags` renders nothing.
   */
  engine?: string | null;
  /** v2.58.0 (ADR 0016): what it ran on. */
  device?: string | null;
}

interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  imageUrl: string | null;
  rankings: RankedEntry[];
  /** Sprint 10 / v2.0.1 — surfaces cooldown banner state to SubmissionSheet. */
  gameStatus?: string;
  /** Backend includes this so we can link to the rich global catalogue page. */
  globalGameId?: string | null;
}

interface GameStats {
  gameName: string;
  timesPlayed: number;
  avgScore: number;
  uniquePlayers: number;
  allTimeHigh: number;
  allTimeHighPlayer: string | null;
  recentResults: Array<{
    tournament_name: string;
    winner_name: string;
    winner_score: number;
    end_date: string;
  }>;
}

interface PlayerGameStats {
  times_played: number;
  best_score: number;
  worst_score: number;
  avg_rank: number;
  wins: number;
  trend: Array<{ date: string; score: number; rank: number }>;
}

interface CommunityLeaderboardEntry {
  /** Identity-collapse key: `submitted_by_user_id` or `iscored:<name>` fallback. */
  player_key?: string;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  best_score: number;
  times_played: number;
  last_played: string;
}

interface CommunityHistoryEntry {
  id: number;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  score: number;
  created_at: string;
}

interface GameComment {
  id: number;
  user_id: string;
  display_name: string;
  type: 'comment' | 'tip';
  body: string;
  created_at: string;
}

interface ScoreHistoryEntry {
  id: number;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  score: number;
  source: 'tournament' | 'community' | 'sync';
  created_at: string;
  photo_url?: string;
  /** v2.1.0 — tournament this score was submitted during (if any). */
  tournament_id?: string | null;
  tournament_name?: string | null;
  tournament_active?: 0 | 1 | null;
  /** Discord id of the submitter; null for guest/anon rows. Used to gate
   *  player self-delete on this row. */
  submitted_by_user_id?: string | null;
}

interface GamePlayerRanking {
  rank: number;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  best_score: number;
  times_played: number;
  last_played: string;
}

/** Subset of the global catalogue entity (GET /api/global/games/:id) consumed
 *  by the "About this game" section below. Server pre-parses the JSON array
 *  columns — see src/api/routes/global.ts. */
interface CatalogueGameInfo {
  manufacturer: string | null;
  year: number | null;
  type: string;
  themes: string[];
  designers: string[];
  table_authors: string[];
  table_download_urls: Array<{ format?: string; url: string; version?: string }>;
  tutorial_urls: Array<{ title?: string; youtubeId?: string; url?: string }>;
  rules_urls: Array<{ url: string; version?: string }>;
  ipdb_url: string | null;
}

type Tab = 'leaderboard' | 'community' | 'tips' | 'player-stats';

export default function GameDetail() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  // v2.13.12 — back link returns to the tab the user came from.
  // F2/F6: ?tab=room|global echo straight through; the legacy ?tab=all-games
  // (pre-3-tab-unification links/bookmarks) maps onto the new Room Scores tab;
  // absent or ?tab=tournaments falls back to the default Tournaments tab (no param).
  const [searchParams] = useSearchParams();
  const fromTab = searchParams.get('tab');
  const backToRoomHref =
    fromTab === 'room' || fromTab === 'global' ? `/${slug}?tab=${fromTab}`
    : fromTab === 'all-games' ? `/${slug}?tab=room`
    : `/${slug}`;
  // S5: QR submit deep-links here with ?highlight=<resolved player name> so the
  // just-submitted row stands out + scrolls into view. Matched case-insensitively
  // against the row's iscored_username (which equals the resolved name stored).
  const highlightName = (searchParams.get('highlight') || '').toLowerCase();
  const { playerToken } = useViewerAuth();
  const viewerClaims = useMemo(() => decodeViewerClaims(playerToken), [playerToken]);
  const { roomId, roomName } = useRoom();
  const { toast } = useToast();
  const [reportOpen, setReportOpen] = useState(false);
  // s20: confirm-before-delete for score-history rows, replacing native confirm().
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<ScoreHistoryEntry | null>(null);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<GameLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [ratingInfo, setRatingInfo] = useState<{ avg_rating: number; rating_count: number; user_rating: number | null } | null>(null);
  // Initial 'community' is the safe pre-data default; the leaderboard tab does
  // not exist until `stats` loads. Once stats resolves we default to
  // 'leaderboard' when tournament data exists (see tabInitialized effect below).
  const [activeTab, setActiveTab] = useState<Tab>('community');
  // Guards the one-time default-tab decision so an async stats load (or a
  // back-nav re-fetch) never yanks the user off a tab they manually selected.
  const tabInitialized = useRef(false);
  // Callback ref on the highlighted leaderboard row — scrolls it into view once
  // when it mounts (stable identity, so React only invokes it on mount/unmount).
  const highlightRowRef = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Expandable score history per player in leaderboard
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [playerHistory, setPlayerHistory] = useState<ScoreHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [scoreCounts, setScoreCounts] = useState<Record<string, number>>({});

  // v2.58.0 (ADR 0016): per-ENGINE leaderboard tabs, replacing the v2.5.0
  // per-platform ones. Engine is what determines comparability, so it is the
  // only axis a leaderboard may be split on — a device tab would separate
  // scores that are genuinely comparable (PC-VPX vs AtGames-VPX).
  //
  // - selectedEngine === null → "All" view (leaderboard.rankings as-is)
  // - selectedEngine === 'X'  → filtered, fetched from ?engine=X
  //
  // The tab list and the filter now read the SAME column, which is what closes
  // the pre-P3 bug where tabs were labelled from alias-folded values and then
  // queried raw, so a tab could match zero rows.
  const [distinctEngines, setDistinctEngines] = useState<string[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const [filteredRankings, setFilteredRankings] = useState<RankedEntry[] | null>(null);

  // "About this game" — catalogue metadata (Table Authors, Downloads,
  // Tutorials, References). Fetched once the leaderboard resolves the
  // room-pinned game's globalGameId. Failure/absence just hides the section.
  const [catalogueGame, setCatalogueGame] = useState<CatalogueGameInfo | null>(null);

  // Full game score history
  const [gameHistory, setGameHistory] = useState<ScoreHistoryEntry[]>([]);
  const [showGameHistory, setShowGameHistory] = useState(false);

  // Player rankings + lookup state
  const [gamePlayerRankings, setGamePlayerRankings] = useState<GamePlayerRanking[]>([]);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('arcaid-player-name') || '');
  const [playerStats, setPlayerStats] = useState<PlayerGameStats | null>(null);
  const [playerScoreHistory, setPlayerScoreHistory] = useState<ScoreHistoryEntry[]>([]);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState('');

  // Community scores state
  const [communityBoard, setCommunityBoard] = useState<CommunityLeaderboardEntry[]>([]);
  const [communityHistory, setCommunityHistory] = useState<CommunityHistoryEntry[]>([]);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  // Room config for SubmissionSheet — photo + login requirements come from game-info/portal.
  const [requirePhoto, setRequirePhoto] = useState(false);
  const [requireLogin, setRequireLogin] = useState(false);
  const [discordOnlyLogin, setDiscordOnlyLogin] = useState(false);
  const [discordEnabled, setDiscordEnabled] = useState(true);

  // Comments/tips state
  const [tips, setTips] = useState<GameComment[]>([]);
  const [comments, setComments] = useState<GameComment[]>([]);
  const [commentDisplayName, setCommentDisplayName] = useState(() => localStorage.getItem('arcaid-player-name') || '');
  const [commentBody, setCommentBody] = useState('');
  const [commentType, setCommentType] = useState<'comment' | 'tip'>('comment');
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // Anonymous user ID for comment ownership
  const [userId] = useState(() => {
    const stored = localStorage.getItem('arcaid-user-id');
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem('arcaid-user-id', id);
    return id;
  });

  // v2.47.0 (S22 follow-ups Workstream 2) — Flag-a-comment modal target.
  const [flagTarget, setFlagTarget] = useState<GameComment | null>(null);

  // Load game data once room is resolved
  useEffect(() => {
    if (!name || !roomId) return;

    fetch(`/api/rooms/${roomId}/stats/game/${encodeURIComponent(name)}`)
      .then(r => r.ok ? r.json() : null)
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));

    api.get<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`/ratings/${encodeURIComponent(name)}`)
      .then(setRatingInfo)
      .catch(() => {});

    fetch(`/api/rooms/${roomId}/leaderboard`)
      .then(r => r.ok ? r.json() : [])
      .then((boards: GameLeaderboard[]) => {
        const match = boards.find(b => b.gameName.toLowerCase() === name.toLowerCase());
        if (match) {
          setLeaderboard(match);
          // Fetch score counts for conditional expand icons
          fetch(`/api/rooms/${roomId}/score-counts/${match.gameId}`)
            .then(r => r.ok ? r.json() : {})
            .then(setScoreCounts)
            .catch(() => {});
          // v2.58.0: pull the distinct engines separately so the "All" view can
          // render the segmented tab strip. Bulk leaderboard list endpoint
          // doesn't include this; the per-game endpoint does.
          fetch(`/api/rooms/${roomId}/leaderboard/${match.gameId}`)
            .then(r => r.ok ? r.json() : null)
            .then((data: { distinctEngines?: string[]; rankings?: RankedEntry[] } | null) => {
              if (!data) return;
              if (Array.isArray(data.distinctEngines)) setDistinctEngines(data.distinctEngines);
              // The per-game endpoint also returns a fresher rankings array
              // that's been recomputed post-cache-flush, so prefer it.
              if (Array.isArray(data.rankings) && data.rankings.length > 0) {
                setLeaderboard(prev => prev ? { ...prev, rankings: data.rankings! } : prev);
              }
            })
            .catch(() => {});
          return;
        }
        // Non-active games (pinned/room-only games with no ACTIVE tournament
        // board) aren't in the active-boards list above. Fall back to the
        // Room Scores card for this game — same all-time, canonical-partition
        // rankings the Room Scores tab shows, including globalGameId (powers
        // the About This Game section below). The card's gameId is a
        // catalogue id or a `room_<name>` pseudo-id, NOT a games-table id —
        // do NOT call the id-keyed /leaderboard/:gameId or
        // /score-counts/:gameId endpoints against it.
        fetch(`/api/rooms/${roomId}/room-scores?search=${encodeURIComponent(name)}&limit=10`)
          .then(r => r.ok ? r.json() : null)
          .then((payload: { data?: GameLeaderboard[] } | null) => {
            const card = payload?.data?.find(c => c.gameName.toLowerCase() === name.toLowerCase());
            if (!card) return;
            setLeaderboard(card);
            // Score counts keyed by name (fallback cards have no games-table
            // id to key the id-based score-counts endpoint on).
            fetch(`/api/rooms/${roomId}/score-counts?gameNames=${encodeURIComponent(name)}`)
              .then(r => r.ok ? r.json() : null)
              .then((data: { counts?: Record<string, Record<string, number>> } | null) => {
                if (data?.counts?.[name]) setScoreCounts(data.counts[name]);
              })
              .catch(() => {});
          })
          .catch(() => {});
      })
      .catch(() => {});

    // Load all-time player rankings for this game
    fetch(`/api/rooms/${roomId}/stats/game/${encodeURIComponent(name)}/players`)
      .then(r => r.ok ? r.json() : [])
      .then(setGamePlayerRankings)
      .catch(() => {});

    // Load community scores
    loadCommunityData(roomId, name);

    // Load comments and tips
    loadComments(roomId, name);

    // v2.0.1 — fetch room config so SubmissionSheet knows whether a photo is
    // required and whether to show the login-required state upfront.
    fetch(`/api/rooms/${roomId}/scoreboard-config`)
      .then(r => r.ok ? r.json() : {})
      .then((cfg: Record<string, string>) => {
        setRequirePhoto(cfg.REQUIRE_SCORE_PHOTO === 'true');
        setRequireLogin(requiresAnyLogin(cfg.REQUIRE_DISCORD_LOGIN));
        setDiscordOnlyLogin(requiresDiscordOnly(cfg.REQUIRE_DISCORD_LOGIN));
        setDiscordEnabled(cfg.DISCORD_ENABLED !== 'false');
      })
      .catch(() => {});
  }, [name, roomId]);

  // Default the active tab once the game-data load settles: 'leaderboard' when
  // tournament data exists (same `!!stats` signal that gates the tab list),
  // else keep 'community'. Guarded by tabInitialized so this runs exactly once
  // — a manual tab switch or a back-nav re-fetch won't override the user.
  useEffect(() => {
    if (loading || tabInitialized.current) return;
    tabInitialized.current = true;
    setActiveTab(stats ? 'leaderboard' : 'community');
  }, [loading, stats]);

  // v2.58.0: fetch engine-filtered rankings whenever the user picks a
  // non-"All" tab. "All" uses the unfiltered rankings already in `leaderboard`.
  useEffect(() => {
    if (!roomId || !leaderboard?.gameId || !selectedEngine) {
      setFilteredRankings(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/leaderboard/${leaderboard.gameId}?engine=${encodeURIComponent(selectedEngine)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { rankings?: RankedEntry[] } | null) => {
        if (cancelled) return;
        setFilteredRankings(Array.isArray(data?.rankings) ? data!.rankings! : []);
      })
      .catch(() => {
        if (!cancelled) setFilteredRankings([]);
      });
    return () => { cancelled = true; };
  }, [roomId, leaderboard?.gameId, selectedEngine]);

  // "About this game" — pull the full catalogue entity once the game's
  // globalGameId resolves. Public endpoint; failures are silent (section
  // just doesn't render).
  useEffect(() => {
    const globalGameId = leaderboard?.globalGameId;
    if (!globalGameId) { setCatalogueGame(null); return; }
    let cancelled = false;
    fetch(`/api/global/games/${globalGameId}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: CatalogueGameInfo | null) => { if (!cancelled) setCatalogueGame(data); })
      .catch(() => { if (!cancelled) setCatalogueGame(null); });
    return () => { cancelled = true; };
  }, [leaderboard?.globalGameId]);

  const loadCommunityData = (rid: string, gameName: string) => {
    fetch(`/api/rooms/${rid}/community-scores/${encodeURIComponent(gameName)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setCommunityBoard)
      .catch(() => {});

    fetch(`/api/rooms/${rid}/community-scores/${encodeURIComponent(gameName)}?history=1`)
      .then(r => r.ok ? r.json() : [])
      .then(() => {
        // Load recent history separately
        fetch(`/api/rooms/${rid}/community-scores/recent`)
          .then(r => r.ok ? r.json() : [])
          .then((all: CommunityHistoryEntry[]) => {
            // Filter to this game
            setCommunityHistory(all.filter((e: any) => e.game_name?.toLowerCase() === gameName.toLowerCase()));
          })
          .catch(() => {});
      })
      .catch(() => {});
  };

  // v2.47.0 (S22 follow-ups Workstream 2) — comment ownership check that
  // covers both the anon localStorage id AND a logged-in Discord identity
  // (needed now that `loadComments` sends the player token: the server masks
  // `user_id` to the CALLER's identity, which for a logged-in viewer is
  // `viewerClaims.discordId`, not the anon `userId`).
  const isOwnComment = useCallback((c: GameComment) => (
    c.user_id === userId || (!!viewerClaims?.discordId && c.user_id === viewerClaims.discordId)
  ), [userId, viewerClaims]);

  const loadComments = (rid: string, gameName: string) => {
    // v2.47.0 (S22 follow-ups Workstream 2) — send the player token when
    // available, in addition to the anon x-user-id, so a logged-in viewer's
    // own-comment mask/authorization resolves off their Discord identity too
    // (the server prefers req.user?.discordId over x-user-id).
    const authHeaders: Record<string, string> = { 'x-user-id': userId };
    if (playerToken) authHeaders.Authorization = `Bearer ${playerToken}`;
    fetch(`/api/rooms/${rid}/games/${encodeURIComponent(gameName)}/comments?type=tip`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : [])
      .then(setTips)
      .catch(() => {});
    fetch(`/api/rooms/${rid}/games/${encodeURIComponent(gameName)}/comments?type=comment`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : [])
      .then(setComments)
      .catch(() => {});
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = commentDisplayName.trim();
    const trimmedBody = commentBody.trim();
    if (!trimmedName || !trimmedBody || !roomId || !name) return;
    setCommentSubmitting(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-user-id': userId };
      if (playerToken) headers.Authorization = `Bearer ${playerToken}`;
      const res = await fetch(`/api/rooms/${roomId}/games/${encodeURIComponent(name)}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ display_name: trimmedName, type: commentType, body: trimmedBody }),
      });
      if (res.ok) {
        setCommentBody('');
        localStorage.setItem('arcaid-player-name', trimmedName);
        loadComments(roomId, name);
      }
    } catch {}
    setCommentSubmitting(false);
  };

  const handleDeleteComment = async (commentId: number) => {
    if (!roomId || !name) return;
    try {
      const headers: Record<string, string> = { 'x-user-id': userId };
      if (playerToken) headers.Authorization = `Bearer ${playerToken}`;
      await fetch(`/api/rooms/${roomId}/games/${encodeURIComponent(name)}/comments/${commentId}`, {
        method: 'DELETE',
        headers,
      });
      loadComments(roomId, name);
    } catch {}
  };

  /** s20: opens the confirm modal; the actual delete runs in
   *  `performDeleteScoreHistory` once the user confirms. */
  const handleDeleteScoreHistory = (entry: ScoreHistoryEntry) => {
    if (!roomId || !playerToken) return;
    setPendingDeleteEntry(entry);
  };

  /** Delete one score_history row. Server gates: admin OR row owner. We
   *  optimistically drop the row from the expanded view, then refresh the
   *  leaderboard since the deleted score may have been this player's best. */
  const performDeleteScoreHistory = async (entry: ScoreHistoryEntry) => {
    if (!roomId || !playerToken) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/score-history/${entry.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Failed to delete score', 'error');
        return;
      }
      setPlayerHistory(prev => prev.filter(h => h.id !== entry.id));
      // The leaderboard / per-player rankings may have shifted (this could
      // have been the player's best). Refetch the small ones inline so the
      // page reflects the change immediately even before the websocket
      // `leaderboard:updated` broadcast lands.
      if (leaderboard?.gameId) {
        fetch(`/api/rooms/${roomId}/leaderboard/${leaderboard.gameId}`)
          .then(r => r.ok ? r.json() : null)
          .then((data: { rankings?: RankedEntry[] } | null) => {
            if (data?.rankings) {
              setLeaderboard(prev => prev ? { ...prev, rankings: data.rankings! } : prev);
            }
          })
          .catch(() => {});
        // scoreCounts gates the ▼ expand icon on each leaderboard row; if the
        // deleted row dropped a player below the >1 threshold, the icon
        // should disappear.
        fetch(`/api/rooms/${roomId}/score-counts/${leaderboard.gameId}`)
          .then(r => r.ok ? r.json() : {})
          .then(setScoreCounts)
          .catch(() => {});
        // Engine-filtered view is fetched separately and isn't refreshed
        // by setting `leaderboard.rankings`; nudge the effect to re-run.
        if (selectedEngine) {
          fetch(`/api/rooms/${roomId}/leaderboard/${leaderboard.gameId}?engine=${encodeURIComponent(selectedEngine)}`)
            .then(r => r.ok ? r.json() : null)
            .then((data: { rankings?: RankedEntry[] } | null) => {
              setFilteredRankings(Array.isArray(data?.rankings) ? data!.rankings! : []);
            })
            .catch(() => {});
        }
      }
      fetch(`/api/rooms/${roomId}/stats/game/${encodeURIComponent(name as string)}/players`)
        .then(r => r.ok ? r.json() : [])
        .then(setGamePlayerRankings)
        .catch(() => {});
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete score', 'error');
    }
  };

  /** Whether the viewer can delete `entry`. Admin can delete any
   *  tournament/sync row; player can delete only their own rows. Community
   *  rows are server-rejected for now (no community_scores cascade). */
  const canDeleteScoreHistory = (entry: ScoreHistoryEntry): boolean => {
    if (entry.source !== 'tournament' && entry.source !== 'sync') return false;
    if (!viewerClaims || !roomId) return false;
    if (viewerClaims.role === 'super_admin') return true;
    if (viewerClaims.role === 'room_admin' && viewerClaims.gameRoomIds.includes(roomId)) return true;
    return !!entry.submitted_by_user_id && entry.submitted_by_user_id === viewerClaims.discordId;
  };

  const handleRate = async (rating: number) => {
    if (!name) return;
    try {
      const info = await api.post<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`/ratings/${encodeURIComponent(name)}`, { rating });
      setRatingInfo(info);
    } catch {}
  };

  const togglePlayerHistory = (playerUsername: string) => {
    if (expandedPlayer === playerUsername) {
      setExpandedPlayer(null);
      setPlayerHistory([]);
      return;
    }
    if (!roomId || !name) return;
    setExpandedPlayer(playerUsername);
    setHistoryLoading(true);
    fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(name)}/player/${encodeURIComponent(playerUsername)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setPlayerHistory)
      .catch(() => setPlayerHistory([]))
      .finally(() => setHistoryLoading(false));
  };

  const loadGameHistory = () => {
    if (!roomId || !name) return;
    setShowGameHistory(!showGameHistory);
    if (!showGameHistory && gameHistory.length === 0) {
      fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(name)}`)
        .then(r => r.ok ? r.json() : [])
        .then(setGameHistory)
        .catch(() => {});
    }
  };

  const lookupPlayer = (overrideName?: string) => {
    const trimmed = (overrideName ?? playerName).trim();
    if (!trimmed || !roomId || !name) return;
    setPlayerName(trimmed);
    localStorage.setItem('arcaid-player-name', trimmed);
    setPlayerLoading(true);
    setPlayerError('');
    setPlayerStats(null);
    setPlayerScoreHistory([]);
    fetch(`/api/rooms/${roomId}/stats/game/${encodeURIComponent(name)}/player/${encodeURIComponent(trimmed)}`)
      .then(r => {
        if (r.status === 404) { setPlayerError('No stats found for this player on this game.'); return null; }
        if (!r.ok) { setPlayerError('Failed to load stats.'); return null; }
        return r.json();
      })
      .then(data => { if (data) setPlayerStats(data); })
      .catch(() => setPlayerError('Failed to load stats.'))
      .finally(() => setPlayerLoading(false));

    // Also load score history
    fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(name)}/player/${encodeURIComponent(trimmed)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setPlayerScoreHistory)
      .catch(() => {});
  };

  // v2.0.1 — Community submit migrated to SubmissionSheet. Photo upload works,
  // anon-claim flow applies, login gate enforced upfront when room requires it.

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  const imageUrl = leaderboard?.imageUrl;
  const hasTournamentData = !!stats;
  // Non-active/pinned games have no `stats` (StatsService.getGameStats
  // requires a tournament join) but can still have an all-time leaderboard
  // via the room-scores fallback above — surface the Leaderboard tab there too.
  const showLeaderboardTab = hasTournamentData || !!leaderboard;
  const tabs: { id: Tab; label: string }[] = showLeaderboardTab
    ? [
        { id: 'leaderboard', label: 'Leaderboard' },
        { id: 'community', label: 'Community' },
        { id: 'tips', label: 'Tips & Comments' },
        { id: 'player-stats', label: 'Player Stats' },
      ]
    : [
        { id: 'community', label: 'Community' },
        { id: 'tips', label: 'Tips & Comments' },
      ];

  return (
    <div>
      {/* Hero header with image */}
      <div
        className="relative h-40 sm:h-48 bg-raised flex items-end"
        style={imageUrl ? {
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'top center',
        } : undefined}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/50 to-black/20" />
        <div className="relative z-10 max-w-4xl mx-auto w-full px-4 sm:px-6 pb-4">
          <Link to={backToRoomHref} className="text-white/50 text-xs hover:text-white/70 no-underline transition-colors">
            &larr; Leaderboard
          </Link>
          <div className="flex items-center justify-between gap-3 mt-1">
            <h2 className="font-display text-2xl font-bold text-white min-w-0 break-words">{stats?.gameName || name}</h2>
            {/* S16 — Web Share (clipboard fallback) */}
            <ShareButton
              title={`${stats?.gameName || name} · Arcaid`}
              text={`Check out the leaderboard for ${stats?.gameName || name}${roomName ? ` at ${roomName}` : ''} on Arcaid!`}
              path={`/${slug}/games/${encodeURIComponent(name || '')}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/25 bg-white/10 text-white/80 hover:bg-white/20 text-xs font-medium transition-colors cursor-pointer shrink-0"
            />
          </div>
          {leaderboard && (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-white/50 text-xs uppercase tracking-wider">{leaderboard.tournamentName}</p>
              {leaderboard.globalGameId && (
                <Link
                  to={`/games/${leaderboard.globalGameId}?from=${encodeURIComponent(slug || '')}${fromTab ? `&tab=${fromTab}` : ''}`}
                  className="text-neon-cyan/70 hover:text-neon-cyan text-xs uppercase tracking-wider no-underline transition-colors"
                  title="Cross-room scores, wheel art, downloads, tutorials"
                >
                  Global Scoreboard →
                </Link>
              )}
            </div>
          )}
          {ratingInfo && (
            <div className="flex items-center gap-2 mt-1">
              <StarRating rating={ratingInfo.user_rating || 0} onRate={handleRate} size="md" />
              {ratingInfo.rating_count > 0 && (
                <span className="text-sm text-white/60">{ratingInfo.avg_rating} avg ({ratingInfo.rating_count} rating{ratingInfo.rating_count !== 1 ? 's' : ''})</span>
              )}
            </div>
          )}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Stat Cards — only when tournament data exists */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <StatCard label="Times Featured" value={stats.timesPlayed.toString()} color="text-neon-cyan" />
            <StatCard label="Unique Players" value={stats.uniquePlayers.toString()} color="text-neon-green" />
            <StatCard label="Avg Score" value={stats.avgScore.toLocaleString()} color="text-muted" />
            <StatCard label="All-Time High" value={stats.allTimeHigh.toLocaleString()} color="text-neon-amber" />
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-border mb-6">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-1 sm:px-4 py-2.5 text-xs sm:text-sm font-medium transition-colors border-b-2 -mb-px text-center ${
                activeTab === tab.id
                  ? 'text-neon-cyan border-neon-cyan'
                  : 'text-muted border-transparent hover:text-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'leaderboard' && (
          <>
            {/* Active Leaderboard */}
            {leaderboard && leaderboard.rankings.length > 0 && (() => {
              // v2.58.0 (ADR 0016): pick the rendered ranking set from the
              // active ENGINE tab.
              //
              // The v2.5.0 "Platform unknown" tail section is gone. Every row
              // now carries an engine — `'unknown'` when nobody recorded it —
              // and on production that is the MAJORITY of rows (the AtGames
              // ambiguity). Demoting them below a handful of tagged rows would
              // bury most of the leaderboard under a second heading and
              // renumber it, for a distinction the "Unspecified" tab already
              // makes on demand. One list, one rank sequence.
              const baseRankings = selectedEngine ? (filteredRankings ?? []) : leaderboard.rankings;
              const tagged = baseRankings;
              const untagged: RankedEntry[] = [];
              const renderRow = (entry: RankedEntry, displayRank: number) => {
                const hasMultiple = scoreCounts[entry.iscored_username.toLowerCase()] > 1;
                const isHighlighted = !!highlightName && entry.iscored_username.toLowerCase() === highlightName;
                return (
                    /* v2.2.0 fix: discord_user_id is "SYSTEM" / "ANON" / "COMMUNITY"
                       for guest submissions, so two anon players collide on the
                       React key and the reconciler drops a row. rank+username is
                       always unique within a leaderboard. */
                    <div key={`${displayRank}-${entry.iscored_username.toLowerCase()}`}>
                      <div
                        ref={isHighlighted ? highlightRowRef : undefined}
                        className={`flex items-center justify-between px-5 py-3 border-b border-border/20 last:border-0 ${
                          displayRank === 1 ? 'bg-neon-amber/8' : ''
                        } ${hasMultiple ? 'cursor-pointer hover:bg-raised/50 transition-colors' : ''} ${isHighlighted ? 'ring-2 ring-inset ring-neon-cyan/60 bg-neon-cyan/5' : ''}`}
                        onClick={hasMultiple ? () => togglePlayerHistory(entry.iscored_username) : undefined}
                        role={hasMultiple ? 'button' : undefined}
                        tabIndex={hasMultiple ? 0 : undefined}
                        aria-expanded={hasMultiple ? expandedPlayer === entry.iscored_username : undefined}
                        onKeyDown={hasMultiple ? (e) => {
                          // m3: ignore keydowns that bubbled up from a focused
                          // child (e.g. the player-name Link) — only the row
                          // itself being focused should toggle on Enter/Space.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            togglePlayerHistory(entry.iscored_username);
                          }
                        } : undefined}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`font-display font-bold w-8 text-center flex-shrink-0 ${
                            displayRank === 1 ? 'text-neon-amber text-lg' :
                            displayRank === 2 ? 'text-neon-cyan' :
                            displayRank === 3 ? 'text-neon-green' :
                            'text-faint'
                          }`}>
                            {displayRank}
                          </span>
                          {/* v2.13.16: PlayerNameLink opens quick-view modal on
                              click; modifier-click falls through to full page. */}
                          <PlayerNameLink
                            slug={slug || ''}
                            entry={entry}
                            fromTab={fromTab}
                            onClick={e => e.stopPropagation()}
                            className="font-medium truncate no-underline text-primary hover:text-neon-cyan transition-colors"
                          />
                          {/* v2.58.0 (ADR 0016): engine + device tags. Shown in
                              the "All" view; inside an engine tab every row
                              shares the engine, so only the DEVICE half still
                              distinguishes rows — ProvenanceTags is given just
                              that half there rather than repeating the engine
                              on every line. */}
                          <ProvenanceTags entry={entry} omitEngine={!!selectedEngine} />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`font-display font-bold flex-shrink-0 ${
                            displayRank === 1 ? 'text-neon-amber text-lg' : 'text-primary'
                          }`}>
                            {entry.score.toLocaleString()}
                          </span>
                          {hasMultiple && (
                            expandedPlayer === entry.iscored_username
                              ? <Minus size={14} className="text-neon-cyan" />
                              : <Plus size={14} className="text-faint" />
                          )}
                        </div>
                      </div>
                      {expandedPlayer === entry.iscored_username && (
                        <div className="bg-deep/50 border-b border-border/20 px-5 py-3">
                          {historyLoading ? (
                            <p className="text-faint text-xs py-2">Loading history...</p>
                          ) : playerHistory.length > 0 ? (
                            (() => {
                              // v2.1.0: split the history into "This tournament" +
                              // "All time" when there's an active tournament linked
                              // to any of this player's scores. Progression
                              // sparkline shows every submission in chronological
                              // order so improvement is visible at a glance.
                              const activeEntries = playerHistory.filter(h => h.tournament_active === 1);
                              const otherEntries = playerHistory.filter(h => h.tournament_active !== 1);
                              const chron = [...playerHistory].sort(
                                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                              );
                              const activeTournamentName = activeEntries[0]?.tournament_name || null;
                              // v-trophy-case: percentile within the game's full (unfiltered)
                              // rankings array — computed from data already loaded on `leaderboard`,
                              // not the platform-filtered `baseRankings` used for on-screen numbering.
                              const totalRankings = leaderboard?.rankings.length ?? 0;
                              return (
                                <div className="space-y-3">
                                  {chron.length > 1 && (
                                    <div>
                                      <p className="text-faint text-[10px] uppercase tracking-wider mb-1">Progression</p>
                                      <Sparkline data={chron.map(h => h.score)} width={400} height={40} />
                                    </div>
                                  )}
                                  {totalRankings >= 2 && (
                                    <p className="text-faint text-[10px] uppercase tracking-wider">
                                      Top {Math.ceil((entry.rank / totalRankings) * 100)}% of {totalRankings} players
                                    </p>
                                  )}
                                  {activeEntries.length > 0 && (
                                    <div>
                                      <p className="text-neon-cyan text-[10px] uppercase tracking-wider mb-1">
                                        This tournament{activeTournamentName ? ` · ${activeTournamentName}` : ''}
                                      </p>
                                      <div className="space-y-1">
                                        {activeEntries.map(h => (
                                          <ScoreHistoryRow
                                            key={h.id}
                                            h={h}
                                            canDelete={canDeleteScoreHistory(h)}
                                            onDelete={() => handleDeleteScoreHistory(h)}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {otherEntries.length > 0 && (
                                    <div>
                                      <p className="text-faint text-[10px] uppercase tracking-wider mb-1">
                                        {activeEntries.length > 0 ? 'All time' : 'Score history'}
                                      </p>
                                      <div className="space-y-1">
                                        {otherEntries.map(h => (
                                          <ScoreHistoryRow
                                            key={h.id}
                                            h={h}
                                            canDelete={canDeleteScoreHistory(h)}
                                            onDelete={() => handleDeleteScoreHistory(h)}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()
                          ) : (
                            <p className="text-faint text-xs py-2">No score history recorded yet.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
              };

              return (
                <div className="mb-8">
                  <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">
                    {leaderboard?.gameStatus === 'ROOM' ? 'All-Time Leaderboard' : 'Current Leaderboard'}
                  </h2>
                  {/* v2.58.0 (ADR 0016): engine-stratified tabs. Hidden when the
                      game has ≤1 distinct engine across submitted scores —
                      degrades cleanly to the single-table view.

                      Built from `distinctEngines`, the SAME field the `?engine=`
                      filter queries, so a tab can no longer be labelled from
                      one column and then match zero rows in another. */}
                  {distinctEngines.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {/* s20: outer button carries the ≥44px hit area; inner span keeps the
                          original compact pill visual (same outer/inner split as the
                          Scoreboard.tsx submit button). */}
                      <button
                        type="button"
                        onClick={() => setSelectedEngine(null)}
                        aria-pressed={selectedEngine === null}
                        className="min-h-11 min-w-11 inline-flex items-center justify-center cursor-pointer"
                      >
                        <span className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                          selectedEngine === null
                            ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                            : 'border-border text-muted hover:text-primary hover:border-border/80'
                        }`}>
                          All
                        </span>
                      </button>
                      {distinctEngines.map(e => {
                        const category = getEngineCategoryLabel(e);
                        return (
                          <button
                            key={e}
                            type="button"
                            onClick={() => setSelectedEngine(e)}
                            aria-pressed={selectedEngine === e}
                            /* The unspecified bucket is a real tab, not a
                               footnote — it is the majority of production
                               scores — but its title says why it has no
                               fidelity category rather than implying one. */
                            title={category
                              ? `${getEngineDisplay(e)} — ${category}`
                              : 'Provenance was never recorded for these scores'}
                            className="min-h-11 min-w-11 inline-flex items-center justify-center cursor-pointer"
                          >
                            <span className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                              selectedEngine === e
                                ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                                : 'border-border text-muted hover:text-primary hover:border-border/80'
                            }`}>
                              {getEngineDisplay(e)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                      <div className="flex items-center gap-3">
                        <span className="w-8 text-center">Rank</span>
                        <span>Player</span>
                      </div>
                      <span>Score</span>
                    </div>
                    {tagged.length === 0 && untagged.length === 0 ? (
                      <p className="text-muted text-sm text-center py-6">
                        {/* Was interpolating the raw id — "No scores yet on
                            pinball_fx_classic." Uses the human label now. */}
                        {selectedEngine ? `No scores yet on ${getEngineDisplay(selectedEngine)}.` : 'No scores yet.'}
                      </p>
                    ) : (
                      <>{tagged.map((entry, i) => renderRow(entry, i + 1))}</>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Record Holder */}
            {stats?.allTimeHighPlayer && (
              <div className="bg-surface border border-neon-amber/30 rounded-lg p-5 mb-8 text-center">
                <p className="text-faint text-xs uppercase tracking-wider mb-1">All-Time Record Holder</p>
                <p className="font-display text-xl font-bold text-neon-amber">{stats.allTimeHighPlayer}</p>
                <p className="text-muted text-sm">{stats.allTimeHigh.toLocaleString()} points</p>
              </div>
            )}

            {/* Past Results */}
            {stats && stats.recentResults.length > 0 && (
              <div>
                <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Past Results</h2>
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                  {stats.recentResults.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between px-5 py-3 border-b border-border/30 last:border-0"
                    >
                      <div>
                        <p className="font-medium">{r.tournament_name}</p>
                        <p className="text-faint text-xs">
                          {r.end_date ? new Date(r.end_date).toLocaleDateString() : 'In progress'}
                        </p>
                      </div>
                      <div className="text-right">
                        {r.winner_name ? (
                          <>
                            <p className="text-neon-green text-sm font-medium">{r.winner_name}</p>
                            <p className="font-display font-bold text-neon-amber">
                              {r.winner_score?.toLocaleString() ?? '--'}
                            </p>
                          </>
                        ) : (
                          <p className="text-faint text-sm">No winner</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Full Score History */}
            <div className="mt-8">
              <button
                onClick={loadGameHistory}
                className="flex items-center gap-2 text-sm text-muted hover:text-primary transition-colors"
              >
                <History size={14} />
                {showGameHistory ? 'Hide' : 'Show'} All Score History
                {showGameHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {showGameHistory && (
                <div className="mt-3 bg-surface border border-border rounded-lg overflow-hidden">
                  {gameHistory.length > 0 ? (
                    <>
                      <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                        <span>Player</span>
                        <div className="flex items-center gap-6">
                          <span>Source</span>
                          <span className="w-20 text-right">Score</span>
                          <span className="w-20 text-right">Date</span>
                        </div>
                      </div>
                      {gameHistory.map(h => (
                        <div key={h.id} className="flex items-center justify-between px-5 py-2.5 border-b border-border/20 last:border-0 text-sm">
                          <span className="font-medium truncate">{h.display_name || h.iscored_username}</span>
                          <div className="flex items-center gap-6">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              h.source === 'tournament' ? 'bg-neon-cyan/10 text-neon-cyan' :
                              h.source === 'sync' ? 'bg-neon-purple/10 text-neon-purple' :
                              'bg-neon-green/10 text-neon-green'
                            }`}>{h.source}</span>
                            <span className="font-display font-bold w-20 text-right">{h.score.toLocaleString()}</span>
                            <span className="text-faint text-xs w-20 text-right">{new Date(h.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className="text-muted text-sm text-center py-6">No score history recorded for this game.</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'community' && (
          <>
            {/* Submit Score */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-sm text-muted uppercase tracking-wider">Community Scores</h2>
                <button
                  onClick={() => setSubmissionOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-neon-green/15 border border-neon-green/40 text-neon-green rounded-lg text-xs font-medium hover:bg-neon-green/25 transition-colors"
                >
                  <Plus size={14} />
                  Submit Score
                </button>
              </div>
            </div>

            {/* Community Leaderboard */}
            {communityBoard.length > 0 ? (
              <div className="mb-8">
                <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Best Scores</h2>
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                    <div className="flex items-center gap-3">
                      <span className="w-8 text-center">#</span>
                      <span>Player</span>
                    </div>
                    <div className="flex items-center gap-6">
                      <span>Plays</span>
                      <span className="w-20 text-right">Best</span>
                    </div>
                  </div>
                  {communityBoard.map((entry, i) => (
                    <div
                      key={entry.player_key ?? entry.iscored_username}
                      className={`flex items-center justify-between px-5 py-3 border-b border-border/20 last:border-0 ${
                        i === 0 ? 'bg-neon-amber/8' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`font-display font-bold w-8 text-center flex-shrink-0 ${
                          i === 0 ? 'text-neon-amber' : i === 1 ? 'text-neon-cyan' : i === 2 ? 'text-neon-green' : 'text-faint'
                        }`}>
                          {i + 1}
                        </span>
                        <span className="font-medium truncate">{entry.display_name || entry.iscored_username}</span>
                      </div>
                      <div className="flex items-center gap-6">
                        <span className="text-muted text-sm">{entry.times_played}</span>
                        <span className={`font-display font-bold w-20 text-right ${i === 0 ? 'text-neon-amber' : 'text-primary'}`}>
                          {entry.best_score.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-surface border border-border rounded-lg p-8 text-center mb-8">
                <p className="text-muted">No community scores yet. Be the first to submit!</p>
              </div>
            )}

            {/* Recent Submissions */}
            {communityHistory.length > 0 && (
              <div>
                <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Recent Submissions</h2>
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                  {communityHistory.slice(0, 10).map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between px-5 py-3 border-b border-border/20 last:border-0"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-medium truncate">{entry.display_name || entry.iscored_username}</span>
                        <span className="flex items-center gap-1 text-faint text-xs">
                          <Clock size={12} />
                          {new Date(entry.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <span className="font-display font-bold text-primary">{entry.score.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'tips' && (
          <>
            {/* Post a comment/tip */}
            <div className="bg-surface border border-border rounded-lg p-4 mb-6">
              <form onSubmit={handleSubmitComment}>
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    placeholder="Your name"
                    value={commentDisplayName}
                    onChange={e => setCommentDisplayName(e.target.value)}
                    className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50 w-40"
                  />
                  <select
                    value={commentType}
                    onChange={e => setCommentType(e.target.value as 'comment' | 'tip')}
                    className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
                  >
                    <option value="comment">Comment</option>
                    <option value="tip">Pro Tip</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={commentType === 'tip' ? 'Share a pro tip...' : 'Leave a comment...'}
                    value={commentBody}
                    onChange={e => setCommentBody(e.target.value)}
                    maxLength={500}
                    className="flex-1 bg-raised border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
                  />
                  <button
                    type="submit"
                    disabled={!commentDisplayName.trim() || !commentBody.trim() || commentSubmitting}
                    className="px-4 py-2 bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan rounded-lg text-sm font-medium hover:bg-neon-cyan/25 transition-colors disabled:opacity-40"
                  >
                    Post
                  </button>
                </div>
              </form>
            </div>

            {/* Pro Tips */}
            {tips.length > 0 && (
              <div className="mb-6">
                <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Lightbulb size={14} className="text-neon-amber" /> Pro Tips
                </h2>
                <div className="space-y-2">
                  {tips.map(tip => (
                    <div key={tip.id} className="bg-surface border border-neon-amber/20 rounded-lg px-4 py-3 flex items-start gap-3">
                      <Lightbulb size={16} className="text-neon-amber flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-primary">{tip.body}</p>
                        <p className="text-xs text-faint mt-1">
                          {tip.display_name} &middot; {new Date(tip.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isOwnComment(tip) && (
                          <button onClick={() => handleDeleteComment(tip.id)} className="text-faint hover:text-neon-coral transition-colors">
                            <Trash2 size={14} />
                          </button>
                        )}
                        {!!viewerClaims?.discordId && !isOwnComment(tip) && (
                          <button onClick={() => setFlagTarget(tip)} title="Report this tip" className="text-faint hover:text-neon-magenta transition-colors">
                            <Flag size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            <div>
              <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
                <MessageCircle size={14} className="text-neon-cyan" /> Comments
              </h2>
              {comments.length > 0 ? (
                <div className="space-y-2">
                  {comments.map(comment => (
                    <div key={comment.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-primary">{comment.display_name}</span>
                          <span className="text-xs text-faint">{new Date(comment.created_at).toLocaleDateString()}</span>
                        </div>
                        <p className="text-sm text-muted">{comment.body}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isOwnComment(comment) && (
                          <button onClick={() => handleDeleteComment(comment.id)} className="text-faint hover:text-neon-coral transition-colors">
                            <Trash2 size={14} />
                          </button>
                        )}
                        {!!viewerClaims?.discordId && !isOwnComment(comment) && (
                          <button onClick={() => setFlagTarget(comment)} title="Report this comment" className="text-faint hover:text-neon-magenta transition-colors">
                            <Flag size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted text-sm text-center py-8">No comments yet. Be the first!</p>
              )}
            </div>
          </>
        )}

        {flagTarget && (
          <ReportContentModal
            title={flagTarget.type === 'tip' ? 'Report this tip' : 'Report this comment'}
            targetLabel={`"${flagTarget.body}" — ${flagTarget.display_name}`}
            endpoint={`/global/comments/${flagTarget.id}/report`}
            onClose={() => setFlagTarget(null)}
          />
        )}

        {activeTab === 'player-stats' && (
          <div className="space-y-6">
            {/* Top Players */}
            {gamePlayerRankings.length > 0 && (
              <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50">
                  <h3 className="font-display font-bold text-sm text-primary">Top Players</h3>
                </div>
                <div className="divide-y divide-border/20">
                  {gamePlayerRankings.map(p => (
                    <button
                      key={p.iscored_username}
                      onClick={() => lookupPlayer(p.iscored_username)}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-raised/50 transition-colors cursor-pointer text-left"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                          p.rank === 1 ? 'text-neon-amber' :
                          p.rank === 2 ? 'text-neon-cyan' :
                          p.rank === 3 ? 'text-neon-green' :
                          'text-faint'
                        }`}>
                          {p.rank}
                        </span>
                        <span className={`text-sm truncate ${playerName === p.iscored_username && playerStats ? 'text-neon-cyan font-medium' : 'text-primary'}`}>
                          {p.display_name || p.iscored_username}
                        </span>
                      </div>
                      <span className={`font-display font-bold text-sm flex-shrink-0 ${
                        p.rank === 1 ? 'text-neon-amber' : 'text-primary'
                      }`}>
                        {p.best_score.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Player Lookup */}
            <div className="bg-surface border border-border rounded-lg p-5">
              <h3 className="font-display font-bold text-sm text-primary mb-3">Player Lookup</h3>
              <form onSubmit={e => { e.preventDefault(); lookupPlayer(); }} className="flex gap-2 mb-4">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                  <input
                    type="text"
                    placeholder="Enter a player name..."
                    value={playerName}
                    onChange={e => setPlayerName(e.target.value)}
                    className="w-full bg-raised border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!playerName.trim() || playerLoading}
                  className="px-4 py-2 bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan rounded-lg text-sm font-medium hover:bg-neon-cyan/25 transition-colors disabled:opacity-40 cursor-pointer"
                >
                  {playerLoading ? 'Loading...' : 'Look Up'}
                </button>
              </form>

              {playerError && (
                <p className="text-neon-coral text-sm">{playerError}</p>
              )}

              {playerStats && (
                <div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    <MiniStat icon={<Target size={14} />} label="Times Played" value={playerStats.times_played.toString()} />
                    <MiniStat icon={<Medal size={14} />} label="Avg Rank" value={`#${playerStats.avg_rank}`} />
                    <MiniStat icon={<Trophy size={14} />} label="Wins" value={playerStats.wins.toString()} />
                    <MiniStat icon={<TrendingUp size={14} />} label="Personal Best" value={playerStats.best_score.toLocaleString()} />
                  </div>

                  {/* Score trend chart */}
                  {playerStats.trend.length >= 2 && (
                    <div className="pt-3 border-t border-border/30 mb-4">
                      <span className="text-faint text-[10px] uppercase tracking-wider block mb-2">Score Trend</span>
                      <div className="bg-raised/50 rounded-lg p-3">
                        <Sparkline data={playerStats.trend.map(t => t.score)} width={400} height={80} />
                      </div>
                      <div className="flex justify-between text-[10px] text-faint mt-1 px-1">
                        <span>{playerStats.trend[0]?.date ? new Date(playerStats.trend[0].date).toLocaleDateString() : ''}</span>
                        <span>{playerStats.trend[playerStats.trend.length - 1]?.date ? new Date(playerStats.trend[playerStats.trend.length - 1].date).toLocaleDateString() : ''}</span>
                      </div>
                    </div>
                  )}

                  {/* Score history with dates */}
                  {playerScoreHistory.length > 0 && (
                    <div className="pt-3 border-t border-border/30">
                      <h3 className="text-faint text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <History size={12} /> Score History
                      </h3>
                      <div className="space-y-1">
                        {playerScoreHistory.map(h => (
                          <div key={h.id} className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className="font-display font-bold text-primary">{h.score.toLocaleString()}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                h.source === 'tournament' ? 'bg-neon-cyan/10 text-neon-cyan' :
                                h.source === 'sync' ? 'bg-neon-purple/10 text-neon-purple' :
                                'bg-neon-green/10 text-neon-green'
                              }`}>{h.source}</span>
                            </div>
                            <span className="text-faint text-xs">{new Date(h.created_at).toLocaleDateString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Show trend data as history fallback when score_history is empty */}
                  {playerScoreHistory.length === 0 && playerStats.trend.length > 0 && (
                    <div className="pt-3 border-t border-border/30">
                      <h3 className="text-faint text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <History size={12} /> Tournament History
                      </h3>
                      <div className="space-y-1">
                        {playerStats.trend.map((t, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className="font-display font-bold text-primary">{t.score.toLocaleString()}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan">#{t.rank}</span>
                            </div>
                            <span className="text-faint text-xs">{t.date ? new Date(t.date).toLocaleDateString() : '--'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!playerStats && !playerError && !playerLoading && (
                <p className="text-muted text-sm text-center py-4">
                  {gamePlayerRankings.length > 0
                    ? 'Click a player above or search by name to view their stats.'
                    : 'Enter a player name to look up their stats for this game.'}
                </p>
              )}
            </div>
          </div>
        )}

        {/* About this game — catalogue metadata (Table Authors, Downloads,
            Tutorials, References). Sits below tab content on every tab;
            hidden entirely when the room game has no catalogue mapping or
            the fetch failed. Mirrors GlobalGameDetail's block rendering,
            restyled to match this page's existing section conventions. */}
        {catalogueGame && (
          catalogueGame.manufacturer ||
          catalogueGame.year ||
          catalogueGame.themes.length > 0 ||
          catalogueGame.designers.length > 0 ||
          catalogueGame.table_authors.length > 0 ||
          catalogueGame.table_download_urls.length > 0 ||
          catalogueGame.tutorial_urls.length > 0 ||
          catalogueGame.rules_urls.length > 0 ||
          catalogueGame.ipdb_url
        ) && (
          <div className="mt-8 pt-8 border-t border-border">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">About This Game</h2>

            <div className="bg-surface border border-border rounded-lg p-5 mb-4">
              <p className="text-sm text-muted">
                {[
                  catalogueGame.manufacturer,
                  catalogueGame.year ? String(catalogueGame.year) : null,
                  catalogueGame.type ? catalogueGame.type.charAt(0).toUpperCase() + catalogueGame.type.slice(1) : null,
                ].filter(Boolean).join(' · ')}
              </p>
              {catalogueGame.themes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {catalogueGame.themes.map(t => (
                    <span key={t} className="px-2 py-0.5 text-xs rounded bg-raised border border-border text-muted">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {catalogueGame.designers.length > 0 && (
                <p className="text-xs text-faint mt-3">
                  <span className="uppercase tracking-wider">Designers:</span> {catalogueGame.designers.join(', ')}
                </p>
              )}
            </div>

            {catalogueGame.table_authors.length > 0 && (
              <div className="bg-surface border border-border rounded-lg p-4 mb-4">
                <div className="text-faint text-[10px] uppercase tracking-wider mb-2">Table Authors</div>
                <div className="text-sm text-primary">{catalogueGame.table_authors.join(', ')}</div>
              </div>
            )}

            {catalogueGame.table_download_urls.length > 0 && (
              <div className="mb-4">
                <h3 className="text-faint text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Download size={12} /> Downloads
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {catalogueGame.table_download_urls.map((dl, i) => (
                    <a
                      key={i}
                      href={dl.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:border-neon-cyan text-sm text-primary no-underline transition-colors"
                    >
                      <span className="truncate">
                        {dl.format || 'Download'}
                        {dl.version ? ` · v${dl.version}` : ''}
                      </span>
                      <ExternalLink size={12} className="flex-shrink-0 text-faint" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {catalogueGame.tutorial_urls.length > 0 && (
              <div className="mb-4">
                <h3 className="text-faint text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Play size={12} /> Tutorials
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {catalogueGame.tutorial_urls.map((t, i) => {
                    const href = t.youtubeId ? `https://www.youtube.com/watch?v=${t.youtubeId}` : t.url;
                    if (!href) return null;
                    return (
                      <a
                        key={i}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:border-neon-cyan text-sm text-primary no-underline transition-colors"
                      >
                        <Play size={14} className="text-faint flex-shrink-0" />
                        <span className="truncate">{t.title || href}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {(catalogueGame.rules_urls.length > 0 || catalogueGame.ipdb_url) && (
              <div className="mb-4">
                <h3 className="text-faint text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <BookOpen size={12} /> References
                </h3>
                <div className="flex flex-col gap-1.5">
                  {catalogueGame.ipdb_url && (
                    <a
                      href={catalogueGame.ipdb_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-neon-cyan hover:underline w-fit"
                    >
                      <ExternalLink size={12} /> IPDB
                    </a>
                  )}
                  {catalogueGame.rules_urls.map((r, i) => (
                    <a
                      key={i}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-neon-cyan hover:underline w-fit"
                    >
                      <ExternalLink size={12} /> {r.version ? `Rules v${r.version}` : 'Rules sheet'}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* v2.25.0 report-a-problem — gated on the catalogue mapping (reports
            file against the global entry). Discord login handled in-modal. */}
        {leaderboard?.globalGameId && (
          <div className="mt-6 text-right">
            <button
              onClick={() => setReportOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs text-faint hover:text-muted transition-colors cursor-pointer"
            >
              <Flag size={12} /> Report a problem with this game's info
            </button>
          </div>
        )}
      </main>

      {pendingDeleteEntry && (
        <ConfirmModal
          title="Delete score"
          message={`Delete this score (${pendingDeleteEntry.score.toLocaleString()})?`}
          confirmLabel="Delete"
          onConfirm={() => {
            const entry = pendingDeleteEntry;
            setPendingDeleteEntry(null);
            performDeleteScoreHistory(entry);
          }}
          onCancel={() => setPendingDeleteEntry(null)}
        />
      )}

      {reportOpen && leaderboard?.globalGameId && (
        <ReportProblemModal
          globalGameId={leaderboard.globalGameId}
          gameName={stats?.gameName || name || ''}
          playerToken={playerToken}
          onClose={() => setReportOpen(false)}
        />
      )}

      {/* v2.0.1: Community Submit flow now uses unified SubmissionSheet
          (photo support + anon-claim prompt + login gate + OAuth draft). */}
      {submissionOpen && roomId && name && (
        <SubmissionSheet
          target={{
            kind: 'tournament',
            roomId,
            gameName: name,
            gameStatus: leaderboard?.gameStatus,
            requirePhoto,
          }}
          roomSlug={slug}
          requireLogin={requireLogin}
          discordOnly={discordOnlyLogin}
          discordEnabled={discordEnabled}
          onClose={() => setSubmissionOpen(false)}
          onSubmitted={() => {
            setSubmissionOpen(false);
            if (roomId && name) loadCommunityData(roomId, name);
          }}
        />
      )}
    </div>
  );
}

/** v2.1.0 — one row in the expanded score-history view. Keeps the visual
    consistent between "This tournament" + "All time" groupings. Trash icon
    appears when `canDelete` is true (admin viewing any row, or player viewing
    their own row); kept hover-only to avoid visual noise on the common case. */
function ScoreHistoryRow({ h, canDelete, onDelete }: {
  h: ScoreHistoryEntry;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm group">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted">{h.score.toLocaleString()}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          h.source === 'tournament' ? 'bg-neon-cyan/10 text-neon-cyan' :
          h.source === 'sync' ? 'bg-neon-purple/10 text-neon-purple' :
          'bg-neon-green/10 text-neon-green'
        }`}>{h.source}</span>
        {h.photo_url && (
          <a href={h.photo_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-neon-cyan/70 hover:text-neon-cyan no-underline" title="View proof">
            proof
          </a>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-faint text-xs whitespace-nowrap">{new Date(h.created_at).toLocaleDateString()}</span>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="p-4 -m-2 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-red-400/60 hover:text-red-400 transition-all cursor-pointer"
            title="Delete this score"
            aria-label="Delete this score"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  // Auto-shrink font for long values to fit within card width
  const fontSize = value.length > 13 ? 'text-sm' : value.length > 10 ? 'text-base' : value.length > 7 ? 'text-xl' : 'text-2xl';
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display font-bold ${fontSize} ${color}`}>{value}</p>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-raised border border-border/50 rounded-lg p-3 text-center">
      <div className="flex items-center justify-center gap-1 text-faint mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="font-display font-bold text-lg text-primary">{value}</p>
    </div>
  );
}
