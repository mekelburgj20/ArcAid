import { Link } from 'react-router-dom';
import { Flame, TrendingUp, Target, Trophy, Gamepad2, Crown, Users, Megaphone, Star, Zap } from 'lucide-react';

interface FeedEvent {
  id: number;
  type: string;
  icon: string | null;
  title: string;
  subtitle: string | null;
  game_name: string | null;
  created_at: string;
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
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
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
      </div>
      <span className="text-[10px] text-faint flex-shrink-0 mt-0.5">
        {relativeTime(event.created_at)}
      </span>
    </div>
  );

  return link ? (
    <Link to={link} className="block no-underline">{content}</Link>
  ) : (
    <div>{content}</div>
  );
}
