import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { parseRoleIdsValue, serializeRoleIds } from '../lib/joinRoleIds';

/**
 * v2.213.0 - the `DISCORD_JOIN_ROLE_IDS` editor on room Settings: a checkbox
 * list of the linked Discord server's roles (from
 * `GET /rooms/:roomId/admin/discord/roles`), with a plain role-id field as the
 * fallback when the bot cannot list them (offline, not in the server, no
 * server linked). The stored value is a JSON array of role id strings; an
 * empty selection stores '' (the row is removed).
 */
interface GuildRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

export default function DiscordJoinRolePicker({
  roomId, value, onChange, label, caption,
}: {
  roomId: string;
  value: string | undefined;
  onChange: (next: string) => void;
  label: string;
  caption?: string;
}) {
  const selected = parseRoleIdsValue(value);
  const [roles, setRoles] = useState<GuildRole[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [typed, setTyped] = useState(selected.join(', '));

  useEffect(() => {
    let cancelled = false;
    api.get<{ roles?: GuildRole[]; message?: string }>(`/rooms/${roomId}/admin/discord/roles`)
      .then(data => {
        if (cancelled) return;
        setRoles(data?.roles ?? []);
        setMessage(data?.message ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        setRoles([]);
        setMessage((err as Error)?.message || 'Could not load the server roles.');
      });
    return () => { cancelled = true; };
  }, [roomId]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id];
    onChange(serializeRoleIds(next));
  };

  const listed = roles ?? [];
  const unknownSelected = selected.filter(id => !listed.some(r => r.id === id));

  return (
    <div className="space-y-2" data-testid="discord-join-roles">
      <div>
        <p className="text-sm font-medium text-primary">{label}</p>
        {caption && <p className="text-xs text-muted">{caption}</p>}
      </div>
      {roles === null ? (
        <p className="text-xs text-muted">Loading roles...</p>
      ) : listed.length > 0 ? (
        <div className="max-h-56 overflow-y-auto rounded border border-border bg-raised p-2 space-y-1">
          {listed.map(role => (
            <label key={role.id} className="flex items-center gap-2 text-sm text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(role.id)}
                onChange={() => toggle(role.id)}
              />
              <span>{role.name}</span>
              {role.managed && <span className="text-xs text-faint">(bot role)</span>}
            </label>
          ))}
          {unknownSelected.map(id => (
            <label key={id} className="flex items-center gap-2 text-sm text-muted cursor-pointer">
              <input type="checkbox" checked onChange={() => toggle(id)} />
              <span>{id} (not found in the server)</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {message && <p className="text-xs text-muted">{message}</p>}
          <input
            type="text"
            value={typed}
            placeholder="Role IDs, separated by commas"
            onChange={e => {
              setTyped(e.target.value);
              onChange(serializeRoleIds(e.target.value.split(/[\s,]+/)));
            }}
            className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
          />
        </div>
      )}
    </div>
  );
}
