import { useEffect, useRef, useState } from 'react';

/**
 * Room Settings -> Discord -> **Post top scores to Discord** (v2.225.0, E13).
 *
 * Edits two keys the server's `DiscordScorePostService` reads (through
 * `src/utils/discordScorePosts.ts`): `DISCORD_SCORE_POSTS_ENABLED` (absent =
 * off) and `DISCORD_SCORE_POSTS_TOP_N` (1-50, absent = 10; the settings POST
 * clamps it again).
 *
 * Instant-save via `onSaveNow`, like DiscordAnnounceRoutes - never the Save
 * bar. The number commits on blur / Enter, not per keystroke.
 */

export const DISCORD_SCORE_POSTS_ENABLED_KEY = 'DISCORD_SCORE_POSTS_ENABLED';
export const DISCORD_SCORE_POSTS_TOP_N_KEY = 'DISCORD_SCORE_POSTS_TOP_N';
const DEFAULT_TOP_N = 10;
const MIN_TOP_N = 1;
const MAX_TOP_N = 50;

interface Props {
  settings: Record<string, string>;
  /** The page's instant-save (optimistic, reverts on failure). */
  onSaveNow: (patch: Record<string, string>) => void | Promise<void>;
}

export default function DiscordScorePosts({ settings, onSaveNow }: Props) {
  const enabled = settings[DISCORD_SCORE_POSTS_ENABLED_KEY] === 'true';
  const stored = settings[DISCORD_SCORE_POSTS_TOP_N_KEY] ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const lastCommitted = useRef(stored);
  useEffect(() => { lastCommitted.current = stored; }, [stored]);

  const toggle = () => {
    onSaveNow({ [DISCORD_SCORE_POSTS_ENABLED_KEY]: enabled ? '' : 'true' });
  };

  const commit = (raw: string) => {
    setDraft(null);
    const trimmed = raw.trim();
    let value = '';
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return;
      value = String(Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.floor(n))));
    }
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    onSaveNow({ [DISCORD_SCORE_POSTS_TOP_N_KEY]: value });
  };

  return (
    <div className="pt-3 mt-3 border-t border-border/30 space-y-3" data-testid="discord-score-posts">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">Post top scores to Discord</p>
          <p className="text-xs text-muted">
            When a score lands in the top N of a game, the bot posts it to the room&rsquo;s Tournament
            posts channel (a new #1 says who was dethroned).
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          role="switch"
          aria-checked={enabled}
          aria-label="Post top scores to Discord"
          data-testid="score-posts-toggle"
          className="relative shrink-0 w-12 h-6 min-h-[44px] flex items-center rounded-full transition-colors cursor-pointer border-none bg-transparent"
        >
          <span
            className={`relative block w-12 h-6 rounded-full transition-colors ${
              enabled ? 'bg-neon-cyan' : 'bg-raised border border-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                enabled ? 'translate-x-6' : ''
              }`}
            />
          </span>
        </button>
      </div>

      <div
        className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}
        aria-disabled={!enabled}
      >
        <label className="w-full sm:w-64 shrink-0 text-sm font-mono text-muted" htmlFor="score-posts-top-n">
          Top N
        </label>
        <input
          id="score-posts-top-n"
          data-testid="score-posts-top-n"
          type="number"
          min={MIN_TOP_N}
          max={MAX_TOP_N}
          placeholder={String(DEFAULT_TOP_N)}
          value={draft ?? stored}
          disabled={!enabled}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit((e.target as HTMLInputElement).value); } }}
          className="min-h-[44px] w-full sm:w-32 rounded border border-border bg-raised px-2 text-sm text-primary"
        />
      </div>
    </div>
  );
}
