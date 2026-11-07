import { ANNOUNCE_KINDS, SNOWFLAKE_RE, type AnnounceKind } from '../lib/announceRoutes';
import { useGuildChannels, channelOptionLabel } from '../hooks/useGuildChannels';

/**
 * Room Settings -> Discord -> **Announcement channels** (v2.221.0, E8;
 * Top-score posts v2.226.0, E16).
 *
 * Edits the one `DISCORD_ANNOUNCE_ROUTES` key that the server's
 * `resolveAnnouncementChannelId` reads (through `parseAnnounceRoutes`,
 * `src/utils/discordAnnounceRoutes.ts`): which channel each KIND of bot post
 * goes to. A kind left on "Room default channel" uses
 * `DISCORD_ANNOUNCEMENT_CHANNEL_ID` - except Top-score posts, which follow the
 * Tournament posts route first. A tournament's own Announcements setting
 * (catch-all channel or per-category overrides) beats every route.
 *
 * Instant-save via `onSaveNow` (the page's optimistic save + toast), like
 * DiscordCommandPolicy - never the Save bar. The channel list includes forums
 * (`?forums=1`); a forum target gets a new post per message.
 */

export const DISCORD_ANNOUNCE_ROUTES_KEY = 'DISCORD_ANNOUNCE_ROUTES';

type Kind = AnnounceKind;

/** Mirrors `ANNOUNCE_KINDS` in src/utils/discordAnnounceRoutes.ts. */
const KINDS = ANNOUNCE_KINDS;

type Routes = Record<Kind, string | null>;

function parseRoutes(raw: string | undefined): Routes {
  const out: Routes = { tournament: null, picks: null, polls: null, scores: null };
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const obj = parsed as { version?: unknown; routes?: unknown };
  if (obj.version !== 1 || typeof obj.routes !== 'object' || obj.routes === null) return out;
  const routes = obj.routes as Record<string, unknown>;
  for (const { kind } of KINDS) {
    const v = routes[kind];
    if (typeof v === 'string' && SNOWFLAKE_RE.test(v)) out[kind] = v;
  }
  return out;
}

/** '' (row removed) when every kind is on the room default. */
function serializeRoutes(routes: Routes): string {
  const kept: Partial<Record<Kind, string>> = {};
  for (const { kind } of KINDS) {
    const v = routes[kind];
    if (v) kept[kind] = v;
  }
  if (Object.keys(kept).length === 0) return '';
  return JSON.stringify({ version: 1, routes: kept });
}

interface Props {
  roomId: string;
  settings: Record<string, string>;
  /** The page's instant-save (optimistic, reverts on failure). */
  onSaveNow: (patch: Record<string, string>) => void | Promise<void>;
}

export default function DiscordAnnounceRoutes({ roomId, settings, onSaveNow }: Props) {
  const routes = parseRoutes(settings[DISCORD_ANNOUNCE_ROUTES_KEY]);
  const { channels, groups, error: channelsMessage } = useGuildChannels(roomId);

  const change = (kind: Kind, channelId: string) => {
    const value = serializeRoutes({ ...routes, [kind]: channelId || null });
    if (value === (settings[DISCORD_ANNOUNCE_ROUTES_KEY] ?? '')) return;
    onSaveNow({ [DISCORD_ANNOUNCE_ROUTES_KEY]: value });
  };

  return (
    <div className="pt-3 mt-3 border-t border-border/30 space-y-3" data-testid="discord-announce-routes">
      <div>
        <p className="text-sm font-medium text-primary">Announcement channels</p>
        <p className="text-xs text-muted">
          Where each kind of post goes. Anything left on Room default uses the Default Announcement Channel above.
          A tournament&rsquo;s own Announcements setting overrides these.
        </p>
        {channelsMessage && <p className="text-xs text-neon-magenta mt-1">{channelsMessage}</p>}
      </div>

      <div className="divide-y divide-border/40">
        {KINDS.map(({ kind, label, description }) => {
          const selected = routes[kind] ?? '';
          const unknown = !!selected && !channels.some(c => c.id === selected);
          const selectId = `announce-route-${kind}`;
          return (
            <div key={kind} className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="min-w-0">
                <label htmlFor={selectId} className="text-sm text-primary">{label}</label>
                <p className="text-xs text-muted">{description}</p>
                {kind === 'polls' && (
                  <p className="text-xs text-faint">A forum gets a new post per poll, titled with the poll question.</p>
                )}
                {kind === 'scores' && (
                  <p className="text-xs text-faint">Same as Tournament posts unless set.</p>
                )}
              </div>
              <select
                id={selectId}
                data-testid={selectId}
                value={selected}
                onChange={e => change(kind, e.target.value)}
                className="min-h-[44px] w-full sm:w-64 rounded border border-border bg-raised px-2 text-sm text-primary"
              >
                <option value="">{kind === 'scores' ? 'Same as Tournament posts' : 'Room default channel'}</option>
                {unknown && <option value={selected}>Unknown channel (no longer in the server)</option>}
                {groups.map((g, i) => g.parent ? (
                  <optgroup key={`${g.parent}-${i}`} label={g.parent}>
                    {g.channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
                  </optgroup>
                ) : (
                  g.channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
