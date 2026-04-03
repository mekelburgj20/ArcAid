import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import StarRating from '../components/StarRating';
import Sparkline from '../components/Sparkline';
import { api } from '../lib/api';
import { Search, Trophy, TrendingUp, Target, Medal, Plus, Minus, Clock, Lightbulb, MessageCircle, Trash2, ChevronDown, ChevronUp, History } from 'lucide-react';

interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
}

interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  imageUrl: string | null;
  rankings: RankedEntry[];
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
  iscored_username: string;
  best_score: number;
  times_played: number;
  last_played: string;
}

interface CommunityHistoryEntry {
  id: number;
  iscored_username: string;
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
  score: number;
  source: 'tournament' | 'community' | 'sync';
  created_at: string;
  photo_url?: string;
}

interface GamePlayerRanking {
  rank: number;
  iscored_username: string;
  best_score: number;
  times_played: number;
  last_played: string;
}

type Tab = 'leaderboard' | 'community' | 'tips' | 'player-stats';

export default function GameDetail() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<GameLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [ratingInfo, setRatingInfo] = useState<{ avg_rating: number; rating_count: number; user_rating: number | null } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('leaderboard');

  // Expandable score history per player in leaderboard
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [playerHistory, setPlayerHistory] = useState<ScoreHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [scoreCounts, setScoreCounts] = useState<Record<string, number>>({});

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
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [submitUsername, setSubmitUsername] = useState(() => localStorage.getItem('arcaid-player-name') || '');
  const [submitScore, setSubmitScore] = useState('');
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitMessage, setSubmitMessage] = useState('');

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

  // Resolve room from slug
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(portal => { if (portal?.id) setRoomId(portal.id); })
      .catch(() => {});
  }, [slug]);

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
        }
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
  }, [name, roomId]);

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

  const loadComments = (rid: string, gameName: string) => {
    fetch(`/api/rooms/${rid}/games/${encodeURIComponent(gameName)}/comments?type=tip`)
      .then(r => r.ok ? r.json() : [])
      .then(setTips)
      .catch(() => {});
    fetch(`/api/rooms/${rid}/games/${encodeURIComponent(gameName)}/comments?type=comment`)
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
      const res = await fetch(`/api/rooms/${roomId}/games/${encodeURIComponent(name)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
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
      await fetch(`/api/rooms/${roomId}/games/${encodeURIComponent(name)}/comments/${commentId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      loadComments(roomId, name);
    } catch {}
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

  const handleSubmitScore = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = submitUsername.trim();
    const scoreNum = parseInt(submitScore, 10);
    if (!trimmedName || isNaN(scoreNum) || scoreNum < 0 || !roomId || !name) return;

    setSubmitLoading(true);
    setSubmitMessage('');
    try {
      const res = await fetch(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmedName, score: scoreNum }),
      });
      if (res.ok) {
        setSubmitMessage('Score submitted!');
        setSubmitScore('');
        localStorage.setItem('arcaid-player-name', trimmedName);
        loadCommunityData(roomId, name);
        setTimeout(() => setSubmitMessage(''), 3000);
      } else {
        setSubmitMessage('Failed to submit score.');
      }
    } catch {
      setSubmitMessage('Failed to submit score.');
    } finally {
      setSubmitLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="text-center py-24 px-4">
        <p className="text-muted mb-2">No stats available for <span className="text-primary font-medium">{name}</span>.</p>
        <p className="text-faint text-sm mb-4">This game hasn&apos;t been played in a tournament yet.</p>
        <Link to={`/${slug}/games`} className="text-neon-cyan text-sm hover:text-neon-cyan/80 no-underline transition-colors">
          &larr; Back to Game Availability
        </Link>
      </div>
    );
  }

  const imageUrl = leaderboard?.imageUrl;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'community', label: 'Community' },
    { id: 'tips', label: 'Tips & Comments' },
    { id: 'player-stats', label: 'Player Stats' },
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
          <Link to={`/${slug}`} className="text-white/50 text-xs hover:text-white/70 no-underline transition-colors">
            &larr; Scoreboard
          </Link>
          <h2 className="font-display text-2xl font-bold text-white mt-1">{stats.gameName}</h2>
          {leaderboard && (
            <p className="text-white/50 text-xs uppercase tracking-wider">{leaderboard.tournamentName}</p>
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
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Times Featured" value={stats.timesPlayed.toString()} color="text-neon-cyan" />
          <StatCard label="Unique Players" value={stats.uniquePlayers.toString()} color="text-neon-green" />
          <StatCard label="Avg Score" value={stats.avgScore.toLocaleString()} color="text-muted" />
          <StatCard label="All-Time High" value={stats.allTimeHigh.toLocaleString()} color="text-neon-amber" />
        </div>

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
            {leaderboard && leaderboard.rankings.length > 0 && (
              <div className="mb-8">
                <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Current Leaderboard</h2>
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                    <div className="flex items-center gap-3">
                      <span className="w-8 text-center">Rank</span>
                      <span>Player</span>
                    </div>
                    <span>Score</span>
                  </div>
                  {leaderboard.rankings.map((entry) => {
                    const hasMultiple = scoreCounts[entry.iscored_username.toLowerCase()] > 1;
                    return (
                    <div key={entry.discord_user_id}>
                      <div
                        className={`flex items-center justify-between px-5 py-3 border-b border-border/20 last:border-0 ${
                          entry.rank === 1 ? 'bg-neon-amber/8' : ''
                        } ${hasMultiple ? 'cursor-pointer hover:bg-raised/50 transition-colors' : ''}`}
                        onClick={hasMultiple ? () => togglePlayerHistory(entry.iscored_username) : undefined}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`font-display font-bold w-8 text-center flex-shrink-0 ${
                            entry.rank === 1 ? 'text-neon-amber text-lg' :
                            entry.rank === 2 ? 'text-neon-cyan' :
                            entry.rank === 3 ? 'text-neon-green' :
                            'text-faint'
                          }`}>
                            {entry.rank}
                          </span>
                          <span className="font-medium truncate">{entry.iscored_username}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`font-display font-bold flex-shrink-0 ${
                            entry.rank === 1 ? 'text-neon-amber text-lg' : 'text-primary'
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
                        <div className="bg-deep/50 border-b border-border/20 px-5 py-2">
                          {historyLoading ? (
                            <p className="text-faint text-xs py-2">Loading history...</p>
                          ) : playerHistory.length > 0 ? (
                            <div className="space-y-1">
                              <p className="text-faint text-[10px] uppercase tracking-wider mb-1">Score History</p>
                              {playerHistory.map(h => (
                                <div key={h.id} className="flex items-center justify-between text-sm">
                                  <div className="flex items-center gap-2">
                                    <span className="text-muted">{h.score.toLocaleString()}</span>
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
                          ) : (
                            <p className="text-faint text-xs py-2">No score history recorded yet.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                  })}
                </div>
              </div>
            )}

            {/* Record Holder */}
            {stats.allTimeHighPlayer && (
              <div className="bg-surface border border-neon-amber/30 rounded-lg p-5 mb-8 text-center">
                <p className="text-faint text-xs uppercase tracking-wider mb-1">All-Time Record Holder</p>
                <p className="font-display text-xl font-bold text-neon-amber">{stats.allTimeHighPlayer}</p>
                <p className="text-muted text-sm">{stats.allTimeHigh.toLocaleString()} points</p>
              </div>
            )}

            {/* Past Results */}
            {stats.recentResults.length > 0 && (
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
                          <span className="font-medium truncate">{h.iscored_username}</span>
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
                  onClick={() => setShowSubmitForm(!showSubmitForm)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-neon-green/15 border border-neon-green/40 text-neon-green rounded-lg text-xs font-medium hover:bg-neon-green/25 transition-colors"
                >
                  <Plus size={14} />
                  Submit Score
                </button>
              </div>

              {showSubmitForm && (
                <form onSubmit={handleSubmitScore} className="bg-surface border border-border rounded-lg p-4 mb-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <input
                      type="text"
                      placeholder="Your player name"
                      value={submitUsername}
                      onChange={e => setSubmitUsername(e.target.value)}
                      className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
                    />
                    <input
                      type="number"
                      placeholder="Score"
                      value={submitScore}
                      onChange={e => setSubmitScore(e.target.value)}
                      min="0"
                      className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={!submitUsername.trim() || !submitScore || submitLoading}
                      className="px-4 py-2 bg-neon-green/15 border border-neon-green/40 text-neon-green rounded-lg text-sm font-medium hover:bg-neon-green/25 transition-colors disabled:opacity-40"
                    >
                      {submitLoading ? 'Submitting...' : 'Submit'}
                    </button>
                    {submitMessage && (
                      <span className={`text-sm ${submitMessage.includes('!') ? 'text-neon-green' : 'text-neon-coral'}`}>
                        {submitMessage}
                      </span>
                    )}
                  </div>
                </form>
              )}
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
                      key={entry.iscored_username}
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
                        <span className="font-medium truncate">{entry.iscored_username}</span>
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
                        <span className="font-medium truncate">{entry.iscored_username}</span>
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
                      {tip.user_id === userId && (
                        <button onClick={() => handleDeleteComment(tip.id)} className="text-faint hover:text-neon-coral transition-colors flex-shrink-0">
                          <Trash2 size={14} />
                        </button>
                      )}
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
                      {comment.user_id === userId && (
                        <button onClick={() => handleDeleteComment(comment.id)} className="text-faint hover:text-neon-coral transition-colors flex-shrink-0">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted text-sm text-center py-8">No comments yet. Be the first!</p>
              )}
            </div>
          </>
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
                          {p.iscored_username}
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
      </main>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display font-bold text-2xl ${color}`}>{value}</p>
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
