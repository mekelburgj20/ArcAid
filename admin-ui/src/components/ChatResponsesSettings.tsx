import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { InfoTip } from './Tooltip';
import {
  CALLOUT_CATEGORIES,
  CALLOUT_CATEGORY_LABELS,
  type CalloutCategory,
} from '../lib/callouts';

/**
 * Room Settings → Discord → **Arcaid Chat Responses** (v2.125.0).
 *
 * Replaces v2.123.0's single toggle + single channel field. Lives in its own
 * component rather than inline in `Settings.tsx` for two reasons: the block is
 * four controls deep with a network fetch of its own, and `Settings.tsx` is a
 * CRLF file where a large inline addition is a large risky diff.
 *
 * The four keys it writes are the ones `ChatResponseSettingsService` reads.
 *
 * EVERY CONTROL HERE COMMITS ON INTERACTION — it does NOT ride the page's Save
 * bar. That is the one thing about this component you must not "simplify": the
 * owner flipped the old toggle off, never pressed Save, and the bot carried on
 * replying in their server. A switch that shows OFF while the system is ON is
 * worse than no switch. The rest of the Discord card (guild id, role id,
 * announcement channel) is ordinary form input and still saves with the button.
 *
 * The cooldown is a free-text number, so it commits on a 700ms debounce AND on
 * blur/Enter rather than per keystroke. The debounce is what makes it safe to
 * keep off the Save bar: nothing is lost if the admin types a value and
 * navigates away, which is exactly the failure the Save bar used to catch.
 */

export const CHAT_RESPONSES_ENABLED_KEY = 'CHAT_RESPONSES_ENABLED';
export const CHAT_RESPONSES_CATEGORIES_KEY = 'CHAT_RESPONSES_CATEGORIES';
export const CHAT_RESPONSES_CHANNELS_KEY = 'CHAT_RESPONSES_CHANNEL_IDS';
export const CHAT_RESPONSES_COOLDOWN_KEY = 'CHAT_RESPONSES_COOLDOWN_SEC';

/** Mirrors `DEFAULT_ENABLED_CATEGORIES` on the backend. */
const DEFAULT_CATEGORIES: CalloutCategory[] = ['help', 'callouts'];
const DEFAULT_COOLDOWN_SEC = 30;
/** How long after the last keystroke the cooldown field commits itself. */
const COOLDOWN_COMMIT_MS = 700;

const CATEGORY_HELP: Record<CalloutCategory, string> = {
  help: "Answers to real questions — what's active, how long the round has left, who's winning, whose pick it is, how to submit a score. Never rate limited.",
  callouts: 'The classic table callouts: someone names a game, the bot has something to say about it.',
  banter: 'Replies about the bot itself.',
  easter_eggs: 'The deliberately obscure ones. Off unless you want them.',
};

interface GuildChannel {
  id: string;
  name: string;
  parent: string | null;
}

interface Props {
  roomId: string;
  settings: Record<string, string>;
  /**
   * Commits the given keys immediately (optimistic, reverts on failure) and
   * keeps them out of the page's dirty diff. NOT the page's `handleChange` —
   * see the note at the top of this file.
   */
  onSaveNow: (patch: Record<string, string>) => void | Promise<void>;
  /** Whether the room has a Discord guild linked — gates the channel fetch. */
  hasGuild: boolean;
}

