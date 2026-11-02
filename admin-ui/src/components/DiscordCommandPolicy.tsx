import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Room Settings -> Discord -> **Slash commands** (v2.215.0, E7).
 *
 * Edits the one `DISCORD_COMMAND_POLICY` key that the bot's
 * `commandPolicyBlockReason` gate reads: which Arcaid slash commands the bot
 * answers in this room's Discord server, and which channels / roles each one
 * is limited to. Rules (mirrors `src/utils/discordCommandPolicy.ts`):
 *   - a command not in `commands` is enabled and uses the defaults;
 *   - a command's channel (or role) list, when non-empty, replaces the default
 *     list; an empty list everywhere means "any";
 *   - holding ANY listed role passes the role test.
 *
 * Like ChatResponsesSettings, EVERY CONTROL HERE COMMITS ON INTERACTION via
 * `onSaveNow` (optimistic, rolled back by the page on failure) - never the
 * Save bar. A command that reads "off" here while the bot still answers it
 * would be worse than no switch at all.
 *
 * The command list comes from the LIVE bot (`/admin/discord/commands`) so no
 * name is hardcoded here. Ids are never shown to the admin: a stored id the
 * server no longer lists renders as "Unknown channel" / "Unknown role".
 */

export const DISCORD_COMMAND_POLICY_KEY = 'DISCORD_COMMAND_POLICY';

const SNOWFLAKE_RE = /^\d{5,25}$/;

interface Rule {
  enabled: boolean;
  channelIds: string[];
  roleIds: string[];
}

interface Policy {
  version: 1;
  defaults: { channelIds: string[]; roleIds: string[] };
  commands: Record<string, Rule>;
}

interface BotCommand { name: string; description: string }
interface GuildChannel { id: string; name: string; parent: string | null }
interface GuildRole { id: string; name: string; position: number; managed: boolean }

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map(x => String(x)).filter(x => SNOWFLAKE_RE.test(x))));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tolerant read; anything unparseable is the allow-everything policy. */
function parsePolicy(raw: string | undefined): Policy {
  const policy: Policy = { version: 1, defaults: { channelIds: [], roleIds: [] }, commands: {} };
  if (!raw) return policy;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return policy; }
  if (!isObj(parsed)) return policy;
  if (isObj(parsed.defaults)) {
    policy.defaults = { channelIds: ids(parsed.defaults.channelIds), roleIds: ids(parsed.defaults.roleIds) };
  }
  if (isObj(parsed.commands)) {
    for (const [name, rule] of Object.entries(parsed.commands)) {
      if (!isObj(rule)) continue;
      policy.commands[name] = { enabled: rule.enabled !== false, channelIds: ids(rule.channelIds), roleIds: ids(rule.roleIds) };
    }
  }
  return policy;
}

/** '' (row removed) when nothing is restricted; drops no-op command rows. */
function serializePolicy(policy: Policy): string {
  const commands: Record<string, Rule> = {};
  for (const [name, rule] of Object.entries(policy.commands)) {
    if (!rule.enabled || rule.channelIds.length > 0 || rule.roleIds.length > 0) commands[name] = rule;
  }
  const empty = policy.defaults.channelIds.length === 0 && policy.defaults.roleIds.length === 0
    && Object.keys(commands).length === 0;
  if (empty) return '';
  return JSON.stringify({ version: 1, defaults: policy.defaults, commands });
}

interface Props {
  roomId: string;
  settings: Record<string, string>;
  /** The page's instant-save (optimistic, reverts on failure). */
  onSaveNow: (patch: Record<string, string>) => void | Promise<void>;
}

interface Option { id: string; label: string; hint?: string | null }

function MultiPick({
  label, emptyText, options, selected, unknownLabel, unavailable, onChange, testId,
}: {
  label: string;
  emptyText: string;
  options: Option[];
  selected: string[];
  unknownLabel: string;
  unavailable: string | null;
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const nameOf = (id: string) => options.find(o => o.id === id)?.label ?? unknownLabel;
  const summary = selected.length === 0 ? emptyText : selected.map(nameOf).join(', ');
  const unknown = selected.filter(id => !options.some(o => o.id === id));
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id]);
  return (
    <details className="min-w-0 flex-1" data-testid={testId}>
      <summary className="cursor-pointer text-xs text-muted hover:text-primary min-h-[44px] flex items-center gap-1">
        <span className="text-faint shrink-0">{label}:</span>
        <span className={selected.length === 0 ? 'text-faint' : 'text-neon-cyan'}>{summary}</span>
      </summary>
      <div className="mt-1 max-h-48 overflow-y-auto rounded border border-border bg-raised p-2 space-y-1">
        {options.length === 0 && unknown.length === 0 && (
          <p className="text-xs text-muted">{unavailable ?? 'Nothing to choose from.'}</p>
        )}
        {options.map(o => (
          <label key={o.id} className="flex items-center gap-2 text-sm text-primary cursor-pointer">
            <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
            <span>{o.label}</span>
            {o.hint && <span className="text-xs text-faint">{o.hint}</span>}
          </label>
        ))}
        {unknown.map(id => (
          <label key={id} className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked onChange={() => toggle(id)} />
            <span>{unknownLabel} (no longer in the server)</span>
          </label>
        ))}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none px-0 min-h-[32px]"
          >
            Clear
          </button>
        )}
      </div>
    </details>
  );
}

