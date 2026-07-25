import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Trophy, Upload, Download, BookOpen, Play, ExternalLink, Flag, MessageSquare, Lightbulb, Trash2 } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import StarRating from '../components/StarRating';
import LoadingState from '../components/LoadingState';
import SubmissionSheet from '../components/SubmissionSheet';
import ReportProblemModal from '../components/ReportProblemModal';
import ConfirmModal from '../components/ConfirmModal';
import RoomTag from '../components/RoomTag';
import UserMenu from '../components/UserMenu';
import LoginButtons from '../components/LoginButtons';
import { getPlatformDisplay } from '../lib/platforms';
import { formatScore } from '../lib/format';
import { getPortal } from '../lib/portal';
import { requiresAnyLogin, requiresDiscordOnly } from '../lib/loginPolicy';

interface GlobalGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  subtype: string | null;
  platforms: string[];
  themes: string[];
  designers: string[];
  players: number | null;
  image_url: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  opdb_id: string | null;
  vps_id: string | null;
  igdb_id: number | null;
  ipdb_url: string | null;
  external_url: string | null;
  description: string | null;
  features: string[];
  table_authors: string[];
  table_download_urls: Array<{ format?: string; url: string; version?: string }>;
  tutorial_urls: Array<{ title?: string; youtubeId?: string; url?: string }>;
  rules_urls: Array<{ url: string; version?: string }>;
}

interface RankingEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. Renders in place of iscored_username when set. */
  display_name?: string | null;
  score: number;
  photo_url: string | null;
  submitted_at: string;
  origin_type: string;
  origin_game_room_id: string | null;
  origin_room_name: string | null;
  origin_room_slug: string | null;
  origin_room_logo_url: string | null;
  /** Sprint 13 — admin-set short label; falls back to slug-derived when null. */
  origin_room_short_tag: string | null;
  avatar_hash: string | null;
  score_id: string;
  /** v2.5.1 — per-row platform stamp; null for legacy multi-platform rows. */
  platform: string | null;
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