/** Tolerant read of a stored JSON array; anything unparseable reads as empty. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return raw.split(',').map(v => v.trim()).filter(Boolean);
  }
}

const inputClass =
  'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors';

export default function ChatResponsesSettings({ roomId, settings, onSaveNow, hasGuild }: Props) {
  const enabled = settings[CHAT_RESPONSES_ENABLED_KEY] === 'true';
  const storedCategories = settings[CHAT_RESPONSES_CATEGORIES_KEY];
  // Absent === the defaults, matching the backend. An explicitly empty array is
  // a real answer ("all of them off") and is NOT re-defaulted.
  const categories = storedCategories === undefined
    ? DEFAULT_CATEGORIES
    : (parseList(storedCategories) as CalloutCategory[]);
  const channelIds = parseList(settings[CHAT_RESPONSES_CHANNELS_KEY]);
  const cooldown = settings[CHAT_RESPONSES_COOLDOWN_KEY] ?? String(DEFAULT_COOLDOWN_SEC);

  // The cooldown is the one control here that is typed rather than clicked, so
  // it keeps a local draft: committing per keystroke would POST "4" on the way
  // to "45". The debounce below commits it without the admin doing anything,
  // and the blur/Enter handlers flush it early.
  const [cooldownDraft, setCooldownDraft] = useState<string | null>(null);
  const cooldownTimer = useRef<number | null>(null);

  const [channels, setChannels] = useState<GuildChannel[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [manualId, setManualId] = useState('');

  // Fetched only once the room is actually using the feature — an admin who
  // never turns it on should not pay for a gateway lookup on every page view.
  useEffect(() => {
    if (!enabled || !hasGuild) return;
    let cancelled = false;
    setChannelsLoading(true);
    setChannelError(null);
    api.get<{ channels: GuildChannel[] }>(`/rooms/${roomId}/admin/discord/channels`)
      .then(data => { if (!cancelled) setChannels(data.channels ?? []); })
      .catch(err => {
        // The endpoint answers 400 with copy that names the actual problem
        // (no guild / bot not in it / gateway down). Surfaced verbatim: each
        // has a different fix, and the paste-an-ID field below still works.
        if (!cancelled) setChannelError((err as Error).message || 'Could not load channels.');
      })
      .finally(() => { if (!cancelled) setChannelsLoading(false); });
    return () => { cancelled = true; };
  }, [roomId, enabled, hasGuild]);

  const toggleMaster = () => {
    const next = !enabled;
    const patch: Record<string, string> = {
      [CHAT_RESPONSES_ENABLED_KEY]: next ? 'true' : 'false',
    };
    // Turning it on with nothing chosen seeds the safe pair rather than
    // leaving the sub-toggles reading as "all off" while the backend quietly
    // applies its own default — the UI and the bot must agree on sight. Both
    // keys go in ONE request so the room can never be left enabled-with-no-
    // categories by a half-failed save.
    if (next && storedCategories === undefined) {
      patch[CHAT_RESPONSES_CATEGORIES_KEY] = JSON.stringify(DEFAULT_CATEGORIES);
    }
    onSaveNow(patch);
  };

  const toggleCategory = (category: CalloutCategory) => {
    const next = categories.includes(category)
      ? categories.filter(c => c !== category)
      : [...CALLOUT_CATEGORIES].filter(c => categories.includes(c) || c === category);
    onSaveNow({ [CHAT_RESPONSES_CATEGORIES_KEY]: JSON.stringify(next) });
  };

  const setChannels_ = (next: string[]) => {
    // An empty list means "any channel", which is the ABSENT state — writing
    // "[]" would store a row that says the same thing in a way the backend has
    // to special-case. Empty string deletes the row (GameRoomSettingsService).
    onSaveNow({ [CHAT_RESPONSES_CHANNELS_KEY]: next.length > 0 ? JSON.stringify(next) : '' });
  };

  const toggleChannel = (id: string) => {
    setChannels_(channelIds.includes(id) ? channelIds.filter(c => c !== id) : [...channelIds, id]);
  };

  const addManual = () => {
    const id = manualId.trim();
    if (!id || channelIds.includes(id)) { setManualId(''); return; }
    setChannels_([...channelIds, id]);
    setManualId('');
  };

  const clearCooldownTimer = () => {
    if (cooldownTimer.current !== null) {
      window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = null;
    }
  };

  const commitCooldown = (raw: string) => {
    clearCooldownTimer();
    setCooldownDraft(null);
    const trimmed = raw.trim();
    // Empty clears the row back to the 30s default; anything non-numeric is
    // ignored rather than stored, since the backend would silently fall back to
    // 30 and the field would then disagree with the bot.
    if (trimmed === '') {
      if (settings[CHAT_RESPONSES_COOLDOWN_KEY] !== undefined) {
        onSaveNow({ [CHAT_RESPONSES_COOLDOWN_KEY]: '' });
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const value = String(Math.floor(parsed));
    if (value === settings[CHAT_RESPONSES_COOLDOWN_KEY]) return;
    onSaveNow({ [CHAT_RESPONSES_COOLDOWN_KEY]: value });
  };

  const onCooldownInput = (raw: string) => {
    setCooldownDraft(raw);
    clearCooldownTimer();
    cooldownTimer.current = window.setTimeout(() => commitCooldown(raw), COOLDOWN_COMMIT_MS);
  };

  // A pending keystroke must not be lost to an unmount — this block is not on
  // the Save bar, so there is nothing else to catch it.
  useEffect(() => () => clearCooldownTimer(), []);

  const nameFor = (id: string) => channels.find(c => c.id === id)?.name ?? id;

  return (
    <div className="pt-3 mt-3 border-t border-border/30 space-y-4" data-testid="chat-responses-settings">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">Arcaid Chat Responses</p>
          <p className="text-xs text-muted">
            When on, the bot replies to ordinary chat in this room&rsquo;s Discord server &mdash;
            answering questions like &ldquo;how long left?&rdquo; and &ldquo;who&rsquo;s
            winning?&rdquo;, and calling out table names. The list of triggers and replies is global
            and maintained by the super admin; you choose which kinds you want below.
          </p>
        </div>
        <button
          onClick={toggleMaster}
          role="switch"
          aria-checked={enabled}
          aria-label="Arcaid Chat Responses"
          className={`relative shrink-0 w-12 h-6 min-h-[44px] flex items-center rounded-full transition-colors cursor-pointer border-none bg-transparent`}
        >
          <span
            className={`relative block w-12 h-6 rounded-full transition-colors ${
              enabled ? 'bg-neon-cyan' : 'bg-raised border border-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                enabled ? 'translate-x-6' : ''
              }`}
            />
          </span>
        </button>
      </div>

      {/* Sub-toggles stay VISIBLE but inert while the master is off: hiding
          them would make the room's stored choices invisible and reset-looking
          the moment someone toggles the feature off and on again. */}
      <div className={enabled ? '' : 'opacity-50 pointer-events-none'} aria-disabled={!enabled}>
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2">
          What the bot may reply to
        </p>
        <div className="space-y-2">
          {CALLOUT_CATEGORIES.map(category => {
            const on = categories.includes(category);
            return (
              <div key={category} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-primary">{CALLOUT_CATEGORY_LABELS[category]}</p>
                  <p className="text-xs text-muted">{CATEGORY_HELP[category]}</p>
                </div>
                <button
                  onClick={() => toggleCategory(category)}
                  role="switch"
                  aria-checked={on}
                  aria-label={CALLOUT_CATEGORY_LABELS[category]}
                  disabled={!enabled}
                  data-testid={`chat-category-${category}`}
                  className="relative shrink-0 min-h-[44px] flex items-center cursor-pointer border-none bg-transparent"
                >
                  <span
                    className={`relative block w-12 h-6 rounded-full transition-colors ${
                      on ? 'bg-neon-cyan' : 'bg-raised border border-border'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                        on ? 'translate-x-6' : ''
                      }`}
                    />
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-1 flex items-center">
            Allowed channels
            <InfoTip text="Leave empty to let the bot reply anywhere it can read. Pick one or more channels to confine it to those." />
          </p>

          {channelIds.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-2" data-testid="chat-channel-chips">
              {channelIds.map(id => (
                <button
                  key={id}
                  onClick={() => toggleChannel(id)}
                  aria-label={`Remove #${nameFor(id)}`}
                  className="px-2 py-1 min-h-[44px] rounded text-xs border border-neon-cyan/40 text-neon-cyan bg-neon-cyan/10 cursor-pointer"
                >
                  #{nameFor(id)} &times;
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-faint mb-2">
              Any channel the bot can read.
            </p>
          )}

          {channelsLoading && <p className="text-xs text-faint">Loading channels&hellip;</p>}
          {channelError && <p className="text-xs text-neon-magenta mb-2">{channelError}</p>}

          {channels.length > 0 && (
            <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/40">
              {channels.map(channel => {
                const on = channelIds.includes(channel.id);
                return (
                  <button
                    key={channel.id}
                    onClick={() => toggleChannel(channel.id)}
                    aria-pressed={on}
                    className={`w-full min-h-[44px] px-3 py-2 flex items-center justify-between gap-3 text-left cursor-pointer border-none transition-colors ${
                      on ? 'bg-neon-cyan/10 text-neon-cyan' : 'bg-transparent text-muted hover:text-primary'
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      #{channel.name}
                      {channel.parent && (
                        <span className="ml-2 text-xs text-faint">{channel.parent}</span>
                      )}
                    </span>
                    <span className="text-xs shrink-0">{on ? 'Allowed' : 'Add'}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Always present, not just on error: a brand-new channel the bot has
              not cached yet, or a private one, is still pasteable. */}
          <div className="flex items-center gap-2 mt-2">
            <input
              type="text"
              aria-label="Channel ID"
              placeholder="Or paste a channel ID"
              value={manualId}
              onChange={e => setManualId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
              className={`${inputClass} flex-1`}
            />
            <button
              onClick={addManual}
              disabled={!manualId.trim()}
              className="px-3 min-h-[44px] rounded border border-border text-sm text-muted hover:text-primary disabled:opacity-40 cursor-pointer bg-transparent"
            >
              Add
            </button>
          </div>
        </div>

        {/* Stacks below ~640px: the 16rem label plus an input is wider than a
            390px viewport, which squeezed the number field to a sliver. */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mt-4">
          <label className="w-full sm:w-64 shrink-0 text-sm font-mono text-muted flex items-center" htmlFor="chat-responses-cooldown">
            Cooldown (seconds)
            <InfoTip text="How long the bot waits between fun replies in the same channel. Helpful answers ignore this — a question always gets an answer." />
          </label>
          <input
            id="chat-responses-cooldown"
            type="number"
            min={0}
            max={3600}
            placeholder={String(DEFAULT_COOLDOWN_SEC)}
            value={cooldownDraft ?? cooldown}
            onChange={e => onCooldownInput(e.target.value)}
            onBlur={e => commitCooldown(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCooldown((e.target as HTMLInputElement).value); } }}
            className={`${inputClass} flex-1 min-h-[44px]`}
          />
        </div>
      </div>
    </div>
  );
}
