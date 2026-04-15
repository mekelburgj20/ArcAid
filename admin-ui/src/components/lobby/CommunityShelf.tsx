import { ExternalLink } from 'lucide-react';

interface ShelfItem {
  id: string;
  type: string;
  url: string;
  title: string;
  thumbnail: string | null;
  description: string | null;
}

const TYPE_ICONS: Record<string, string> = {
  youtube: '\u{1F3AC}',
  twitch_vod: '\u{1F4FA}',
  article: '\u{1F4F0}',
  link: '\u{1F517}',
};

export default function CommunityShelf({ items }: { items: ShelfItem[] }) {
  if (!items || items.length === 0) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint mb-2 px-1">
        From the Owner
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map(item => (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-3 bg-surface/50 border border-border/30 rounded-lg px-3 py-2.5 hover:border-neon-cyan/30 transition-colors no-underline group"
          >
            {item.thumbnail ? (
              <img src={item.thumbnail} alt="" className="w-16 h-12 rounded object-cover flex-shrink-0" />
            ) : (
              <span className="text-xl flex-shrink-0 w-8 text-center mt-0.5">
                {TYPE_ICONS[item.type] || TYPE_ICONS.link}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-primary font-medium truncate group-hover:text-neon-cyan transition-colors">
                {item.title}
              </p>
              {item.description && (
                <p className="text-xs text-muted mt-0.5 line-clamp-2">{item.description}</p>
              )}
              <span className="text-[10px] text-faint mt-1 inline-flex items-center gap-0.5">
                {item.type.replace('_', ' ')} <ExternalLink size={8} />
              </span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
