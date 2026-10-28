import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

/**
 * G6 — "Add the Arcaid bot to your server", at the top of room Settings →
 * Discord. Setting the Guild ID alone does not put the bot in that server
 * (Spectre, probros_gaming, 2026-10-27): someone with Manage Server has to
 * authorize it once. The link comes from the server (one permission set,
 * `src/utils/discordBotInvite.ts`) and pre-selects the server whose Guild ID
 * is typed. When that Guild ID is the SAVED one, the room health check says
 * whether the bot is in it now.
 */

interface HealthDiscord { enabled: boolean; ready: boolean; inGuild: boolean | null; guildId: string | null }

export default function DiscordBotInvite({ roomId, guildId }: { roomId: string; guildId: string }) {
  const typedGuild = guildId.trim();
  const [url, setUrl] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthDiscord | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    const q = typedGuild ? `?guildId=${encodeURIComponent(typedGuild)}` : '';
    api.get<{ url?: string | null }>(`/auth/discord/bot-invite${q}`)
      .then(r => { if (live) setUrl(typeof r?.url === 'string' ? r.url : null); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [typedGuild]);

  const fetchHealth = useCallback(
    () => api.get<{ discord?: HealthDiscord }>(`/rooms/${roomId}/admin/health`)
      .then(r => r?.discord ?? null)
      .catch(() => null),
    [roomId],
  );

  useEffect(() => {
    let live = true;
    fetchHealth().then(d => { if (live) setHealth(d); });
    return () => { live = false; };
  }, [fetchHealth]);

  const recheck = () => {
    setChecking(true);
    fetchHealth().then(setHealth).finally(() => setChecking(false));
  };

  if (!url) return null;

  // Status only for the saved server: the health check knows nothing about an
  // unsaved Guild ID, and an offline bot can't tell us either way.
  const savedMatches = !!health && !!typedGuild && health.guildId === typedGuild;
  let status: { text: string; tone: string } | null = null;
  if (savedMatches && health!.enabled && health!.ready && health!.inGuild !== null) {
    status = health!.inGuild
      ? { text: 'The bot is in this server.', tone: 'text-neon-green' }
      : { text: 'The bot is not in this server yet.', tone: 'text-neon-amber' };
  }

  return (
    <div className="mb-3 px-3 py-2 rounded border border-border bg-raised/40 text-xs text-muted space-y-2">
      <div>
        <strong className="text-primary">Add the Arcaid bot to your server.</strong>{' '}
        Setting the Guild ID does not add the bot. Open this link as someone with <strong>Manage Server</strong>,
        pick your server and press <strong>Authorize</strong>.
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10 no-underline"
        >
          <ExternalLink size={13} aria-hidden="true" /> Add the bot to Discord
        </a>
        {status && <span className={status.tone} role="status">{status.text}</span>}
        {savedMatches && (
          <button
            type="button"
            onClick={recheck}
            disabled={checking}
            className="inline-flex items-center gap-1 text-faint hover:text-muted bg-transparent border-none cursor-pointer disabled:opacity-50"
          >
            <RefreshCw size={12} aria-hidden="true" /> {checking ? 'Checking…' : 'Check again'}
          </button>
        )}
      </div>
    </div>
  );
}
