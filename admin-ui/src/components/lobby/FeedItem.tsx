import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame, TrendingUp, Target, Trophy, Gamepad2, Crown, Users, Megaphone, Star, Zap, Hourglass } from 'lucide-react';
import { relativeTimeFrom } from '../../lib/format';

interface FeedEvent {
  id: number;
  type: string;
  icon: string | null;
  title: string;
  subtitle: string | null;
  game_name: string | null;
  created_at: string;
  metadata?: Record<string, any> | null;
}

const TYPE_ICONS: Record<string, { icon: typeof Flame; color: string }> = {
  new_high_score:    { icon: Flame,      color: 'text-neon-amber' },
  rank_change:       { icon: TrendingUp, color: 'text-neon-cyan' },
  score_posted:      { icon: Target,     color: 'text-muted' },
  tournament_results:{ icon: Trophy,     color: 'text-neon-amber' },
  tournament_active: { icon: Gamepad2,   color: 'text-neon-cyan' },
  player_milestone:  { icon: Star,       color: 'text-neon-amber' },
  friend_score:      { icon: Users,      color: 'text-[#5865F2]' },
  admin_message:     { icon: Megaphone,  color: 'text-neon-magenta' },
  admin_shoutout:    { icon: Zap,        color: 'text-neon-magenta' },
  staleness_challenge:{ icon: Crown,     color: 'text-muted' },
  streak_extended:   { icon: Flame,      color: 'text-neon-amber' },
  pick_prompt:       { icon: Hourglass,  color: 'text-neon-magenta' },
};

/**
 * Live countdown for `pick_prompt` rows.
 *
 * The event stores a deadline, never a rendered "N minutes" — the feed is
 * append-only and a baked number would still be claiming "45 minutes
 * remaining" a week later. The countdown is therefore computed at render and
 * re-ticked on a timer.
 *
 * Past the deadline we render a neutral closed state rather than a negative
 * countdown. We deliberately do NOT claim to know the outcome: nothing mutates
 * the row when a pick lands, so "closed" covers picked, auto-picked and
 * passed-to-runner-up alike. A pick made early leaves the countdown running
 * until its original deadline — stale by at most one window, and self-resolving.
 */
function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'less than a minute';
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function PickCountdown({ deadline, fallback }: { deadline: string; fallback?: string }) {
  const deadlineMs = new Date(deadline).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing to tick for a closed (or malformed) window — the closed state is
    // static, so an open feed of old prompts costs no timers.
    if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      // Self-cancel on the tick that crosses the deadline.
      if (Date.now() >= deadlineMs) clearInterval(timer);
    }, 30_000);
    return () => clearInterval(timer);
  }, [deadlineMs]);

  if (!Number.isFinite(deadlineMs)) return null;

  const remaining = deadlineMs - now;
  if (remaining <= 0) {
    return <p className="text-xs text-faint mt-0.5">Pick window closed</p>;
  }

  const consequence = fallback === 'runner_up' ? 'the runner-up gets the pick' : 'autopick';
  // Built as one string rather than interpolated JSX fragments so it lands as a
  // single text node — screen readers announce it as one phrase, and it stays
  // matchable as one string.
  const text = `${formatRemaining(remaining)} remaining before ${consequence}`;
  return <p className="text-xs text-neon-magenta mt-0.5">{text}</p>;
}

interface FeedItemProps {
  event: FeedEvent;
  slug: string;
}

export default function FeedItem({ event, slug }: FeedItemProps) {
  const link = event.game_name ? `/${slug}/games/${encodeURIComponent(event.game_name)}` : null;
  const typeInfo = TYPE_ICONS[event.type] || { icon: Target, color: 'text-muted' };
  const Icon = typeInfo.icon;

  const content = (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-surface/60 transition-colors group">
      <Icon size={16} className={`flex-shrink-0 mt-0.5 ${typeInfo.color}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-primary leading-snug">{event.title}</p>
        {event.subtitle && (
          <p className="text-xs text-muted mt-0.5">{event.subtitle}</p>
        )}
        {event.type === 'pick_prompt' && event.metadata?.deadline && (
          <PickCountdown deadline={event.metadata.deadline} fallback={event.metadata.fallback} />
        )}
      </div>
      <span className="text-[10px] text-faint flex-shrink-0 mt-0.5">
        {relativeTimeFrom(event.created_at)}
      </span>
    </div>
  );

  return link ? (
    <Link to={link} className="block no-underline">{content}</Link>
  ) : (
    <div>{content}</div>
  );
}
