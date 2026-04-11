import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Trophy, Upload, LogIn, Download, BookOpen, Play, ExternalLink, Flag } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import GlobalScoreSubmitModal from '../components/GlobalScoreSubmitModal';

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
  score: number;
  photo_url: string | null;
  submitted_at: string;
  origin_type: string;
  origin_game_room_id: string | null;
  origin_room_name: string | null;
  avatar_hash: string | null;
  score_id: string;
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function resolveImage(game: GlobalGame): string | null {
  if (game.local_image_path) return game.local_image_path.startsWith('/') ? game.local_image_path : `/${game.local_image_path}`;
  if (game.image_url) return game.image_url;
  return null;
}

function resolveWheel(game: GlobalGame): string | null {
  if (!game.wheel_image_path) return null;
  return game.wheel_image_path.startsWith('/') ? game.wheel_image_path : `/${game.wheel_image_path}`;
}

export default function GlobalGameDetail() {
  const { globalGameId } = useParams<{ globalGameId: string }>();
  const { discordUser, playerToken, loginWithDiscord, logoutPlayer } = useViewerAuth();
  const [game, setGame] = useState<GlobalGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [scope, setScope] = useState<string>('global');
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [rankingsLoading, setRankingsLoading] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

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

  // Fetch leaderboard whenever game or scope changes
  useEffect(() => {
    if (!globalGameId) return;
    setRankingsLoading(true);
    fetch(`/api/global/scoreboard/${globalGameId}?scope=${scope}&limit=50`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(payload => setRankings(payload.data || []))
      .catch(() => setRankings([]))
      .finally(() => setRankingsLoading(false));
  }, [globalGameId, scope]);

  const displayName = useMemo(() => game ? (game.display_name || game.name) : '', [game]);
  const imageSrc = useMemo(() => game ? resolveImage(game) : null, [game]);
  const wheelSrc = useMemo(() => game ? resolveWheel(game) : null, [game]);

  const handleLogin = () => {
    loginWithDiscord('__global__', `/games/${globalGameId}`);
  };

  const handleSubmitClick = () => {
    if (!playerToken) {
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

  const refreshRankings = () => {
    if (!globalGameId) return;
    setRankingsLoading(true);
    fetch(`/api/global/scoreboard/${globalGameId}?scope=${scope}&limit=50`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(payload => setRankings(payload.data || []))
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

  if (notFound || !game) {
    return (
      <div className="min-h-screen bg-deep text-primary flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-muted">Game not found.</div>
        <Link to="/scoreboard" className="text-neon-cyan hover:underline">← Back to global scoreboard</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <Link to="/scoreboard" className="flex items-center gap-2 text-xs text-muted hover:text-neon-cyan no-underline">
            <ArrowLeft className="w-4 h-4" />
            Global Scoreboard
          </Link>
          <div className="flex items-center gap-3">
            {discordUser ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted hidden sm:inline">{discordUser.username}</span>
                <button
                  onClick={logoutPlayer}
                  className="px-3 py-1.5 rounded border border-border text-xs text-muted hover:text-primary hover:border-neon-cyan"
                >
                  Logout
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                className="flex items-center gap-1 px-3 py-1.5 rounded border border-neon-cyan/40 text-xs text-neon-cyan hover:bg-neon-cyan/10"
              >
                <LogIn className="w-3 h-3" />
                Login with Discord
              </button>
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
              <div className="text-sm text-muted mb-3">
                {game.manufacturer || 'Unknown manufacturer'}
                {game.year ? ` · ${game.year}` : ''}
                {game.subtype ? ` · ${game.subtype.toUpperCase()}` : ''}
                {game.players ? ` · ${game.players}P` : ''}
              </div>
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
                    <div key={i} className="rounded-lg border border-border bg-surface overflow-hidden">
                      <div className="aspect-video">
                        <iframe
                          className="w-full h-full"
                          src={`https://www.youtube.com/embed/${t.youtubeId}`}
                          title={t.title || 'Tutorial'}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                      {t.title && <div className="p-2 text-sm truncate">{t.title}</div>}
                    </div>
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

        {/* Leaderboard */}
        <div className="mb-8">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Trophy className="w-4 h-4 text-neon-cyan" /> Leaderboard
            </h2>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
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
                            username={entry.iscored_username}
                            discordUserId={entry.discord_user_id}
                            avatarHash={entry.avatar_hash}
                            size={24}
                          />
                          <span className="truncate">{entry.iscored_username}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-neon-cyan" title={entry.score.toLocaleString()}>
                        {formatScore(entry.score)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted hidden sm:table-cell truncate">
                        {entry.origin_type === 'global' ? 'Global' : (entry.origin_room_name || '—')}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted hidden md:table-cell">
                        {formatDate(entry.submitted_at)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {entry.photo_url && (
                          <a
                            href={entry.photo_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted hover:text-neon-cyan text-xs inline-block mr-2"
                            title="View proof"
                          >
                            proof
                          </a>
                        )}
                        <button
                          onClick={() => handleReport(entry.score_id)}
                          disabled={reportingId === entry.score_id}
                          className="text-muted hover:text-red-400 disabled:opacity-50"
                          title="Report this score"
                        >
                          <Flag className="w-3.5 h-3.5 inline" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Submit modal */}
      {showSubmit && playerToken && (
        <GlobalScoreSubmitModal
          game={{
            global_game_id: game.id,
            name: game.name,
            display_name: game.display_name,
            manufacturer: game.manufacturer,
            year: game.year,
          }}
          playerToken={playerToken}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => {
            setShowSubmit(false);
            refreshRankings();
          }}
        />
      )}
    </div>
  );
}