interface GlobalComment {
  id: number;
  discord_user_id: string;
  display_name: string;
  type: 'comment' | 'tip';
  body: string;
  created_at: string;
  avatar_hash?: string | null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  // DB stores filesystem paths like "data/catalogue-images/opdb/foo.jpg".
  // The server mounts the catalogue-images directory at /api/catalogue-images/.
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function resolveImage(game: GlobalGame): string | null {
  if (game.local_image_path) return toCatalogueUrl(game.local_image_path);
  if (game.image_url) return game.image_url;
  return null;
}

function resolveWheel(game: GlobalGame): string | null {
  if (!game.wheel_image_path) return null;
  return toCatalogueUrl(game.wheel_image_path);
}

export default function GlobalGameDetail() {
  const { globalGameId } = useParams<{ globalGameId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromSlug = searchParams.get('from');
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
  const [game, setGame] = useState<GlobalGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [scope, setScope] = useState<string>('global');
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [rankingsLoading, setRankingsLoading] = useState(false);
  // Pagination: 20 per page, server-side slicing via offset/limit.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [showSubmit, setShowSubmit] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportMessage, setReportMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  // s20: confirm-before-delete for self-delete score, replacing native confirm().
  const [pendingDeleteScoreId, setPendingDeleteScoreId] = useState<string | null>(null);
  // v2.0.1: when navigated with ?from=<slug>, treat the Submit as a room-scoped
  // freeplay submission (respects the room's REQUIRE_DISCORD_LOGIN) rather than
  // a direct global submission (which always requires Discord login).
  const [fromRoom, setFromRoom] = useState<{ id: string; requireLogin: boolean; discordOnly: boolean; discordEnabled: boolean } | null>(null);

  // Rating state
  const [ratingInfo, setRatingInfo] = useState<{ avg_rating: number; rating_count: number; user_rating: number | null } | null>(null);

  // Comments state
  const [tips, setTips] = useState<GlobalComment[]>([]);
  const [comments, setComments] = useState<GlobalComment[]>([]);
  const [commentTab, setCommentTab] = useState<'tips' | 'comments'>('tips');
  const [commentBody, setCommentBody] = useState('');
  const [commentDisplayName, setCommentDisplayName] = useState(() => localStorage.getItem('arcaid-player-name') || '');
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // Fetch game detail
  useEffect(() => {
    if (!globalGameId) return;
    setLoading(true);
    setNotFound(false);
    fetch(`/api/global/games/${globalGameId}`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then((data: GlobalGame | null) => {
        if (data) setGame(data);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [globalGameId]);

  // Fetch room list for the scope filter
  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.ok ? r.json() : [])
      .then((data: Room[]) => setRooms((data || []).filter(r => r.is_public)))
      .catch(() => {});
  }, []);

  // v2.0.1 — when opened with ?from=<slug>, fetch the room so Submit can
  // resolve to a freeplay target with that room's login requirement.
  useEffect(() => {
    if (!fromSlug) { setFromRoom(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const p = await getPortal(fromSlug);
        const roomId = p.roomId;
        const cfgRes = await fetch(`/api/rooms/${roomId}/scoreboard-config`);
        const cfg = cfgRes.ok ? await cfgRes.json() as Record<string, string> : {};
        if (cancelled) return;
        setFromRoom({
            id: roomId,
            requireLogin: requiresAnyLogin(cfg.REQUIRE_DISCORD_LOGIN),
            discordOnly: requiresDiscordOnly(cfg.REQUIRE_DISCORD_LOGIN),
            discordEnabled: cfg.DISCORD_ENABLED !== 'false',
        });
      } catch { /* ignore — fall back to global */ }
    })();
    return () => { cancelled = true; };
  }, [fromSlug]);

  // Sprint 12 — sync scope with ?room=<slug> for shareable room-filtered views.
  // Default behavior: when navigated with ?from=<slug> and no ?room= param,
  // default scope to that room (the user just clicked a card on that room's
  // scoreboard; they expect to see *that room's* numbers). Picking "All rooms
  // (global)" from the dropdown writes ?room=global as an explicit sentinel so
  // the choice survives URL sharing and doesn't auto-revert to the from-room.
  useEffect(() => {
    const slug = searchParams.get('room');
    if (slug === 'global') {
      if (scope !== 'global') setScope('global');
      return;
    }
    if (!slug) {
      // No explicit ?room=. If we have a ?from=<slug> AND that room has been
      // resolved, default to it. Otherwise fall back to global.
      if (fromRoom && scope !== fromRoom.id) { setScope(fromRoom.id); return; }
      if (!fromSlug && scope !== 'global') setScope('global');
      return;
    }
    if (rooms.length === 0) return;
    const match = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
    if (match && scope !== match.id) setScope(match.id);
  }, [searchParams, rooms, fromRoom, fromSlug]);

  const setScopeFromSlug = (slug: string | null) => {
    const next = new URLSearchParams(searchParams);
    // null = user picked "All rooms (global)" from the dropdown. Write the
    // explicit sentinel so it overrides the from-room default.
    if (slug) next.set('room', slug);
    else next.set('room', 'global');
    setSearchParams(next, { replace: true });
  };
  const selectScopeFromRoomId = (roomId: string) => {
    const room = rooms.find(r => r.id === roomId);
    if (room) setScopeFromSlug(room.slug);
    else setScope(roomId);
  };

  // Reset to page 0 whenever scope or game changes; the page-aware fetch effect
  // below will re-run because `page` flips back to 0.
  useEffect(() => { setPage(0); }, [globalGameId, scope]);

  // Fetch leaderboard whenever game, scope, or page changes
  useEffect(() => {
    if (!globalGameId) return;
    setRankingsLoading(true);
    const offset = page * PAGE_SIZE;
    fetch(`/api/global/scoreboard/${globalGameId}?scope=${scope}&limit=${PAGE_SIZE}&offset=${offset}`)
      .then(r => r.ok ? r.json() : { data: [], total: 0 })
      .then(payload => {
        setRankings(payload.data || []);
        setTotal(typeof payload.total === 'number' ? payload.total : (payload.data || []).length);
      })
      .catch(() => { setRankings([]); setTotal(0); })
      .finally(() => setRankingsLoading(false));
  }, [globalGameId, scope, page]);

  // Fetch rating
  useEffect(() => {
    if (!globalGameId) return;
    const headers: HeadersInit = {};
    if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;
    fetch(`/api/global/games/${globalGameId}/rating`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setRatingInfo(data); })
      .catch(() => {});
  }, [globalGameId, playerToken]);

  // Fetch comments and tips
  const loadComments = (id: string) => {
    fetch(`/api/global/games/${id}/comments?type=tip`)
      .then(r => r.ok ? r.json() : []).then(setTips).catch(() => {});
    fetch(`/api/global/games/${id}/comments?type=comment`)
      .then(r => r.ok ? r.json() : []).then(setComments).catch(() => {});
  };

  useEffect(() => {
    if (globalGameId) loadComments(globalGameId);
  }, [globalGameId]);

  const handleRateGame = async (rating: number) => {
    if (!playerToken || !globalGameId) return;
    try {
      const res = await fetch(`/api/global/games/${globalGameId}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify({ rating }),
      });
      if (res.ok) {
        const info = await res.json();
        setRatingInfo(info);
      }
    } catch { /* silent */ }
  };

  const handlePostComment = async (type: 'comment' | 'tip') => {
    if (!playerToken || !globalGameId || !commentBody.trim() || !commentDisplayName.trim()) return;
    setCommentSubmitting(true);
    try {
      const name = commentDisplayName.trim();
      localStorage.setItem('arcaid-player-name', name);
      const res = await fetch(`/api/global/games/${globalGameId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify({ type, body: commentBody.trim(), display_name: name }),
      });
      if (res.ok) {
        setCommentBody('');
        loadComments(globalGameId);
      }
    } catch { /* silent */ }
    setCommentSubmitting(false);
  };

  const handleDeleteComment = async (commentId: number) => {
    if (!playerToken || !globalGameId) return;
    try {
      await fetch(`/api/global/games/${globalGameId}/comments/${commentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      loadComments(globalGameId);
    } catch { /* silent */ }
  };

  const displayName = useMemo(() => game ? (game.display_name || game.name) : '', [game]);
  const imageSrc = useMemo(() => game ? resolveImage(game) : null, [game]);
  const wheelSrc = useMemo(() => game ? resolveWheel(game) : null, [game]);

  const handleLogin = () => {
    const returnPath = fromSlug ? `/games/${globalGameId}?from=${encodeURIComponent(fromSlug)}` : `/games/${globalGameId}`;
    loginWithDiscord('__global__', returnPath);
  };

  const handleGoogleLogin = () => {
    const returnPath = fromSlug ? `/games/${globalGameId}?from=${encodeURIComponent(fromSlug)}` : `/games/${globalGameId}`;
    loginWithGoogle('__global__', returnPath);
  };

  const handleSubmitClick = () => {
    // v2.0.1 — when navigated from a room (?from=<slug>), let SubmissionSheet
    // decide whether to require login based on the room's setting. Direct
    // global submissions still need Discord auth upfront.
    if (!fromRoom && !playerToken) {
      handleLogin();
      return;
    }
    setShowSubmit(true);
  };

  const handleReport = async (scoreId: string) => {
    if (!playerToken) { handleLogin(); return; }
    const reason = window.prompt('Why are you reporting this score? (optional)');
    if (reason === null) return; // user cancelled
    setReportingId(scoreId);
    setReportMessage(null);
    try {
      const res = await fetch(`/api/global/scores/${scoreId}/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${playerToken}`,
        },
        body: JSON.stringify({ reason: reason || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to report' }));
        throw new Error(err.error || 'Failed to report');
      }
      setReportMessage({ text: 'Score reported — an admin will review it.', type: 'success' });
    } catch (err) {
      setReportMessage({ text: err instanceof Error ? err.message : 'Failed to report', type: 'error' });
    } finally {
      setReportingId(null);
      setTimeout(() => setReportMessage(null), 4000);
    }
  };

  const handleDeleteScore = (scoreId: string) => {
    if (!playerToken) return;
    setPendingDeleteScoreId(scoreId);
  };

  const performDeleteScore = async (scoreId: string) => {
    try {
      const res = await fetch(`/api/me/global-scores/${scoreId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        setReportMessage({ text: 'Score deleted.', type: 'success' });
        setTimeout(() => setReportMessage(null), 3000);
        refreshRankings();
      }
    } catch { /* silent */ }
  };

  const refreshRankings = () => {
    if (!globalGameId) return;
    // After a delete or submit, jump back to page 0 so the user lands on the
    // freshest top-of-leaderboard view; the page-driven effect will refetch.
    if (page !== 0) { setPage(0); return; }
    setRankingsLoading(true);
    fetch(`/api/global/scoreboard/${globalGameId}?scope=${scope}&limit=${PAGE_SIZE}&offset=0`)
      .then(r => r.ok ? r.json() : { data: [], total: 0 })
      .then(payload => {
        setRankings(payload.data || []);
        setTotal(typeof payload.total === 'number' ? payload.total : (payload.data || []).length);
      })
      .catch(() => {})
      .finally(() => setRankingsLoading(false));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-deep text-primary flex items-center justify-center">
        <LoadingState message="Loading game..." />
      </div>
    );
  }

  // v2.13.12 — back link respects the tab the user came from. ?tab=room /
  // ?tab=global return to those tabs; legacy ?tab=all-games maps to Room Scores;
  // absent falls back to the room's default (Tournaments).
  const fromTab = searchParams.get('tab');
  const backToRoomHref = fromSlug
    ? (fromTab === 'room' || fromTab === 'global'
        ? `/${fromSlug}?tab=${fromTab}`
        : fromTab === 'all-games' ? `/${fromSlug}?tab=room` : `/${fromSlug}`)
    : '/scoreboard';

  if (notFound || !game) {
    return (
      <div className="min-h-screen bg-deep text-primary flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-muted">Game not found.</div>
        <Link to={backToRoomHref} className="text-neon-cyan hover:underline">
          ← {fromSlug ? `Back to ${fromSlug}` : 'Back to global scoreboard'}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <Link
            to={backToRoomHref}
            className="flex items-center gap-2 text-xs text-muted hover:text-neon-cyan no-underline"
          >
            <ArrowLeft className="w-4 h-4" />
            {fromSlug ? `Back to ${fromSlug}` : 'Global Leaderboard'}
          </Link>
          <div className="flex items-center gap-3">
            {fromSlug && (
              <Link to={backToRoomHref} className="text-xs text-muted hover:text-neon-cyan no-underline hidden sm:inline">
                Leaderboard
              </Link>
            )}
            <Link to="/" className="text-xs text-muted hover:text-neon-cyan no-underline hidden sm:inline">
              Rooms
            </Link>
            {localStorage.getItem('arcaid_token') && (
              <Link to="/admin" className="text-xs text-muted hover:text-neon-amber no-underline hidden sm:inline">
                Admin
              </Link>
            )}
            {discordUser ? (
              /* v2.2.6: shared UserMenu — surfaces My Rooms / Friends / Log out here too. */
              <UserMenu user={discordUser} onLogout={logoutPlayer} />
            ) : (
              /* v2.2.7: shared Discord-brand Login button. v2.35.0: + Google. */
              <LoginButtons onDiscordLogin={handleLogin} onGoogleLogin={handleGoogleLogin} />
            )}
          </div>
        </div>
      </div>

      {/* Hero: image + title block */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 mb-8">
          <div className="relative rounded-lg border border-border bg-surface overflow-hidden aspect-square md:aspect-auto md:h-[280px]">
            {imageSrc ? (
              <img src={imageSrc} alt={displayName} className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">No image</div>
            )}
            {wheelSrc && (
              <img
                src={wheelSrc}
                alt="Wheel"
                className="absolute top-2 right-2 w-16 h-16 rounded-full border border-border bg-black/60 object-contain p-1"
              />
            )}
          </div>
          <div className="flex flex-col justify-between">
            <div>
              <h1 className="font-display text-3xl font-bold mb-1">{displayName}</h1>
              <div className="text-sm text-muted mb-3 flex items-center gap-3 flex-wrap">
                <span>
                  {game.manufacturer || 'Unknown manufacturer'}
                  {game.year ? ` · ${game.year}` : ''}
                  {game.subtype ? ` · ${game.subtype.toUpperCase()}` : ''}
                  {game.players ? ` · ${game.players}P` : ''}
                </span>
                {/* v2.25.0 report-a-problem */}
                <button
                  onClick={() => setReportOpen(true)}
                  className="inline-flex items-center gap-1 text-xs text-faint hover:text-muted transition-colors cursor-pointer"
                  title="Report wrong name, manufacturer, year, platforms or artwork"
                >
                  <Flag size={12} /> Report a problem
                </button>
              </div>
              {/* Star rating */}
              {ratingInfo && (
                <div className="flex items-center gap-2 mb-3">
                  <StarRating
                    rating={ratingInfo.user_rating || Math.round(ratingInfo.avg_rating)}
                    onRate={playerToken ? handleRateGame : undefined}
                    size="md"
                  />
                  <span className="text-sm text-muted">
                    {ratingInfo.avg_rating > 0
                      ? `${ratingInfo.avg_rating.toFixed(1)} (${ratingInfo.rating_count} ${ratingInfo.rating_count === 1 ? 'rating' : 'ratings'})`
                      : playerToken ? 'Be the first to rate!' : 'No ratings yet'}
                  </span>
                </div>
              )}
              {game.description && (
                <p className="text-sm text-muted mb-4 line-clamp-4">{game.description}</p>
              )}
              {game.platforms.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {game.platforms.map(p => (
                    <span key={p} className="px-2 py-0.5 text-xs rounded bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan">
                      {p}
                    </span>
                  ))}
                </div>
              )}
              {game.themes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {game.themes.map(t => (
                    <span key={t} className="px-2 py-0.5 text-xs rounded bg-surface border border-border text-muted">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={handleSubmitClick}
                className="flex items-center gap-2 px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10"
              >
                <Upload className="w-4 h-4" />
                Submit Your Score
              </button>
            </div>
          </div>
        </div>

        {/* Leaderboard */}
        <div className="mb-8">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Trophy className="w-4 h-4 text-neon-cyan" /> Leaderboard
            </h2>
            <select
              value={scope}
              onChange={e => {
                if (e.target.value === 'global') setScopeFromSlug(null);
                else selectScopeFromRoomId(e.target.value);
              }}
              className="px-3 py-1.5 rounded border border-border bg-surface text-primary text-sm"
            >
              <option value="global">All rooms (global)</option>
              {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          {reportMessage && (
            <div className={`mb-3 text-sm ${reportMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {reportMessage.text}
            </div>
          )}

          {rankingsLoading ? (
            <LoadingState message="Loading scores..." />
          ) : rankings.length === 0 ? (
            <div className="text-center py-10 text-muted border border-border rounded-lg">
              No scores yet. Be the first to submit!
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-deep border-b border-border">
                  <tr className="text-left text-xs text-muted uppercase tracking-wide">
                    <th className="px-3 py-2 w-12">#</th>
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 hidden sm:table-cell">Platform</th>
                    <th className="px-3 py-2 hidden sm:table-cell">Room</th>
                    <th className="px-3 py-2 hidden md:table-cell">Date</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {rankings.map(entry => (
                    <tr key={entry.score_id} className="border-b border-border/50 last:border-0 hover:bg-deep/30">
                      <td className="px-3 py-2 font-mono text-muted">{entry.rank}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <PlayerAvatar
                            username={entry.display_name || entry.iscored_username}
                            discordUserId={entry.discord_user_id}
                            avatarHash={entry.avatar_hash}
                            size={24}
                          />
                          <span className="truncate">{entry.display_name || entry.iscored_username}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-neon-cyan" title={entry.score.toLocaleString()}>
                        {formatScore(entry.score)}
                      </td>
                      <td className="px-3 py-2 text-xs hidden sm:table-cell">
                        {entry.platform ? (
                          <span className="px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan font-display tracking-wide whitespace-nowrap">
                            {getPlatformDisplay(entry.platform)}
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted hidden sm:table-cell">
                        {entry.origin_type === 'global' ? (
                          <span>Global</span>
                        ) : entry.origin_room_slug ? (
                          <RoomTag
                            shortTag={entry.origin_room_short_tag || entry.origin_room_slug}
                            size={16}
                            logoUrl={entry.origin_room_logo_url}
                            href={`?room=${encodeURIComponent(entry.origin_room_slug)}`}
                            title={entry.origin_room_name || entry.origin_room_slug}
                          />
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted hidden md:table-cell">
                        {formatDate(entry.submitted_at)}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {/* m4: explicit flex + gap so the padded (p-4 -m-2,
                            44px-ish) hit areas of the proof link and the two
                            icon buttons no longer overlap each other. */}
                        <div className="inline-flex items-center justify-end gap-3">
                          {entry.photo_url && (
                            <a
                              href={entry.photo_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted hover:text-neon-cyan text-xs inline-block"
                              title="View proof"
                            >
                              proof
                            </a>
                          )}
                          {discordUser?.discordId === entry.discord_user_id && (
                            <button
                              onClick={() => handleDeleteScore(entry.score_id)}
                              className="p-4 -m-2 text-muted hover:text-red-400"
                              title="Delete this score"
                              aria-label="Delete this score"
                            >
                              <Trash2 className="w-3.5 h-3.5 inline" />
                            </button>
                          )}
                          <button
                            onClick={() => handleReport(entry.score_id)}
                            disabled={reportingId === entry.score_id}
                            className="p-4 -m-2 text-muted hover:text-red-400 disabled:opacity-50"
                            title="Report this score"
                            aria-label="Report this score"
                          >
                            <Flag className="w-3.5 h-3.5 inline" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-deep/40 text-xs text-muted">
                  <span>
                    Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="px-2 py-1 rounded border border-border bg-surface hover:border-neon-cyan disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      ← Prev
                    </button>
                    <span>Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
                    <button
                      type="button"
                      onClick={() => setPage(p => p + 1)}
                      disabled={(page + 1) * PAGE_SIZE >= total}
                      className="px-2 py-1 rounded border border-border bg-surface hover:border-neon-cyan disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* External references + designers + authors */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {game.designers.length > 0 && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="text-xs text-muted mb-2 uppercase tracking-wide">Designers</div>
              <div className="text-sm">{game.designers.join(', ')}</div>
            </div>
          )}
          {game.table_authors.length > 0 && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="text-xs text-muted mb-2 uppercase tracking-wide">Table Authors</div>
              <div className="text-sm">{game.table_authors.join(', ')}</div>
            </div>
          )}
          {(game.ipdb_url || game.external_url || game.opdb_id || game.vps_id || game.igdb_id) && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="text-xs text-muted mb-2 uppercase tracking-wide">References</div>
              <div className="flex flex-col gap-1 text-sm">
                {game.external_url && (
                  <a href={game.external_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-neon-cyan hover:underline">
                    <ExternalLink className="w-3 h-3" /> Source page
                  </a>
                )}
                {game.ipdb_url && (
                  <a href={game.ipdb_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-neon-cyan hover:underline">
                    <ExternalLink className="w-3 h-3" /> IPDB
                  </a>
                )}
                {game.opdb_id && <div className="text-muted text-xs">OPDB: {game.opdb_id}</div>}
                {game.vps_id && <div className="text-muted text-xs">VPS: {game.vps_id}</div>}
                {game.igdb_id && <div className="text-muted text-xs">IGDB: {game.igdb_id}</div>}
              </div>
            </div>
          )}
        </div>

        {/* Downloads */}
        {game.table_download_urls.length > 0 && (
          <div className="mb-8">
            <h2 className="font-display text-lg font-semibold mb-3 flex items-center gap-2">
              <Download className="w-4 h-4" /> Downloads
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {game.table_download_urls.map((dl, i) => (
                <a
                  key={i}
                  href={dl.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-border bg-surface hover:border-neon-cyan text-sm no-underline"
                >
                  <span className="truncate">
                    {dl.format || 'Download'}
                    {dl.version ? ` · v${dl.version}` : ''}
                  </span>
                  <ExternalLink className="w-3 h-3 flex-shrink-0 text-muted" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Tutorials */}
        {game.tutorial_urls.length > 0 && (
          <div className="mb-8">
            <h2 className="font-display text-lg font-semibold mb-3 flex items-center gap-2">
              <Play className="w-4 h-4" /> Tutorials
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {game.tutorial_urls.slice(0, 4).map((t, i) => {
                if (t.youtubeId) {
                  return (
                    <a
                      key={i}
                      href={`https://www.youtube.com/watch?v=${t.youtubeId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-border bg-surface overflow-hidden no-underline block group"
                    >
                      <div className="aspect-video relative bg-black">
                        <img
                          src={`https://img.youtube.com/vi/${t.youtubeId}/hqdefault.jpg`}
                          alt={t.title || 'Tutorial'}
                          loading="lazy"
                          decoding="async"
                          className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-14 h-10 bg-red-600 rounded-lg flex items-center justify-center group-hover:bg-red-500 transition-colors">
                            <Play className="w-5 h-5 text-white fill-white" />
                          </div>
                        </div>
                      </div>
                      {t.title && <div className="p-2 text-sm truncate text-primary">{t.title}</div>}
                    </a>
                  );
                }
                if (t.url) {
                  return (
                    <a
                      key={i}
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-surface hover:border-neon-cyan text-sm no-underline"
                    >
                      <Play className="w-4 h-4 text-muted" />
                      <span className="truncate">{t.title || t.url}</span>
                    </a>
                  );
                }
                return null;
              })}
            </div>
          </div>
        )}

        {/* Rules */}
        {game.rules_urls.length > 0 && (
          <div className="mb-8">
            <h2 className="font-display text-lg font-semibold mb-3 flex items-center gap-2">
              <BookOpen className="w-4 h-4" /> Rules
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {game.rules_urls.map((r, i) => (
                <a
                  key={i}
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-border bg-surface hover:border-neon-cyan text-sm no-underline"
                >
                  <span className="truncate">
                    {r.version ? `Rules v${r.version}` : 'Rules sheet'}
                  </span>
                  <ExternalLink className="w-3 h-3 flex-shrink-0 text-muted" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Tips & Comments */}
        <div className="mb-8">
          <div className="flex items-center gap-4 mb-3 border-b border-border">
            <button
              onClick={() => setCommentTab('tips')}
              className={`flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold border-b-2 transition-colors ${
                commentTab === 'tips' ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-muted hover:text-primary'
              }`}
            >
              <Lightbulb className="w-4 h-4" />
              Pro Tips {tips.length > 0 && `(${tips.length})`}
            </button>
            <button
              onClick={() => setCommentTab('comments')}
              className={`flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold border-b-2 transition-colors ${
                commentTab === 'comments' ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-muted hover:text-primary'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Comments {comments.length > 0 && `(${comments.length})`}
            </button>
          </div>

          {/* Comment form (logged-in Discord users only) */}
          {playerToken ? (
            <div className="rounded-lg border border-border bg-surface p-4 mb-4">
              <div className="flex gap-3 mb-2">
                <input
                  type="text"
                  placeholder="Display name"
                  value={commentDisplayName}
                  onChange={e => setCommentDisplayName(e.target.value)}
                  maxLength={50}
                  className="flex-1 px-3 py-1.5 rounded border border-border bg-deep text-primary text-sm"
                />
              </div>
              <textarea
                placeholder={commentTab === 'tips' ? 'Share a pro tip or strategy...' : 'Leave a comment...'}
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                maxLength={500}
                rows={2}
                className="w-full px-3 py-2 rounded border border-border bg-deep text-primary text-sm resize-none mb-2"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">{commentBody.length}/500</span>
                <button
                  onClick={() => handlePostComment(commentTab === 'tips' ? 'tip' : 'comment')}
                  disabled={commentSubmitting || !commentBody.trim() || !commentDisplayName.trim()}
                  className="px-4 py-1.5 rounded border border-neon-cyan/40 text-xs text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
                >
                  {commentSubmitting ? 'Posting...' : commentTab === 'tips' ? 'Post Tip' : 'Post Comment'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted mb-4">
              <button onClick={handleLogin} className="text-neon-cyan hover:underline">Log in with Discord</button> to leave {commentTab === 'tips' ? 'tips' : 'comments'}.
            </div>
          )}

          {/* Comment list */}
          {(commentTab === 'tips' ? tips : comments).length === 0 ? (
            <div className="text-center py-8 text-muted text-sm border border-border rounded-lg">
              No {commentTab === 'tips' ? 'tips' : 'comments'} yet. Be the first!
            </div>
          ) : (
            <div className="space-y-3">
              {(commentTab === 'tips' ? tips : comments).map(c => (
                <div key={c.id} className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <PlayerAvatar
                        username={c.display_name}
                        discordUserId={c.discord_user_id}
                        avatarHash={c.avatar_hash}
                        size={20}
                      />
                      <span className="text-sm font-semibold">{c.display_name}</span>
                      <span className="text-xs text-muted">{formatDate(c.created_at)}</span>
                    </div>
                    {discordUser?.discordId === c.discord_user_id && (
                      <button
                        onClick={() => handleDeleteComment(c.id)}
                        className="text-muted hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Submit modal — v2.0.1: room-context freeplay when ?from=<slug>, else global. */}
      {showSubmit && game && (
        <SubmissionSheet
          target={fromRoom
            ? {
                kind: 'freeplay',
                roomId: fromRoom.id,
                globalGameId: game.id,
                gameName: game.display_name || game.name,
              }
            : {
                kind: 'global',
                globalGameId: game.id,
                gameName: game.display_name || game.name,
              }
          }
          roomSlug={fromSlug || undefined}
          requireLogin={fromRoom?.requireLogin}
          discordOnly={fromRoom?.discordOnly}
          discordEnabled={fromRoom?.discordEnabled}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => {
            setShowSubmit(false);
            refreshRankings();
          }}
        />
      )}

      {pendingDeleteScoreId && (
        <ConfirmModal
          title="Delete score"
          message="Delete this score? If you have other scores for this game, your next best will show instead."
          confirmLabel="Delete"
          onConfirm={() => {
            const scoreId = pendingDeleteScoreId;
            setPendingDeleteScoreId(null);
            performDeleteScore(scoreId);
          }}
          onCancel={() => setPendingDeleteScoreId(null)}
        />
      )}

      {/* v2.25.0 report-a-problem */}
      {reportOpen && game && (
        <ReportProblemModal
          globalGameId={game.id}
          gameName={displayName}
          playerToken={playerToken}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}
