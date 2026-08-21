import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { PlayerAvatar } from './ScoreboardComponents';
import { api } from '../lib/api';
import { compareByRank } from '../lib/searchRank';

/**
 * Member-picker admin add (ROADMAP "membership & privacy arc" rider).
 *
 * Provider-agnostic promote-to-admin: room membership (`room_members.user_id`)
 * already stores a raw Discord snowflake OR a `google:<sub>` id, and the
 * admin-add endpoint (`POST /:roomId/admins/discord`) has accepted either
 * shape directly since v2.35.0 (D3.1) via `isProviderUserId`. Before this
 * component, the ONLY way to promote a Google-authed member was to already
 * know their opaque `google:*` id and paste it into the "advanced" free-text
 * field — practically impossible. This picker sources names + avatars from
 * the admin-only roster (`GET /:roomId/admin/members`, which — unlike the
 * public `/:slug/members` roster — ships the raw canonical id) and POSTs
 * that id straight through, so a Google member is promotable exactly like a
 * Discord member: pick a face, done.
 *
 * The free-text "paste a username or ID" flow in Settings.tsx is NOT
 * replaced — it stays as the escape hatch for granting admin to someone who
 * hasn't joined the room yet (so isn't in the roster this component reads).
 */

export interface PickableMember {
  userId: string;
  /**
   * Resolved server-side: global display name -> provider username -> the
   * room's claimed name. Still nullable (a member with none of the three),
   * which is why every render keeps its `|| userId` fallback.
   */
  displayName: string | null;
  /** Provider username, for disambiguating two members with the same label. */
  username?: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
}

interface MemberAdminPickerProps {
  /**
   * Required for the default (admin-add) mode — the POST target. Not read
   * when `onSelect` is provided, since that mode never calls the endpoint
   * itself; kept optional so select-mode callers don't need a room id at all.
   */
  roomId?: string;
  /** Full room roster — filtering out existing admins happens in here. */
  members: PickableMember[];
  /** Canonical ids of members who are already admins of this room. */
  excludeIds: Set<string>;
  /**
   * Called after a successful add, with the member that was promoted.
   * Required in default mode; unused (and not called) when `onSelect` is set.
   */
  onAdded?: (member: PickableMember) => void;
  /** Called on a failed add — parent decides how to surface it (toast, etc). */
  onError?: (message: string) => void;
  /**
   * Select-mode escape hatch (Picks nominee upgrade). When provided, clicking
   * a member calls this instead of POSTing `/rooms/:roomId/admins/discord` —
   * the component becomes a pure picker and the caller owns what "picking"
   * means (e.g. filling a nominee field). `roomId`/`onAdded` are ignored in
   * this mode.
   */
  onSelect?: (member: PickableMember) => void;
  /**
   * Copy overrides — the defaults are Settings.tsx's admin-add wording;
   * select-mode callers (e.g. the Picks nominee picker) pass their own so the
   * empty/label text matches what "picking" means there. Omitting any of
   * these keeps the exact original string (default-mode byte-identical).
   */
  label?: string;
  emptyMembersText?: string;
  allExcludedText?: string;
}

export default function MemberAdminPicker({
  roomId, members, excludeIds, onAdded, onError, onSelect,
  label = 'Add from room members',
  emptyMembersText = 'No room members yet — use the advanced field below once someone has joined.',
  allExcludedText = 'Every current room member is already an admin.',
}: MemberAdminPickerProps) {
  const [query, setQuery] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);

  const pickable = useMemo(
    () => members.filter(m => !excludeIds.has(m.userId)),
    [members, excludeIds],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pickable;
    const found = pickable.filter(m => (m.displayName || m.userId).toLowerCase().includes(q));
    // Search-relevance work package (2026-08-13): nearest-exact-match first.
    found.sort(compareByRank(query.trim(), m => m.displayName || m.userId));
    return found;
  }, [pickable, query]);

  const handlePick = async (member: PickableMember) => {
    if (onSelect) {
      onSelect(member);
      return;
    }
    if (addingId) return;
    setAddingId(member.userId);
    try {
      await api.post(`/rooms/${roomId}/admins/discord`, { discord_user_id: member.userId });
      setQuery('');
      onAdded?.(member);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Failed to add admin');
    } finally {
      setAddingId(null);
    }
  };

  if (members.length === 0) {
    return (
      <p className="text-faint text-sm" data-testid="member-admin-picker-empty">
        {emptyMembersText}
      </p>
    );
  }

  if (pickable.length === 0) {
    return (
      <p className="text-faint text-sm" data-testid="member-admin-picker-empty">
        {allExcludedText}
      </p>
    );
  }

  return (
    <div data-testid="member-admin-picker">
      <label className="text-xs text-faint block mb-1">{label}</label>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        <input
          type="text"
          placeholder="Search members…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search room members"
          className="w-full pl-8 pr-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
        />
      </div>
      <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/40">
        {filtered.length === 0 ? (
          <p className="text-faint text-xs px-3 py-2">No members match "{query}".</p>
        ) : (
          filtered.map(m => (
            <button
              key={m.userId}
              type="button"
              onClick={() => handlePick(m)}
              disabled={addingId !== null}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-border/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <PlayerAvatar
                username={m.displayName || m.userId}
                discordUserId={m.userId}
                avatarHash={m.avatarHash}
                avatarUrl={m.avatarUrl}
                size={24}
              />
              <span className="text-sm text-primary truncate flex-1">{m.displayName || m.userId}</span>
              {addingId === m.userId && <span className="text-xs text-faint flex-shrink-0">Adding…</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
