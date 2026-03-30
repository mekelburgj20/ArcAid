import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

export default function ScoreSubmit() {
  const { slug, gameId } = useParams<{ slug: string; gameId: string }>();
  const { discordUser } = useViewerAuth();

  // Room + game resolution
  const [roomId, setRoomId] = useState('');
  const [gameName, setGameName] = useState('');
  const [gameStatus, setGameStatus] = useState('');
  const [requirePhoto, setRequirePhoto] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form state
  const [username, setUsername] = useState('');
  const [score, setScore] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [usernameModified, setUsernameModified] = useState(false);
  const [mergeWithDiscord, setMergeWithDiscord] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prepopulate username from Discord
  useEffect(() => {
    if (discordUser?.username && !username) {
      setUsername(discordUser.username);
    }
  }, [discordUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve room + game on mount
  useEffect(() => {
    if (!slug || !gameId) return;
    setLoading(true);
    setError('');

    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => {
        if (!r.ok) throw new Error('Room not found');
        return r.json();
      })
      .then((portal: { id: string }) => {
        setRoomId(portal.id);
        return fetch(`/api/rooms/${portal.id}/games/${gameId}/info`);
      })
      .then(r => {
        if (!r.ok) throw new Error('Game not found');
        return r.json();
      })
      .then((game: { id: string; name: string; status: string; requirePhoto: boolean }) => {
        setGameName(game.name);
        setGameStatus(game.status);
        setRequirePhoto(game.requirePhoto);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load game');
        setLoading(false);
      });
  }, [slug, gameId]);

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    if (discordUser?.username && value !== discordUser.username) {
      setUsernameModified(true);
    } else {
      setUsernameModified(false);
      setMergeWithDiscord(false);
    }
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setPhoto(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPhotoPreview(url);
    } else {
      setPhotoPreview('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !score.trim() || !roomId || !gameName) return;

    const scoreNum = parseInt(score, 10);
    if (isNaN(scoreNum) || scoreNum < 0) {
      setSubmitError('Please enter a valid score (0 or higher).');
      return;
    }

    setSubmitting(true);
    setSubmitError('');

    try {
      const formData = new FormData();
      const submitUsername = mergeWithDiscord && discordUser?.username
        ? discordUser.username
        : username.trim();
      formData.append('username', submitUsername);
      formData.append('score', String(scoreNum));
      if (photo) {
        formData.append('photo', photo);
      }

      const res = await fetch(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Submission failed' }));
        throw new Error(data.error || 'Submission failed');
      }

      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          <span className="text-muted text-sm font-display">Loading...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-lg p-6 max-w-md w-full text-center">
          <p className="text-red-400 font-display text-lg mb-4">{error}</p>
          <Link to={`/${slug}`} className="text-neon-cyan hover:underline text-sm">
            Back to scoreboard
          </Link>
        </div>
      </div>
    );
  }

  // Success state
  if (submitted) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-lg p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">&#10003;</div>
          <h2 className="font-display text-xl text-primary mb-2">Score Submitted!</h2>
          <p className="text-muted mb-6">
            Your score of <span className="text-primary font-bold">{parseInt(score, 10).toLocaleString()}</span> for{' '}
            <span className="text-primary font-bold">{gameName}</span> has been recorded.
          </p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                setSubmitted(false);
                setScore('');
                setPhoto(null);
                setPhotoPreview('');
              }}
              className="w-full py-3 rounded-lg font-display font-bold text-sm bg-neon-cyan/20 text-neon-cyan hover:bg-neon-cyan/30 border border-neon-cyan/40 transition-colors"
            >
              Submit Another Score
            </button>
            <Link
              to={`/${slug}`}
              className="text-neon-cyan hover:underline text-sm font-display"
            >
              View Scoreboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isInactive = gameStatus !== 'ACTIVE';

  // Show locked message instead of form for non-active games
  if (isInactive) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-lg p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">&#128274;</div>
          <h2 className="font-display text-xl text-primary mb-2">{gameName}</h2>
          <p className="text-yellow-400 text-sm mb-6 font-display">
            This game is locked. Scores can no longer be submitted.
          </p>
          <Link to={`/${slug}`} className="text-neon-cyan hover:underline text-sm font-display">
            View Scoreboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep flex items-start justify-center px-4 py-8">
      <div className="bg-surface border border-border rounded-lg p-6 max-w-md w-full">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="font-display text-xl font-bold text-primary mb-1">{gameName}</h1>
          <p className="text-muted text-sm">Submit your score</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Score input */}
          <div>
            <label htmlFor="score" className="block text-sm font-display text-muted mb-1">
              Score
            </label>
            <input
              id="score"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={score}
              onChange={e => setScore(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Enter your score"
              required
              autoFocus
              className="w-full px-4 py-3 text-2xl font-bold text-primary bg-deep border border-border rounded-lg focus:outline-none focus:border-neon-cyan/60 transition-colors placeholder:text-muted/40"
            />
          </div>

          {/* Username input */}
          <div>
            <label htmlFor="username" className="block text-sm font-display text-muted mb-1">
              Player Name
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={e => handleUsernameChange(e.target.value)}
              placeholder="Your name or initials"
              required
              maxLength={100}
              className="w-full px-4 py-3 text-primary bg-deep border border-border rounded-lg focus:outline-none focus:border-neon-cyan/60 transition-colors placeholder:text-muted/40"
            />
            {discordUser && !usernameModified && (
              <p className="text-xs text-muted mt-1">
                Logged in as <span className="text-neon-cyan">{discordUser.username}</span>
              </p>
            )}
            {usernameModified && discordUser && (
              <label className="flex items-center gap-2 mt-2 text-xs text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={mergeWithDiscord}
                  onChange={e => setMergeWithDiscord(e.target.checked)}
                  className="rounded border-border"
                />
                Merge scores with my Discord account ({discordUser.username})?
              </label>
            )}
          </div>

          {/* Photo upload */}
          <div>
            <label className="block text-sm font-display text-muted mb-1">
              Photo {requirePhoto ? <span className="text-red-400">*</span> : <span className="text-muted/60">(optional)</span>}
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              capture="environment"
              onChange={handlePhotoChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-4 py-3 text-sm text-muted bg-deep border border-dashed border-border rounded-lg hover:border-neon-cyan/40 transition-colors text-center"
            >
              {photo ? photo.name : 'Tap to take photo or choose file'}
            </button>
            {photoPreview && (
              <div className="mt-2 relative">
                <img src={photoPreview} alt="Preview" className="w-full rounded-lg max-h-48 object-contain bg-deep" />
                <button
                  type="button"
                  onClick={() => { setPhoto(null); setPhotoPreview(''); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-deep/80 text-muted hover:text-red-400 flex items-center justify-center text-xs"
                >
                  X
                </button>
              </div>
            )}
          </div>

          {/* Submit error */}
          {submitError && (
            <p className="text-red-400 text-sm text-center">{submitError}</p>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={submitting || !username.trim() || !score.trim() || (requirePhoto && !photo)}
            className="w-full py-4 rounded-lg font-display font-bold text-base bg-neon-cyan/20 text-neon-cyan hover:bg-neon-cyan/30 border border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting...' : 'Submit Score'}
          </button>
        </form>

        {/* Footer link */}
        <div className="text-center mt-4">
          <Link to={`/${slug}`} className="text-neon-cyan hover:underline text-xs font-display">
            View Scoreboard
          </Link>
        </div>
      </div>
    </div>
  );
}
