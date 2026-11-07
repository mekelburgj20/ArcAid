import { useState } from 'react';
import { ANNOUNCE_KINDS, ANNOUNCE_NONE, SNOWFLAKE_RE, type AnnounceKind, type TournamentAnnounceRoutes as Routes } from '../lib/announceRoutes';
import { useGuildChannels, channelOptionLabel } from '../hooks/useGuildChannels';

/**
 * Tournament form -> Announcements -> **Customize per category** (v2.226.0, E16).
 *
 * One row per announcement kind; each picks Room default / Don't post / a
 * guild channel. Stored as `tournaments.discord_announce_routes` (the
 * server's `parseTournamentAnnounceRoutes` is the only reader); a per-kind
 * entry beats the tournament's catch-all `discord_channel_id`, which beats
 * the room's own routes (`resolveAnnouncementChannelId`).
 *
 * When the channel list cannot load (bot not in the guild, Discord off) each
 * row offers "A specific channel ID…" with a text input, so a stored raw id
 * still renders and stays editable. A raw id is never shown when a channel
 * name is available.
 */

const ID_OPTION = '__id__';

interface Props {
  roomId?: string;
  /** The tournament's catch-all `discord_channel_id` ('' / a snowflake; never 'none' here). */
  catchAll: string;
  routes: Routes;
  onChange: (routes: Routes) => void;
}

export default function TournamentAnnounceRoutes({ roomId, catchAll, routes, onChange }: Props) {
  const { channels, groups, error, loaded } = useGuildChannels(roomId);
  const listUnavailable = !!error || (loaded && channels.length === 0);
  // Rows the admin switched to "A specific channel ID…" (typing in progress).
  const [idRows, setIdRows] = useState<ReadonlySet<AnnounceKind>>(new Set());

  const setRow = (kind: AnnounceKind, value: string) => onChange({ ...routes, [kind]: value });
  const markId = (kind: AnnounceKind, on: boolean) => setIdRows(prev => {
    const next = new Set(prev);
    if (on) next.add(kind); else next.delete(kind);
    return next;
  });

  const legacyChannel = catchAll && catchAll !== ANNOUNCE_NONE ? catchAll : '';
  const legacyName = legacyChannel ? channels.find(c => c.id === legacyChannel)?.name : undefined;

  return (
    <div className="mb-4 rounded border border-border/60 p-3" data-testid="tournament-announce-routes">
      <p className="text-xs text-muted mb-2">
        Where each kind of post for this tournament goes. Room default follows the room&rsquo;s Announcement channels.
      </p>
      {error && <p className="text-xs text-neon-magenta mb-2">Could not load the server&rsquo;s channels ({error}). Paste channel IDs instead.</p>}
      <div className="divide-y divide-border/40">
        {ANNOUNCE_KINDS.map(({ kind, label, description }) => {
          const value = routes[kind] ?? '';
          const known = channels.some(c => c.id === value);
          const isId = idRows.has(kind)
            || (!!value && value !== ANNOUNCE_NONE && !known && listUnavailable);
          const selectValue = isId ? ID_OPTION : value;
          const unknown = !isId && !!value && value !== ANNOUNCE_NONE && !known && loaded;
          const selectId = `tournament-announce-${kind}`;
          const badId = isId && value !== '' && !SNOWFLAKE_RE.test(value.trim());
          return (
            <div key={kind} className="py-2 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div className="min-w-0">
                <label htmlFor={selectId} className="text-sm text-primary">{label}</label>
                <p className="text-xs text-muted">{description}</p>
              </div>
              <div className="w-full sm:w-64 shrink-0">
                <select
                  id={selectId}
                  data-testid={selectId}
                  value={selectValue}
                  onChange={e => {
                    const v = e.target.value;
                    if (v === ID_OPTION) {
                      markId(kind, true);
                      if (value === ANNOUNCE_NONE) setRow(kind, '');
                      return;
                    }
                    markId(kind, false);
                    setRow(kind, v);
                  }}
                  className="min-h-[44px] w-full rounded border border-border bg-raised px-2 text-sm text-primary"
                >
                  <option value="">Room default</option>
                  <option value={ANNOUNCE_NONE}>Don&rsquo;t post</option>
                  {unknown && <option value={value}>Unknown channel (no longer in the server)</option>}
                  {groups.map((g, i) => g.parent ? (
                    <optgroup key={`${g.parent}-${i}`} label={g.parent}>
                      {g.channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
                    </optgroup>
                  ) : (
                    g.channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)
                  ))}
                  {(listUnavailable || isId) && <option value={ID_OPTION}>A specific channel ID…</option>}
                </select>
                {isId && (
                  <>
                    <input
                      type="text"
                      aria-label={`${label} channel ID`}
                      data-testid={`${selectId}-id`}
                      placeholder="Channel ID (right-click the channel → Copy Channel ID)"
                      value={value === ANNOUNCE_NONE ? '' : value}
                      onChange={e => setRow(kind, e.target.value.trim())}
                      className="mt-1.5 w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors font-mono"
                    />
                    {badId && <p className="text-xs text-neon-magenta mt-1">That is not a channel ID (digits only); it will not be saved.</p>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {legacyChannel && (
        <p className="text-xs text-faint mt-2" data-testid="tournament-announce-legacy">
          All categories currently go to {legacyName ? `#${legacyName}` : `channel ${legacyChannel}`} (the tournament&rsquo;s
          channel). Pick a channel per row to override it, or choose Room defaults to clear it.
        </p>
      )}
    </div>
  );
}