export default function DiscordCommandPolicy({ roomId, settings, onSaveNow }: Props) {
  const policy = parsePolicy(settings[DISCORD_COMMAND_POLICY_KEY]);

  const [commands, setCommands] = useState<BotCommand[] | null>(null);
  const [commandsMessage, setCommandsMessage] = useState<string | null>(null);
  const [channels, setChannels] = useState<GuildChannel[]>([]);
  const [channelsMessage, setChannelsMessage] = useState<string | null>(null);
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [rolesMessage, setRolesMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ commands?: BotCommand[]; message?: string }>(`/rooms/${roomId}/admin/discord/commands`)
      .then(data => {
        if (cancelled) return;
        setCommands(Array.isArray(data?.commands) ? data.commands : []);
        setCommandsMessage(data?.message ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        setCommands([]);
        setCommandsMessage((err as Error)?.message || 'Could not load the command list.');
      });
    api.get<{ channels?: GuildChannel[] }>(`/rooms/${roomId}/admin/discord/channels`)
      .then(data => { if (!cancelled) setChannels(Array.isArray(data?.channels) ? data.channels : []); })
      .catch(err => { if (!cancelled) setChannelsMessage((err as Error)?.message || 'Could not load channels.'); });
    api.get<{ roles?: GuildRole[]; message?: string }>(`/rooms/${roomId}/admin/discord/roles`)
      .then(data => {
        if (cancelled) return;
        setRoles(Array.isArray(data?.roles) ? data.roles : []);
        setRolesMessage(data?.message ?? null);
      })
      .catch(err => { if (!cancelled) setRolesMessage((err as Error)?.message || 'Could not load the server roles.'); });
    return () => { cancelled = true; };
  }, [roomId]);

  const save = (next: Policy) => {
    const value = serializePolicy(next);
    if (value === (settings[DISCORD_COMMAND_POLICY_KEY] ?? '')) return;
    onSaveNow({ [DISCORD_COMMAND_POLICY_KEY]: value });
  };

  const ruleFor = (name: string): Rule =>
    policy.commands[name] ?? { enabled: true, channelIds: [], roleIds: [] };

  const updateRule = (name: string, patch: Partial<Rule>) =>
    save({ ...policy, commands: { ...policy.commands, [name]: { ...ruleFor(name), ...patch } } });

  const channelOptions: Option[] = channels.map(c => ({ id: c.id, label: `#${c.name}`, hint: c.parent }));
  const roleOptions: Option[] = roles.map(r => ({ id: r.id, label: r.name, hint: r.managed ? '(bot role)' : null }));

  return (
    <div className="pt-3 mt-3 border-t border-border/30 space-y-3" data-testid="discord-command-policy">
      <div>
        <p className="text-sm font-medium text-primary">Slash commands</p>
        <p className="text-xs text-muted">
          Choose which Arcaid commands the bot answers in your server, and limit them to roles or channels. Leave a list empty to allow any.
        </p>
      </div>

      <div className="rounded border border-border/50 p-2">
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70">Defaults for every command</p>
        <div className="flex flex-col sm:flex-row sm:gap-3">
          <MultiPick
            label="Channels"
            emptyText="Any channel"
            options={channelOptions}
            selected={policy.defaults.channelIds}
            unknownLabel="Unknown channel"
            unavailable={channelsMessage}
            onChange={next => save({ ...policy, defaults: { ...policy.defaults, channelIds: next } })}
            testId="command-policy-default-channels"
          />
          <MultiPick
            label="Roles"
            emptyText="Any role"
            options={roleOptions}
            selected={policy.defaults.roleIds}
            unknownLabel="Unknown role"
            unavailable={rolesMessage}
            onChange={next => save({ ...policy, defaults: { ...policy.defaults, roleIds: next } })}
            testId="command-policy-default-roles"
          />
        </div>
      </div>

      {commands === null ? (
        <p className="text-xs text-faint">Loading commands...</p>
      ) : commands.length === 0 ? (
        <p className="text-xs text-muted">{commandsMessage ?? 'The bot reported no commands.'}</p>
      ) : (
        <div className="divide-y divide-border/40">
          {commands.map(cmd => {
            const rule = ruleFor(cmd.name);
            return (
              <div key={cmd.name} className="py-2" data-testid={`command-policy-row-${cmd.name}`}>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-mono text-primary">/{cmd.name}</p>
                    {cmd.description && <p className="text-xs text-muted">{cmd.description}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => updateRule(cmd.name, { enabled: !rule.enabled })}
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`Answer /${cmd.name}`}
                    className="relative shrink-0 min-h-[44px] flex items-center cursor-pointer border-none bg-transparent"
                  >
                    <span className={`relative block w-12 h-6 rounded-full transition-colors ${rule.enabled ? 'bg-neon-cyan' : 'bg-raised border border-border'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${rule.enabled ? 'translate-x-6' : ''}`} />
                    </span>
                  </button>
                </div>
                <div className={`flex flex-col sm:flex-row sm:gap-3 ${rule.enabled ? '' : 'opacity-50 pointer-events-none'}`} aria-disabled={!rule.enabled}>
                  <MultiPick
                    label="Channels"
                    emptyText="Using defaults"
                    options={channelOptions}
                    selected={rule.channelIds}
                    unknownLabel="Unknown channel"
                    unavailable={channelsMessage}
                    onChange={next => updateRule(cmd.name, { channelIds: next })}
                    testId={`command-policy-channels-${cmd.name}`}
                  />
                  <MultiPick
                    label="Roles"
                    emptyText="Using defaults"
                    options={roleOptions}
                    selected={rule.roleIds}
                    unknownLabel="Unknown role"
                    unavailable={rolesMessage}
                    onChange={next => updateRule(cmd.name, { roleIds: next })}
                    testId={`command-policy-roles-${cmd.name}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
