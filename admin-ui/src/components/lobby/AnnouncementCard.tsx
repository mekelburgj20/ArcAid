import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  image_url: string | null;
  cta_url: string | null;
  cta_label: string | null;
  type: string;
  event_datetime: string | null;
}

const TYPE_COLORS: Record<string, string> = {
  tournament: 'border-neon-amber/30 bg-neon-amber/5',
  new_table: 'border-neon-green/30 bg-neon-green/5',
  event: 'border-neon-magenta/30 bg-neon-magenta/5',
  announcement: 'border-neon-cyan/30 bg-neon-cyan/5',
};

function useCountdown(target: string | null) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!target) return;
    const update = () => {
      const diff = new Date(target).getTime() - Date.now();
      if (diff <= 0) { setText('Now!'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      if (h > 24) {
        const d = Math.floor(h / 24);
        setText(`${d}d ${h % 24}h`);
      } else {
        setText(`${h}h ${m}m`);
      }
    };
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [target]);
  return text;
}

export default function AnnouncementCard({ announcement }: { announcement: Announcement }) {
  const a = announcement;
  const colorClass = TYPE_COLORS[a.type] || TYPE_COLORS.announcement;
  const countdown = useCountdown(a.event_datetime);

  return (
    <div className={`border rounded-lg overflow-hidden flex-shrink-0 w-72 sm:w-80 ${colorClass}`}>
      {a.image_url && (
        <div className="h-28 overflow-hidden">
          <img src={a.image_url} alt="" className="w-full h-full object-cover" />
        </div>
      )}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-primary leading-tight">{a.title}</h3>
          {countdown && (
            <span className="text-[10px] text-neon-amber bg-neon-amber/10 px-1.5 py-0.5 rounded flex-shrink-0 font-mono">
              {countdown}
            </span>
          )}
        </div>
        {a.body && <p className="text-xs text-muted mt-1 line-clamp-2">{a.body}</p>}
        {a.cta_url && (
          <a
            href={a.cta_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-xs text-neon-cyan hover:underline"
          >
            {a.cta_label || 'Learn more'} <ExternalLink size={10} />
          </a>
        )}
      </div>
    </div>
  );
}
