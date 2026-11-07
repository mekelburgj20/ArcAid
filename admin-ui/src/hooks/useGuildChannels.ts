import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * The room's Discord guild channels for an announcement-channel picker
 * (`GET /rooms/:roomId/admin/discord/channels?forums=1`), grouped by parent
 * category in the server's own order. Shared by Room Settings ->
 * Announcement channels and the tournament form (v2.226.0, E16).
 *
 * `error` is set when the list could not be loaded (bot not in the guild,
 * Discord off); callers then offer a raw channel-ID input instead.
 */

export interface GuildChannel { id: string; name: string; parent: string | null; type?: 'text' | 'announcement' | 'forum' }

export interface GuildChannelGroup { parent: string | null; channels: GuildChannel[] }

export function groupChannels(channels: GuildChannel[]): GuildChannelGroup[] {
  const groups: GuildChannelGroup[] = [];
  for (const c of channels) {
    const last = groups[groups.length - 1];
    if (last && last.parent === c.parent) last.channels.push(c);
    else groups.push({ parent: c.parent, channels: [c] });
  }
  return groups;
}

export const channelOptionLabel = (c: GuildChannel) => `#${c.name}${c.type === 'forum' ? ' (forum)' : ''}`;

export function useGuildChannels(roomId: string | undefined) {
  const [channels, setChannels] = useState<GuildChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    api.get<{ channels?: GuildChannel[] }>(`/rooms/${roomId}/admin/discord/channels?forums=1`)
      .then(data => { if (!cancelled) { setChannels(Array.isArray(data?.channels) ? data.channels : []); setLoaded(true); } })
      .catch(err => { if (!cancelled) { setError((err as Error)?.message || 'Could not load channels.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [roomId]);

  return { channels, groups: groupChannels(channels), error, loaded: loaded || !roomId };
}
