import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import NeonCard from './NeonCard';
import { CheckCircle2, Circle, ChevronRight } from 'lucide-react';

interface SetupChecklistProps {
  roomId: string;
  roomSlug: string;
}

interface ChecklistItem {
  label: string;
  complete: boolean;
  link: string;
  linkLabel: string;
}

const DISMISSED_KEY = (roomId: string) => `arcaid-setup-dismissed-${roomId}`;

export default function SetupChecklist({ roomId, roomSlug }: SetupChecklistProps) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY(roomId)) === 'true') {
      setDismissed(true);
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        const [settings, tournaments, libraryRaw] = await Promise.all([
          api.get<Record<string, string>>(`/rooms/${roomId}/settings`),
          api.get<unknown[]>(`/rooms/${roomId}/tournaments`),
          api.get<unknown>(`/rooms/${roomId}/game_library`),
        ]);

        const games: unknown[] = Array.isArray(libraryRaw)
          ? libraryRaw
          : Array.isArray((libraryRaw as any)?.items)
            ? (libraryRaw as any).items
            : [];

        const checklist: ChecklistItem[] = [
          {
            label: 'Discord configured',
            complete:
              !!(settings['DISCORD_GUILD_ID']?.trim()) &&
              !!(settings['DISCORD_ANNOUNCEMENT_CHANNEL_ID']?.trim()),
            link: `/${roomSlug}/admin/settings`,
            linkLabel: 'Configure',
          },
          {
            label: 'iScored configured',
            complete:
              !!(settings['ISCORED_USERNAME']?.trim()) &&
              !!(settings['ISCORED_PUBLIC_URL']?.trim()),
            link: `/${roomSlug}/admin/settings`,
            linkLabel: 'Configure',
          },
          {
            label: 'Games imported',
            complete: games.length > 0,
            link: `/${roomSlug}/admin/library`,
            linkLabel: 'Import games',
          },
          {
            label: 'Tournament created',
            complete: tournaments.length > 0,
            link: `/${roomSlug}/admin/tournaments`,
            linkLabel: 'Create tournament',
          },
          {
            label: 'Timezone set',
            complete: !!(settings['BOT_TIMEZONE']?.trim()),
            link: `/${roomSlug}/admin/settings`,
            linkLabel: 'Configure',
          },
        ];

        setItems(checklist);
      } catch {
        // If fetching fails, don't show the checklist
        setDismissed(true);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [roomId, roomSlug]);

  if (dismissed || loading) return null;

  const completedCount = items.filter((i) => i.complete).length;
  const allComplete = completedCount === items.length;

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY(roomId), 'true');
    setDismissed(true);
  };

  return (
    <NeonCard glowColor="cyan" className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-neon-cyan">
          Setup Progress
        </h3>
        <span className="text-xs text-muted">
          {completedCount} / {items.length} complete
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-raised rounded-full h-2 mb-4 border border-border">
        <div
          className="h-full rounded-full bg-neon-cyan transition-all duration-500"
          style={{ width: `${(completedCount / items.length) * 100}%` }}
        />
      </div>

      {allComplete ? (
        <div className="text-center py-4">
          <p className="text-neon-green font-semibold mb-1">
            All set! Your room is fully configured.
          </p>
          <p className="text-muted text-sm mb-4">
            You can always adjust settings from the admin pages.
          </p>
          <button
            onClick={handleDismiss}
            className="px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan text-sm hover:bg-neon-cyan/10 transition-colors"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.label}>
              <Link
                to={item.link}
                className="flex items-center gap-3 px-3 py-2 rounded bg-raised border border-border hover:border-neon-cyan/30 transition-colors group"
              >
                {item.complete ? (
                  <CheckCircle2 className="w-5 h-5 text-neon-green flex-shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-neon-amber flex-shrink-0" />
                )}
                <span
                  className={`flex-1 text-sm ${item.complete ? 'text-muted line-through' : 'text-primary'}`}
                >
                  {item.label}
                </span>
                {!item.complete && (
                  <span className="flex items-center gap-1 text-xs text-neon-cyan opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.linkLabel}
                    <ChevronRight className="w-3 h-3" />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </NeonCard>
  );
}
