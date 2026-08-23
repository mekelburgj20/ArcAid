import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, SlidersHorizontal } from 'lucide-react';
import { api, getToken, getTokenDiscordId } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { useTheme } from '../components/ThemeProvider';
import { normalizeThemeId, type ThemeId } from '../lib/themeIds';
import ThemePicker from '../components/ThemePicker';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { InfoTip } from '../components/Tooltip';
import MemberAdminPicker from '../components/MemberAdminPicker';
import ChatResponsesSettings from '../components/ChatResponsesSettings';
import { PlayerAvatar } from '../components/ScoreboardComponents';
// v2.116.0 (C1) — the Leaderboard Display controls moved to the admin
// Leaderboard page's display rail, where they edit against the REAL
// scoreboard. This page still has to CLAIM their keys (see `managedKeys`), so
// the toggle map and the title-style option lists are imported from their new
// home rather than re-declared here.
import {
  SCOREBOARD_TOGGLES,
  TITLE_STYLE_OPTIONS,
  TITLE_SIZE_OPTIONS,
} from '../lib/displaySettings';

/**
 * Validate-credentials button for the iScored Configuration card. Hits the
 * `/iscored/validate` endpoint which performs a quick Playwright login to
 * the room's iScored account (10–20s with retry). Useful for debugging
 * "activation works but deactivation fails" scenarios where env-fallback
 * creds work but per-room creds are misconfigured.
 */
function IScoredCredentialsCheck() {
  const room = useRoom();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; username?: string; error?: string } | null>(null);

  const run = async () => {
    setChecking(true);
    setResult(null);
    try {
      const res = await api.post<{ ok: boolean; username?: string; error?: string }>(
        `/rooms/${room.roomId}/iscored/validate`, {},
      );
      setResult(res);
    } catch (err: any) {
      setResult({ ok: false, error: err?.message || 'Validation request failed' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <NeonButton variant="secondary" onClick={run} disabled={checking}>
        {checking ? 'Validating…' : 'Validate Credentials'}
      </NeonButton>
      {result && (
        result.ok ? (
          <span className="text-xs text-neon-green">
            ✓ Logged in as <span className="font-mono">{result.username}</span>
          </span>
        ) : (
          <span className="text-xs text-neon-magenta">
            ✗ {result.error}{result.username ? ` (tried: ${result.username})` : ''}
          </span>
        )
      )}
    </div>
  );
}

/** `GET /:roomId/admin/guild-members/search` result row (admin guild-wide
 *  typeahead, feature/admin-users-card Task B) — same shape as the Picks
 *  nominee typeahead's `NomineeSuggestion` (both wrap `searchGuildMembers`). */
interface GuildMemberSuggestion {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarHash: string | null;
}

/**
 * Guild-wide "Add Discord Admin" typeahead (feature/admin-users-card Task B).
 *
 * Mirrors the Picks page's nominee typeahead pattern exactly (300ms debounce,
 * 2-char minimum, AbortController stale-response guard, query-keyed results)
 * but searches the room's ENTIRE linked Discord guild via the admin-gated
 * `GET /:roomId/admin/guild-members/search` route, rather than just the
 * room roster `<MemberAdminPicker>` reads — so an admin can promote a guild
 * member who hasn't joined the room in ArcAid yet. Only rendered when the
 * room has a linked guild (`DISCORD_GUILD_ID` set); rooms without one keep
 * the existing roster-based `<MemberAdminPicker>` unchanged.
 */
function GuildAdminTypeahead({
  roomId, excludeIds, viewerDiscordId, onAdded, onError,
}: {
  roomId: string;
  /** Discord ids already admins of this room — filtered out of results. */
  excludeIds: Set<string>;
  /** The viewing admin's own Discord id (decoded from the admin JWT), or
   *  null when not applicable (local-admin login) — excluded from results. */
  viewerDiscordId: string | null;
  onAdded: (member: GuildMemberSuggestion) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [fetched, setFetched] = useState<{ query: string; list: GuildMemberSuggestion[] } | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const trimmedQuery = debouncedQuery.trim().replace(/^@/, '');
  const searchActive = trimmedQuery.length >= 2;
  // Results are stored WITH the query that produced them and rendered only
  // while that query is still current — same idiom as Picks.tsx's nominee
  // typeahead, so a stale response can't briefly render under a new query.
  const results = searchActive && fetched?.query === trimmedQuery ? fetched.list : null;

  useEffect(() => {
    if (!searchActive) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch(`/api/rooms/${roomId}/admin/guild-members/search?q=${encodeURIComponent(trimmedQuery)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    })
      .then(r => (r.ok ? r.json() : { members: [] }))
      .then((data: { members?: GuildMemberSuggestion[] }) => {
        if (controller.signal.aborted) return;
        setFetched({ query: trimmedQuery, list: data.members ?? [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFetched(null);
      });
    return () => controller.abort();
  }, [searchActive, trimmedQuery, roomId]);

  const visible = (results ?? []).filter(
    m => m.discordUserId !== viewerDiscordId && !excludeIds.has(m.discordUserId),
  );

  const handlePick = async (member: GuildMemberSuggestion) => {
    if (addingId) return;
    setAddingId(member.discordUserId);
    try {
      await api.post(`/rooms/${roomId}/admins/discord`, { discord_user_id: member.discordUserId });
      setQuery('');
      setDebouncedQuery('');
      setFetched(null);
      onAdded(member);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add admin');
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div>
      <label className="text-xs text-faint block mb-1">Add from Discord server</label>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        <input
          type="text"
          placeholder="Search Discord server members…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search Discord server members"
          className="w-full pl-8 pr-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
        />
      </div>
      {results !== null && (
        visible.length > 0 ? (
          <div data-testid="guild-admin-typeahead" className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/40">
            {visible.map(m => (
              <button
                key={m.discordUserId}
                type="button"
                onClick={() => handlePick(m)}
                disabled={addingId !== null}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-border/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <PlayerAvatar
                  username={m.displayName}
                  discordUserId={m.discordUserId}
                  avatarHash={m.avatarHash}
                  size={24}
                />
                <span className="text-sm text-primary truncate flex-1">{m.displayName}</span>
                {addingId === m.discordUserId && <span className="text-xs text-faint flex-shrink-0">Adding…</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-faint text-xs px-1" data-testid="guild-admin-typeahead-empty">
            No matching Discord server members.
          </p>
        )
      )}
    </div>
  );
}

interface LocalAdmin {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
}

interface DiscordAdmin {
  discord_user_id: string;
  role: string;
  /** v2.49.0 — resolved via user_profiles (or a best-effort Discord REST
   *  fallback server-side for never-logged-in admins). Null when neither
   *  source has a name. */
  display_name: string | null;
  username: string | null;
}

/** v2.39.0 — GET /:roomId/admin/members (member picker). */
interface RoomMember {
  userId: string;
  joinedAt: string;
  source: string;
  displayName: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
}

interface PendingInvite {
  id: string;
  token: string;
  display_name: string;
  discord_user_id: string | null;
  created_by: string | null;
  expires_at: string;
  created_at: string;
}

const SENSITIVE_KEYS = ['ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH'];
const ENC_MASK_PREFIX = 'mask:';
const isMaskedSecret = (v: string | undefined | null): boolean =>
  typeof v === 'string' && v.startsWith(ENC_MASK_PREFIX);

// Settings keys that look editable but are functional no-ops: the live room
// name/slug come from the game_rooms table (RoomContext), not these keys — they
// only seed the FIRST room at bootstrap (see migrateToMultiRoom). Rendered
// read-only and excluded from dirty tracking + the save payload.
const DEAD_KEYS = new Set(['GAME_ROOM_NAME', 'GAME_ROOM_SLUG']);

// Saving a change to any of these asks for explicit confirmation first — each
// flips how players reach or use the room.
// NOT included: ISCORED_ALLOW_DELETE. The confirm() fires on ANY change to a
// listed key, and its copy ("This affects how players access this room") is
// wrong for it in both directions — turning the switch OFF is the strictly
// safer direction and must not be nagged, and turning it back ON restores the
// default behaviour rather than changing player access. The toggle's own
// description carries the consequence.
const DANGEROUS_KEYS = ['ISCORED_ENABLED', 'DISCORD_ENABLED', 'GLOBAL_SCOREBOARD_ENABLED', 'JOIN_POLICY'];

// D2 (standalone rooms, v2.32.0) — same default-on semantics as
// SetupChecklist.tsx's isFlagOn: missing/undefined reads as enabled, matching
// the server-side `isDiscordEnabledForRoom`/`getIScoredCredsForRoom` checks
// (`raw !== 'false'`). Categories gated behind an integration toggle.
const isFlagOn = (settings: Record<string, string>, key: string): boolean => settings[key] !== 'false';
const INTEGRATION_GATE_KEYS: Record<string, string> = {
  Discord: 'DISCORD_ENABLED',
  iScored: 'ISCORED_ENABLED',
};

/**
 * Style-system revamp P1 (prune) — v1 card keys read ONLY by
 * `deriveCardProps`, which runs only when a room has no `SCOREBOARD_STYLE`.
 * Migration 144 gave every room a style, so none of these affects any live
 * room; their editors were removed from the "Show more styles → Customize"
 * disclosure (owner field report, 2026-08-15: "Game Columns, Card Size, Card
 * Layout ... don't seem to make any difference to the cards displayed").
 *
 * They stay listed here for ONE reason: `managedKeys` below must keep
 * claiming them, or a room with a stored value would surface it as a raw
 * text input in the "Other" card — the same leak P0 fixed for ADMIN_THEME
 * and SCOREBOARD_RANKINGS_STYLE. Delete this list only when the legacy
 * `deriveCardProps` path itself is retired and the rows are migrated away.
 */
const LEGACY_CARD_KEYS = [
  'SCOREBOARD_GAME_COLUMNS', 'SCOREBOARD_CARD_SIZE', 'SCOREBOARD_CARD_LAYOUT',
  'SCOREBOARD_WHEEL_SCALE', 'SCOREBOARD_BG_FILL', 'SCOREBOARD_BG_SIZE',
  'SCOREBOARD_SCORE_STYLE', 'SCOREBOARD_GLASS_OPACITY',
  'SCOREBOARD_SCORE_COLUMNS', 'SCOREBOARD_CARD_OPACITY',
];

const CATEGORIES: Record<string, string[]> = {
  // v2.116.0 (C1) — this category no longer renders controls: its card is a
  // pointer to the Leaderboard page's display rail. The key list STAYS,
  // because `managedKeys` is built from CATEGORIES and dropping it would
  // surface every one of these as a raw text input in the "Other" card.
  'Leaderboard Display': ['SCOREBOARD_LAYOUT', 'SCOREBOARD_GAME_TITLE_STYLE', 'SCOREBOARD_MAX_SCORES', 'SCOREBOARD_RANKINGS_POSITION', 'SCOREBOARD_ZOOM', 'SCOREBOARD_QR_MODE'],
  'Kiosk': ['KIOSK_REFRESH_SECONDS', 'KIOSK_ZOOM'],
  'Game Room': ['GAME_ROOM_NAME', 'GAME_ROOM_SLUG'],
  'Discord': ['DISCORD_GUILD_ID', 'DISCORD_ADMIN_ROLE_ID', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', 'DISCORD_INVITE_URL'],
  'iScored': ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'],
};

// Style-system revamp P0 (item 10): REQUIRE_SCORE_PHOTO is submission policy,
// not appearance — moved out of SCOREBOARD_TOGGLES into its own card that
// renders inside the 'Game Room' category. Label/description/behavior
// unchanged.
const GAME_ROOM_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'REQUIRE_SCORE_PHOTO': {
    label: 'Require Photo with Score Submission',
    description: 'When enabled, players must include a photo when submitting scores from the leaderboard.',
  },
};

// Toggles that render inside the Kiosk card
const KIOSK_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'KIOSK_ENABLED': {
    label: 'Kiosk Mode',
    description: 'When enabled, the kiosk display page is available at /{slug}/kiosk. When disabled, the kiosk page returns a 404.',
    defaultOn: true,
  },
  'KIOSK_AUTO_SCROLL': {
    label: 'Kiosk Auto-Scroll',
    description: 'When the card row is wider than the screen (e.g. with Kiosk Zoom set for TV distance), slowly scroll it back and forth so every card gets screen time.',
    defaultOn: true,
  },
};

// Toggles that render inside the iScored credential card. ISCORED_ALLOW_DELETE
// is the per-room kill-switch for iScored game DELETES: absent or 'true' keeps
// today's behaviour, 'false' means no Arcaid code path may remove a game from
// this room's iScored board (cleanup archives locally instead; admin deletes
// are refused). Locking, hiding, creating and lineup order are unaffected.
// Deliberately NOT in DANGEROUS_KEYS — see the note there.
const ISCORED_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'ISCORED_ALLOW_DELETE': {
    label: 'Allow Arcaid to delete games on iScored',
    description: "On (default): finished games are removed from iScored according to each tournament's Cleanup rule, and admins can delete games there. Off: Arcaid never deletes a game from this iScored room — cleanup archives locally only, admin deletes are refused. Locking and lineup order are unaffected. Turn this off when the iScored room is shared or not owned by Arcaid.",
    defaultOn: true,
  },
};

// Remaining feature toggles (Discord/iScored/submissions)
const TOGGLE_SETTINGS: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'ISCORED_ENABLED': {
    label: 'iScored Integration',
    description: 'Bridge to an external iScored board (legacy). Scores sync in by name only — they can\'t be verified, and anyone with access to your iScored board can post under any name. Synced scores appear in this room only, never on the Global Scoreboard. Toggle off to fully disconnect this room from iScored without touching credentials.',
    defaultOn: true,
  },
  'DISCORD_ENABLED': {
    label: 'Discord Integration',
    description: 'When enabled, this room sends tournament announcements and DMs to Discord. Toggle off to silence all Discord activity for this room without clearing the guild/channel config.',
    defaultOn: true,
  },
  'DISCORD_MENTIONS_ENABLED': {
    label: 'Discord @Mentions',
    description: 'When enabled, the bot @mentions users in announcements (winner picks, reminders, etc.). Disable to use display names instead.',
    defaultOn: true,
  },
  'GLOBAL_SCOREBOARD_ENABLED': {
    label: 'Post Scores to Global Scoreboard',
    description: 'When enabled, scores submitted in this room are also fanned out to the Global Scoreboard at arcaid.app/scoreboard. Players can still opt out per-score.',
    defaultOn: true,
  },
  // v2.80.0 — room-listing toggle (membership & privacy model, Phase 2).
  // Default-on: unlisted rooms are still fully reachable by direct link (see
  // JOIN_POLICY below for the separate "who can view" axis) — this only
  // governs whether the room surfaces on the landing page / room lists.
  'ROOM_LISTED': {
    label: 'Listed on Arcaid',
    description: 'Show this room on the Arcaid landing page and room lists. Turn off to make it unlisted — reachable only by direct link.',
    defaultOn: true,
  },
  // v2.56.0 — 'ENABLE_GAME_PICK_AWARD' was removed. It ANDed with each
  // tournament's "Winner picks next game" setting but was absent (→ off) for
  // most rooms and never referenced by TournamentForm, so the tournament form
  // showed live-looking pick controls that this switch silently disabled.
  // Winner-picks is now per-tournament only; do not reintroduce it here.
};

// v2.125.0 — "Arcaid Chat Responses" (v2.123.0's "Arcaid Callout Responses").
//
// The old global `ENABLE_CALLOUTS` toggle lived in TOGGLE_SETTINGS above and
// was a lie on this page: it wrote a PER-ROOM setting that nothing read, while
// the bot gated on the GLOBAL `process.env.ENABLE_CALLOUTS` and replied in
// every guild it could see. The four keys below are the real per-room gate; the
// LIST they draw from is global and managed by the super admin under
// Admin → Settings → Arcaid Chat Responses.
//
// Rendered by `ChatResponsesSettings` inside the Discord card rather than
// through TOGGLE_SETTINGS/TOGGLE_DEFAULTS' default-resolved diffing, because
// absent must read as OFF and stay that way until someone opts in.
//
// The two v2.123.0 keys are still claimed by `managedKeys` below: the boot
// migration deletes them, but a room whose rows were read before that ran must
// not surface them as raw text inputs in the "Other" card.
const CHAT_RESPONSES_KEYS = [
  'CHAT_RESPONSES_ENABLED',
  'CHAT_RESPONSES_CATEGORIES',
  'CHAT_RESPONSES_CHANNEL_IDS',
  'CHAT_RESPONSES_COOLDOWN_SEC',
];
const LEGACY_CALLOUTS_KEYS = ['CALLOUTS_ENABLED', 'CALLOUTS_CHANNEL_ID'];

// v2.39.0 — approval rooms. Rendered as its own 2-option select (kept out of
// TOGGLE_SETTINGS/boolean diffing since it reads more naturally as a named
// policy than an on/off).
const JOIN_POLICY_KEY = 'JOIN_POLICY';
const JOIN_POLICY_META = {
  label: 'Room visibility',
  description: 'Open: anyone can view scores/leaderboards and join instantly. Approval required: the room is invisible (no scores, leaderboards, or other content) to non-members until a room admin approves their request to join.',
};
const JOIN_POLICY_OPTIONS: { value: string; label: string }[] = [
  { value: 'open', label: 'Open — anyone can view and join' },
  { value: 'approval', label: 'Approval required — invisible to non-members until approved' },
];

// v2.80.0 — auto-approve join requests from members of the room's linked
// Discord guild. Rendered beside JOIN_POLICY (only meaningful when policy is
// 'approval'); a plain boolean toggle otherwise, default off.
// 2026-08-17 — the site-wide "link your Discord" banner shown to players in
// this room who can't receive its Discord features. Framed POSITIVELY (default
// on, 'false' disables) to match ROOM_LISTED and avoid double-negative logic in
// the reader; the label reads as the suppression switch the owner asked for.
const DISCORD_REMINDERS_KEY = 'DISCORD_LINK_REMINDERS';
const DISCORD_REMINDERS_META = {
  label: 'Discord link reminders',
  description: "Show players who can't receive this room's Discord features a banner asking them to link Discord or join the server. Turn off if you use Discord for announcements but don't need players reachable there.",
};

const AUTO_APPROVE_GUILD_KEY = 'AUTO_APPROVE_GUILD_MEMBERS';
const AUTO_APPROVE_GUILD_META = {
  label: 'Auto-approve Discord server members',
  description: "When someone from this room's linked Discord server requests to join, approve them instantly. Requires the Discord Guild ID setting; anyone the bot can't verify still lands in the manual approval queue.",
};

// Every boolean on/off toggle key → its default-when-absent value, aggregated
// from the toggle maps + the two inline toggles. Used by the dirty diff so a
// toggle flipped on then back off reads as clean: an absent value and an
// explicit 'false'/'true' that resolve to the same effective state must not
// count as a change (off-default toggles store nothing until touched, so
// undefined-vs-'false' was wrongly showing as dirty).
const TOGGLE_DEFAULTS: Record<string, boolean> = {
  ...Object.fromEntries(Object.entries(SCOREBOARD_TOGGLES).map(([k, v]) => [k, !!v.defaultOn])),
  ...Object.fromEntries(Object.entries(KIOSK_TOGGLES).map(([k, v]) => [k, !!v.defaultOn])),
  ...Object.fromEntries(Object.entries(GAME_ROOM_TOGGLES).map(([k, v]) => [k, !!v.defaultOn])),
  ...Object.fromEntries(Object.entries(ISCORED_TOGGLES).map(([k, v]) => [k, !!v.defaultOn])),
  ...Object.fromEntries(Object.entries(TOGGLE_SETTINGS).map(([k, v]) => [k, !!v.defaultOn])),
  SCOREBOARD_MOBILE_VERTICAL: true,
  SCOREBOARD_LOGO_ENABLED: true,
  [AUTO_APPROVE_GUILD_KEY]: false,
};

// True iff key k differs between two settings snapshots. Boolean toggles compare
// by effective on/off (default-resolved); everything else by string value.
const settingChanged = (k: string, a: Record<string, string>, b: Record<string, string>): boolean => {
  if (k in TOGGLE_DEFAULTS) {
    const eff = (src: Record<string, string>) => (src[k] !== undefined ? src[k] === 'true' : TOGGLE_DEFAULTS[k]);
    return eff(a) !== eff(b);
  }
  return (a[k] ?? '') !== (b[k] ?? '');
};

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  // Game Room
  GAME_ROOM_NAME: { label: 'Game Room Name', description: 'Display name shown on the public landing page and all public pages.' },
  GAME_ROOM_SLUG: { label: 'Game Room Slug', description: 'URL identifier for your room (e.g. "my_room" → /my_room/). Lowercase, no spaces.' },
  // Discord
  DISCORD_GUILD_ID: { label: 'Guild ID', description: 'Your Discord server ID. Right-click server name → Copy Server ID (requires Developer Mode).' },
  DISCORD_ADMIN_ROLE_ID: { label: 'Admin Role ID', description: 'Discord role that grants access to admin bot commands. Right-click role → Copy Role ID.' },
  DISCORD_ANNOUNCEMENT_CHANNEL_ID: { label: 'Default Announcement Channel ID', description: 'Default channel for tournament announcements. Used when a tournament doesn\'t have its own channel configured. Right-click channel → Copy Channel ID.' },
  DISCORD_INVITE_URL: { label: 'Discord Invite URL', description: 'Public invite link for your Discord server. Shown on the landing page game room card.' },
  // iScored
  ISCORED_USERNAME: { label: 'iScored Username', description: 'Login email or username for your room\'s iScored.info account.' },
  ISCORED_PASSWORD: { label: 'iScored Password', description: 'Password for the iScored account. Used for automated game creation and score scraping.' },
  ISCORED_PUBLIC_URL: { label: 'iScored Public URL', description: 'Public leaderboard URL for score scraping (e.g. https://iscored.info/your_account).' },
  // Scoreboard
  SCOREBOARD_MAX_SCORES: { label: 'Scores Per Card', description: 'Maximum number of scores displayed per game card on the public leaderboard. Default: 5.' },
  SCOREBOARD_ZOOM: { label: 'Zoom Level (%)', description: 'Scale the leaderboard for high-res monitors or TV displays. Range: 50-200. Default: 100.' },
  SCOREBOARD_TITLE: { label: 'Leaderboard Title', description: 'Custom title displayed on the public leaderboard. Leave empty to use the room name.' },
  SCOREBOARD_TITLE_STYLE: { label: 'Title Style', description: 'Visual style for the leaderboard title: default, glow, retro, or pixel.' },
  SCOREBOARD_TITLE_SIZE: { label: 'Title Size', description: 'Font size for the leaderboard title. Default: small.' },
  SCOREBOARD_CARD_OPACITY: { label: 'Card Transparency', description: 'Opacity of score cards and ranking cards. 100% = fully opaque (default), 0% = fully transparent.' },
  SCOREBOARD_LAYOUT: { label: 'Layout Mode', description: 'Score card layout: scroll (horizontal scrolling, default) or grid (CSS grid with rows and columns).' },
  SCOREBOARD_CARD_SIZE: { label: 'Card Size', description: 'Card width preset: small (240px), medium (288px, default), or large (360px).' },
  SCOREBOARD_RANKINGS_POSITION: { label: 'Rankings Position', description: 'Where overall rankings are displayed: left (default), right, top, bottom, or hidden.' },
  SCOREBOARD_GAME_COLUMNS: { label: 'Game Columns (Grid)', description: 'Number of game cards per row in grid mode. Auto: fills based on card size. 2-Column: exactly 2 cards per row on desktop, 1 on mobile.' },
  SCOREBOARD_CARD_LAYOUT: { label: 'Card Layout', description: 'Controls the layout of game cards. Banner: full-width artwork header. Compact: small thumbnail with title. Wheel: image centered above card. Sidebar: image left of game title.' },
  // v2.104.x style-system revamp P0 (item 6): relabeled to disambiguate from
  // the modern-path SCOREBOARD_CARD_BG_FILL toggle, which rendered under the
  // identical "Card Background Fill" label.
  SCOREBOARD_BG_FILL: { label: 'Card Background Fill (legacy)', description: 'When enabled, the game background image fills the entire card behind the layout with glass-panel styling for readability.' },
  SCOREBOARD_BG_SIZE: { label: 'Card Background Sizing', description: 'How game background images are sized. Cover: fills area (may crop). Contain: fits entirely (no crop). Tile: repeats the image as a pattern.' },
  SCOREBOARD_WHEEL_SCALE: { label: 'Wheel Icon Size', description: 'Size of wheel icons in Wheel header mode. Default: 150. Only applies when Card Header Style is set to Wheel.' },
  SCOREBOARD_SCORE_STYLE: { label: 'Score Entry Style', description: 'How score entries are styled on cards. Glass: frosted panel behind scores. Shadow/Outlined/Glow: text effects with no panel, letting background images show through.' },
  SCOREBOARD_GLASS_OPACITY: { label: 'Glass Panel Opacity', description: 'Opacity of glass panels overlaying the background in Fill mode. 0 = transparent, 100 = fully opaque. Default: 60.' },
  SCOREBOARD_GAME_TITLE_STYLE: { label: 'Game Title Style', description: 'Visual style for game name text on score cards. Applies when game name is shown (no identifier image).' },
  SCOREBOARD_SCORE_COLUMNS: { label: 'Score Columns', description: 'Number of score columns within each card. 2 columns shows ranks side-by-side (e.g. 1-5 left, 6-10 right). Collapses to 1 on mobile.' },
  SCOREBOARD_QR_MODE: { label: 'QR Codes', description: 'Show QR codes on score cards linking to mobile score submission. Disabled: no QR codes. Kiosk Only: QR on kiosk display. All: QR on both leaderboard and kiosk.' },
  // Scoreboard Branding
  SCOREBOARD_BG_MODE: { label: 'Background Mode', description: 'How the background image is displayed: cover (fill screen), contain (fit), repeat (tile), or center.' },
  SCOREBOARD_BG_OPACITY: { label: 'Background Opacity', description: 'Opacity of the background image. 100% = fully visible (default), 0% = fully hidden. Lower values let the dark theme show through.' },
  LOGO_POSITION: { label: 'Logo Position', description: 'Where the logo appears relative to the leaderboard title: left, right, above, or below.' },
  LOGO_MAX_HEIGHT: { label: 'Logo Max Height (px)', description: 'Maximum height of the logo in pixels. Default: 64.' },
  // Kiosk
  KIOSK_REFRESH_SECONDS: { label: 'Kiosk Auto-Refresh (seconds)', description: 'How often the kiosk view refreshes data. Default: 60. Set to 0 to disable auto-refresh.' },
  KIOSK_ZOOM: { label: 'Kiosk Zoom (%)', description: 'Zoom for TV/kiosk displays. 130-150% recommended for across-the-room viewing. Leave empty to use Scoreboard Zoom.' },
};

const SELECT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  SCOREBOARD_TITLE_STYLE: TITLE_STYLE_OPTIONS,
  SCOREBOARD_TITLE_SIZE: TITLE_SIZE_OPTIONS,
  SCOREBOARD_LAYOUT: [
    { value: 'scroll', label: 'Horizontal Scroll' },
    { value: 'vertical', label: 'Vertical Scroll' },
    { value: 'grid', label: 'Grid' },
  ],
  SCOREBOARD_CARD_SIZE: [
    { value: 'small', label: 'Small (240px)' },
    { value: 'medium', label: 'Medium (288px)' },
    { value: 'large', label: 'Large (360px)' },
  ],
  SCOREBOARD_RANKINGS_POSITION: [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'top', label: 'Top' },
    { value: 'bottom', label: 'Bottom' },
    { value: 'hidden', label: 'Hidden' },
  ],
  SCOREBOARD_GAME_COLUMNS: [
    { value: 'auto', label: 'Auto (fill by card size)' },
    { value: '2', label: '2-Column (desktop)' },
  ],
  SCOREBOARD_CARD_LAYOUT: [
    { value: 'banner', label: 'Banner' },
    { value: 'compact', label: 'Compact' },
    { value: 'wheel', label: 'Wheel Icon' },
    { value: 'sidebar', label: 'Sidebar (image left of title)' },
  ],
  SCOREBOARD_BG_FILL: [
    { value: 'off', label: 'Off (header area only)' },
    { value: 'fill', label: 'Fill (image fills entire card)' },
  ],
  SCOREBOARD_BG_SIZE: [
    { value: 'cover', label: 'Cover (stretch to fill)' },
    { value: 'contain', label: 'Contain (fit, no crop)' },
    { value: 'tile', label: 'Tile (repeat pattern)' },
  ],
  SCOREBOARD_WHEEL_SCALE: [
    { value: '100', label: 'Small (100%)' },
    { value: '125', label: 'Medium (125%)' },
    { value: '150', label: 'Large (150%) — Default' },
    { value: '175', label: 'X-Large (175%)' },
    { value: '200', label: 'XX-Large (200%)' },
  ],
  SCOREBOARD_SCORE_STYLE: [
    { value: 'glass', label: 'Glass Panel (Default)' },
    { value: 'shadow', label: 'Shadow (Drop Shadow)' },
    { value: 'outlined', label: 'Outlined (Stroke)' },
    { value: 'glow', label: 'Glow (Neon)' },
  ],
  SCOREBOARD_GAME_TITLE_STYLE: TITLE_STYLE_OPTIONS,
  SCOREBOARD_SCORE_COLUMNS: [
    { value: '1', label: '1 Column (Default)' },
    { value: '2', label: '2 Columns (Side-by-Side)' },
  ],
  SCOREBOARD_QR_MODE: [
    { value: 'disabled', label: 'Disabled' },
    { value: 'kiosk-only', label: 'Kiosk Only' },
    { value: 'all', label: 'All Leaderboards' },
  ],
  SCOREBOARD_BG_MODE: [
    { value: 'cover', label: 'Cover (Fill Screen)' },
    { value: 'contain', label: 'Contain (Fit)' },
    { value: 'repeat', label: 'Repeat (Tile)' },
    { value: 'center', label: 'Center' },
  ],
  LOGO_POSITION: [
    { value: 'left', label: 'Left of Title' },
    { value: 'right', label: 'Right of Title' },
    { value: 'above', label: 'Above Title' },
    { value: 'below', label: 'Below Title' },
  ],
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export default function Settings() {
  const room = useRoom();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { publicTheme, setPublicTheme } = useTheme();
  const [settings, setSettings] = useState<Record<string, string>>({});
  // Snapshot of the last-loaded/saved settings — the dirty baseline. State (not
  // a ref) so resetting it after save/load triggers a recompute of `isDirty`.
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  // D2 (standalone rooms, v2.32.0) — categories whose credential card is
  // hidden by default when the matching integration is toggled off
  // (DISCORD_ENABLED / ISCORED_ENABLED). Session-only reveal, per category.
  const [revealedIntegrationCards, setRevealedIntegrationCards] = useState<Set<string>>(new Set());
  const [integrationsHighlighted, setIntegrationsHighlighted] = useState(false);

  // Users state
  const [localAdmins, setLocalAdmins] = useState<LocalAdmin[]>([]);
  const [discordAdmins, setDiscordAdmins] = useState<DiscordAdmin[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [showDiscordForm, setShowDiscordForm] = useState(false);
  const [newDiscordUser, setNewDiscordUser] = useState('');
  const [addingDiscord, setAddingDiscord] = useState(false);
  const [deleteAdminTarget, setDeleteAdminTarget] = useState<LocalAdmin | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  // v2.39.0 — member picker (replaces raw-ID pasting as the primary add-admin
  // flow; the manual input below stays as an "advanced" fallback). The picker
  // UI itself lives in <MemberAdminPicker> (member-picker admin add rider) —
  // names + avatars, provider-agnostic (works for `google:*` ids too).
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  // feature/admin-users-card Task B — the viewing admin's own Discord id
  // (decoded from the admin JWT), used to exclude them from the guild-wide
  // typeahead's suggestion list. Null for local-admin logins (no Discord
  // identity on that token).
  const viewerDiscordId = useMemo(() => getTokenDiscordId(), []);

  const fetchAdmins = async () => {
    try {
      const data = await api.get<{ localAdmins: LocalAdmin[]; discordAdmins: DiscordAdmin[] }>(`/rooms/${room.roomId}/admins`);
      setLocalAdmins(data.localAdmins);
      setDiscordAdmins(data.discordAdmins);
    } catch {}
  };

  const fetchInvites = async () => {
    try {
      const data = await api.get<PendingInvite[]>(`/rooms/${room.roomId}/admins/invites`);
      setPendingInvites(data);
    } catch {}
  };

  const fetchRoomMembers = async () => {
    try {
      const data = await api.get<RoomMember[]>(`/rooms/${room.roomId}/admin/members`);
      setRoomMembers(data);
    } catch {}
  };

  const handleDeleteAdmin = async () => {
    if (!deleteAdminTarget) return;
    try {
      await api.delete(`/rooms/${room.roomId}/admins/local/${deleteAdminTarget.id}`);
      toast(`Removed ${deleteAdminTarget.display_name || deleteAdminTarget.username}`, 'success');
      setDeleteAdminTarget(null);
      fetchAdmins();
    } catch {
      toast('Failed to remove admin', 'error');
    }
  };

  const handleCancelInvite = async (id: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/invites/${id}`);
      toast('Invite cancelled', 'success');
      fetchInvites();
    } catch {
      toast('Failed to cancel invite', 'error');
    }
  };

  const handleAddDiscordAdmin = async () => {
    if (!newDiscordUser.trim()) return;
    setAddingDiscord(true);
    try {
      await api.post(`/rooms/${room.roomId}/admins/discord`, { discord_user: newDiscordUser.trim() });
      toast('Discord admin added. They can now log in via Discord OAuth.', 'success');
      setNewDiscordUser('');
      setShowDiscordForm(false);
      fetchAdmins();
    } catch (err: any) {
      toast(err.message || 'Failed to add Discord admin', 'error');
    } finally {
      setAddingDiscord(false);
    }
  };

  const handleRemoveDiscordAdmin = async (discordUserId: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/discord/${discordUserId}`);
      toast('Discord admin removed', 'success');
      fetchAdmins();
    } catch {
      toast('Failed to remove Discord admin', 'error');
    }
  };

  const copyInviteLink = async (token: string) => {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      toast('Failed to copy link', 'error');
    }
  };

  useEffect(() => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/settings`)
      .then(data => {
        setSettings(data);
        setBaseline({ ...data });
        // Sync global theme from settings
        // v2.133.0 — a room saved before the theme cull can still hold a
        // retired id; normalize so the page paints a theme that exists.
        const storedRoomTheme = normalizeThemeId(data.UI_THEME);
        if (storedRoomTheme && storedRoomTheme !== publicTheme) {
          setPublicTheme(storedRoomTheme);
        }
        // v2.132.0 — the legacy room-scoped `ADMIN_THEME` setting is no
        // longer read here. It used to seed the provider's "admin theme",
        // which IS the viewer's personal `/me/preferences.ui_theme`: a room
        // setting silently rewriting a person's own account preference. The
        // stored key is left alone (see DANGEROUS/hidden keys below).
        setLoading(false);
      })
      .catch(() => { toast('Failed to load settings', 'error'); setLoading(false); });
    fetchAdmins();
    fetchInvites();
    fetchRoomMembers();
  }, []);

  // ── Unsaved-changes tracking (S8) ──────────────────────────────────────
  // Baseline is captured AFTER load so the page never reads dirty on mount.
  // Dead keys are read-only (never reach the dirty set); ADMIN_PASSWORD_HASH is
  // write-only and never round-trips, so it is ignored too.
  const dirtyKeys = (() => {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(settings)]);
    const out: string[] = [];
    keys.forEach(k => {
      if (DEAD_KEYS.has(k) || k === 'ADMIN_PASSWORD_HASH') return;
      if (settingChanged(k, settings, baseline)) out.push(k);
    });
    return out;
  })();
  const isDirty = dirtyKeys.length > 0;

  // Warn on browser-level navigation (tab close / refresh / address bar) while dirty.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Guard in-app navigation while dirty. React Router v7 runs here in declarative
  // <BrowserRouter> mode, which has no useBlocker — so intercept clicks on in-app
  // <a> (the layout's <Link>s render to anchors) at capture phase and confirm
  // before leaving. Only active while dirty; ignores modifier/middle clicks,
  // new-tab/download anchors, hash links, and cross-origin links. (Browser
  // back/forward is not guarded — declarative mode exposes no clean hook.)
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const rawHref = anchor.getAttribute('href');
      if (!rawHref || rawHref.startsWith('#')) return;
      let dest: URL;
      try { dest = new URL(anchor.href, window.location.origin); } catch { return; }
      if (dest.origin !== window.location.origin) return;
      if (dest.pathname === window.location.pathname && dest.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      if (window.confirm('You have unsaved changes. Leave this page without saving?')) {
        setBaseline({ ...settings });
        navigate(dest.pathname + dest.search + dest.hash);
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [isDirty, settings, navigate]);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  /**
   * Save a few keys RIGHT NOW, without the Save bar.
   *
   * Most of this page is a form: you edit several fields, then press Save. A
   * SWITCH is not a form field — it reads as the state of the world, and an
   * admin who flips one has already made the change in their head. The owner
   * turned the old chat-responses toggle off, never pressed Save, and the bot
   * kept talking; the control lied about what the system was doing. So the
   * chat-response controls commit on interaction instead.
   *
   * `baseline` is advanced in lockstep with `settings`, which is what keeps
   * these keys out of the Save bar's dirty diff and out of the unsaved-changes
   * navigation guard. On failure BOTH are rolled back to exactly what they
   * were — including "the key was absent", which is a different state from
   * "the key is an empty string" for a setting whose absence means off.
   *
   * The POST is partial on purpose: `GameRoomSettingsService.saveMany` upserts
   * only the keys it is given, so this cannot disturb an unrelated field the
   * admin is midway through editing elsewhere on the page.
   */
  const saveSettingsNow = async (patch: Record<string, string>) => {
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(patch)) previous.set(key, settings[key]);

    const restore = (prev: Record<string, string>) => {
      const next = { ...prev };
      for (const [key, value] of previous) {
        if (value === undefined) delete next[key]; else next[key] = value;
      }
      return next;
    };

    setSettings(prev => ({ ...prev, ...patch }));
    setBaseline(prev => ({ ...prev, ...patch }));
    try {
      await api.post(`/rooms/${room.roomId}/settings`, patch);
      toast('Saved', 'success');
    } catch {
      setSettings(restore);
      setBaseline(restore);
      toast('Could not save that change', 'error');
    }
  };

  // Smart constraints: keys to hide based on current settings
  const handleSave = async () => {
    // Confirm before saving a change to any access-affecting toggle.
    const changedDangerous = DANGEROUS_KEYS.filter(k => settingChanged(k, settings, baseline));
    if (changedDangerous.length > 0) {
      const labelFor = (k: string) =>
        TOGGLE_SETTINGS[k]?.label
        || (k === JOIN_POLICY_KEY ? JOIN_POLICY_META.label : null)
        || k;
      const labels = changedDangerous.map(labelFor).join(', ');
      // v2.39.0 — flip-to-approval gets its own explicit consequences dialog
      // instead of the generic one. v2.41.0: the approval flip no longer
      // touches the Global Scoreboard (that room-level opt-in gate was
      // removed — per-submission excludeFromGlobal governs fan-out uniformly
      // now), so this states only the view-gating consequence.
      const flippingToApproval = changedDangerous.includes(JOIN_POLICY_KEY)
        && (baseline[JOIN_POLICY_KEY] ?? 'open') !== 'approval'
        && settings[JOIN_POLICY_KEY] === 'approval';
      const message = flippingToApproval
        ? 'Switching to "Approval required" will make this room invisible to non-members (no scores, leaderboards, or other content) until a room admin approves their request. Save this change?'
        : `You're changing: ${labels}. This affects how players access this room. Save these changes?`;
      if (!window.confirm(message)) return;
    }
    setSaving(true);
    try {
      // Strip ADMIN_PASSWORD_HASH (server rejects it here) and the dead
      // GAME_ROOM_NAME/SLUG keys (read-only; live values live in game_rooms).
      const toSave: Record<string, string> = {};
      Object.entries(settings).forEach(([k, v]) => {
        if (k === 'ADMIN_PASSWORD_HASH' || DEAD_KEYS.has(k)) return;
        toSave[k] = v;
      });
      await api.post(`/rooms/${room.roomId}/settings`, toSave);
      toast('Settings saved', 'success');
      setBaseline({ ...settings });
    } catch {
      toast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // D2 (standalone rooms, v2.32.0) — reveal a hidden integration credential
  // card for this session only, then scroll to and briefly highlight the
  // Integrations toggles card (the actual on/off switch lives there).
  const integrationsCardRef = useRef<HTMLDivElement>(null);
  const revealIntegrationCard = (category: string) => {
    setRevealedIntegrationCards(prev => new Set(prev).add(category));
    integrationsCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setIntegrationsHighlighted(true);
    setTimeout(() => setIntegrationsHighlighted(false), 1800);
  };
  const isIntegrationCardHidden = (category: string): boolean => {
    const gateKey = INTEGRATION_GATE_KEYS[category];
    if (!gateKey) return false;
    return !isFlagOn(settings, gateKey) && !revealedIntegrationCards.has(category);
  };

  const isSensitive = (key: string) => SENSITIVE_KEYS.some(s => key.includes(s));

  // Group settings by category — always show all keys (default to empty string if not in DB)
  const categorized = Object.entries(CATEGORIES).map(([category, keys]) => ({
    category,
    entries: keys.map(k => [k, settings[k] ?? ''] as [string, string]),
  }));

  // Keys managed elsewhere (branding card, toggles, removed sections) — exclude from "Other"
  const managedKeys = new Set([
    ...Object.values(CATEGORIES).flat(),
    // Dead v1 card keys — no editor any more, but still claimed so a stored
    // value never leaks into "Other" as a raw text input. See LEGACY_CARD_KEYS.
    ...LEGACY_CARD_KEYS,
    ...Object.keys(SCOREBOARD_TOGGLES),
    ...Object.keys(KIOSK_TOGGLES),
    ...Object.keys(GAME_ROOM_TOGGLES),
    // Rendered as an inline toggle inside the iScored credential card — claimed
    // here so it never leaks into the raw "Other" card.
    ...Object.keys(ISCORED_TOGGLES),
    ...Object.keys(TOGGLE_SETTINGS),
    // v2.39.0 — rendered as its own 2-option select, not a boolean toggle.
    JOIN_POLICY_KEY,
    // v2.80.0 — rendered as a conditional toggle beside JOIN_POLICY.
    AUTO_APPROVE_GUILD_KEY,
    // 2026-08-17 — rendered as a toggle beside AUTO_APPROVE_GUILD_MEMBERS.
    DISCORD_REMINDERS_KEY,
    // v2.125.0 — rendered by ChatResponsesSettings inside the Discord card.
    // The v2.123.0 pair is claimed alongside the new keys because the boot
    // migration deletes those rows but a page loaded mid-upgrade would
    // otherwise leak them. ENABLE_CALLOUTS is the RETIRED global switch: no
    // editor any more, but still claimed for the same reason.
    ...CHAT_RESPONSES_KEYS, ...LEGACY_CALLOUTS_KEYS, 'ENABLE_CALLOUTS',
    // Scoreboard branding (managed in inline card)
    'SCOREBOARD_BG_URL', 'SCOREBOARD_BG_MODE', 'SCOREBOARD_BG_OPACITY',
    'LOGO_URL', 'LOGO_POSITION', 'LOGO_MAX_HEIGHT', 'SCOREBOARD_LOGO_ENABLED',
    'SCOREBOARD_TITLE', 'SCOREBOARD_TITLE_STYLE', 'SCOREBOARD_TITLE_SIZE',
    // Theme (managed in Theme card)
    'UI_THEME',
    // Style-system revamp P0 (item 13) — ADMIN_THEME is managed via the Theme
    // card's "Admin Theme" select (saved through /me/preferences, not
    // handleChange), and SCOREBOARD_RANKINGS_STYLE is managed via the
    // Rankings page's Display Style control. Both leaked as raw text inputs
    // in "Other" once a room had them set.
    'ADMIN_THEME', 'SCOREBOARD_RANKINGS_STYLE',
    // Platforms (managed in Platforms card)
    'PLATFORMS',
    // v2.118.0 — the admin Leaderboard page's manual card order. A JSON blob
    // managed entirely by drag-and-drop there; surfacing it here as a raw text
    // input would invite an admin to corrupt it by hand.
    'LEADERBOARD_CARD_ORDER',
    // New style system advanced settings
    'SCOREBOARD_MIN_SCORES', 'SCOREBOARD_CARD_BG_FILL', 'SCOREBOARD_CARD_SPACING',
    'SCOREBOARD_TITLE_FONT_SIZE', 'SCOREBOARD_RANKINGS_STICKY',
    'SCOREBOARD_QR_SIZE', 'SCOREBOARD_QR_POSITION', 'SCOREBOARD_QR_OFFSET_PX',
    'SCOREBOARD_QR_OVERLAP_PX', 'SCOREBOARD_GAME_TITLE_STYLE',
    'SCOREBOARD_MOBILE_VERTICAL', 'SCOREBOARD_MOBILE_SCALE',
    // New style system core keys
    'SCOREBOARD_STYLE', 'SCOREBOARD_THEME', 'SCOREBOARD_MAX_SCORES', 'SCOREBOARD_SHOW_TIMER',
    // v2.106.0 — showcase podium look (holo-steps default; pyramid/chip pinnable)
    'SCOREBOARD_PODIUM_VARIANT',
    // v2.56.0 — the room-level pick-award gate was removed (winner-picks is a
    // per-tournament setting now). Migration 126 deletes the rows, but a room
    // whose settings were cached/read before that must not surface the dead key
    // as a raw text input in the "Other" card.
    'ENABLE_GAME_PICK_AWARD',
    // Style-system revamp P0 (item 3) — the "Global Card Styles" admin card
    // was unreachable dead UI (CATEGORIES has no such key) and has been
    // deleted; these 4 color/CSS keys still exist on the backend for legacy
    // rooms read by deriveCardProps until Phase 1 retires that path, so they
    // must stay hidden from "Other" rather than surface as raw text inputs.
    'GLOBAL_CARD_CSS_TITLE', 'GLOBAL_CARD_CSS_SCORES', 'GLOBAL_CARD_CSS_BOX', 'GLOBAL_CARD_BG_COLOR',
  ]);
  const uncategorizedKeys = Object.keys(settings).filter(k => !managedKeys.has(k));

  // Users card and Integrations card are moved inside the categorized.map below
  // (rendered after Discord and Game Room respectively) to match desired section order.
  const usersCard = (
    <NeonCard title="Users" className="mb-4">
      <p className="text-muted text-sm mb-1">
        Manage admin accounts for this game room.
      </p>
      {/* v2.49.1 — pointer only; ban management lives on the dedicated Members
          page now (docs/contracts/members-admin-move-contract.md), not here. */}
      <p className="text-muted text-sm mb-4">
        Managing players (including bans)? See{' '}
        <Link to={`/${room.roomSlug}/admin/members`} className="text-neon-cyan hover:underline">Members</Link>.
      </p>

      {/* Discord Admins */}
      <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Discord Admins</p>
      <p className="text-xs text-faint mb-3">Log in via Discord OAuth — no password needed.</p>
      {discordAdmins.length > 0 ? (
        <div className="space-y-2 mb-3">
          {discordAdmins.map(admin => {
            const resolvedName = admin.display_name || admin.username;
            return (
            <div key={admin.discord_user_id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <svg width="16" height="12" viewBox="0 0 71 55" fill="none" className="text-[#5865F2] flex-shrink-0">
                  <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309-0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1099 30.1693C30.1099 34.1136 27.2802 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.7018 30.1693C53.7018 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="currentColor"/>
                </svg>
                {resolvedName ? (
                  <div className="min-w-0">
                    <p className="text-sm text-primary truncate">{resolvedName}</p>
                    <p className="text-xs text-faint font-mono truncate">{admin.discord_user_id}</p>
                  </div>
                ) : (
                  <span className="font-mono text-sm text-primary truncate">{admin.discord_user_id}</span>
                )}
              </div>
              <NeonButton
                variant="ghost"
                className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                onClick={() => handleRemoveDiscordAdmin(admin.discord_user_id)}
              >
                Remove
              </NeonButton>
            </div>
            );
          })}
        </div>
      ) : (
        <p className="text-faint text-sm mb-3">No Discord admins.</p>
      )}

      {showDiscordForm ? (
        <div className="border border-border rounded p-4 space-y-4 mb-6">
          {/* feature/admin-users-card Task B — when the room has a linked
              Discord guild, search the whole guild (not just the room roster)
              via the admin-gated typeahead so a not-yet-a-member can be
              promoted directly. Rooms without a linked guild fall back to the
              v2.39.0 room-roster picker unchanged. */}
          {settings.DISCORD_GUILD_ID?.trim() ? (
            <GuildAdminTypeahead
              roomId={room.roomId}
              excludeIds={new Set(discordAdmins.map(a => a.discord_user_id))}
              viewerDiscordId={viewerDiscordId}
              onAdded={(member) => {
                toast(`${member.displayName || 'Admin'} added.`, 'success');
                fetchAdmins();
              }}
              onError={(message) => toast(message, 'error')}
            />
          ) : (
            /* v2.39.0 — member picker (primary flow): room members are already
               known to us, so pick from the list rather than typing a
               username/ID. Excludes users already listed as Discord admins.
               Names + avatars, provider-agnostic (member-picker admin add rider). */
            <MemberAdminPicker
              roomId={room.roomId}
              members={roomMembers}
              excludeIds={new Set(discordAdmins.map(a => a.discord_user_id))}
              onAdded={(member) => {
                toast(`${member.displayName || 'Admin'} added.`, 'success');
                fetchAdmins();
              }}
              onError={(message) => toast(message, 'error')}
            />
          )}

          <div>
            <label className="text-xs text-faint block mb-1">Advanced: paste a username or ID</label>
            <input
              type="text"
              placeholder="e.g. ChuckRibbits"
              value={newDiscordUser}
              onChange={e => setNewDiscordUser(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddDiscordAdmin()}
              className={inputClass}
            />
            <p className="text-xs text-faint mt-1">Username or numeric ID — use this for someone not yet a room member. They'll be able to log in via Discord immediately. Also accepts a <code>google:*</code> id to promote a Google-authed member.</p>
            <div className="flex gap-2 mt-2">
              <NeonButton onClick={handleAddDiscordAdmin} disabled={addingDiscord || !newDiscordUser.trim()}>
                {addingDiscord ? 'Adding...' : 'Add Discord Admin'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => setShowDiscordForm(false)} disabled={addingDiscord}>
                Cancel
              </NeonButton>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6">
          <NeonButton onClick={() => setShowDiscordForm(true)}>Add Discord Admin</NeonButton>
        </div>
      )}

      {/* Local Admins (username/password) — feature/admin-users-card Task A:
          creation is retired (no more "Invite Local User"), so this section
          only renders when legacy accounts already exist, purely so a room
          can still clean them up via the Remove affordance below. */}
      {localAdmins.length > 0 && (
        <>
          <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Local Admins</p>
          <p className="text-xs text-faint mb-3">Username/password accounts for users without Discord.</p>
          <div className="space-y-2 mb-3">
            {localAdmins.map(admin => (
              <div key={admin.id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
                <div>
                  <span className="text-sm font-medium text-primary">{admin.display_name || admin.username}</span>
                  <span className="text-xs text-faint ml-2">@{admin.username}</span>
                </div>
                <NeonButton
                  variant="ghost"
                  className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                  onClick={() => setDeleteAdminTarget(admin)}
                >
                  Remove
                </NeonButton>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pending invites — management-only now that creation is retired
          (Task A). The backend invite endpoints (POST/GET/DELETE
          /:roomId/admins/invites) are untouched here; they're slated for
          retirement in a later pass once no room has any pending rows left. */}
      {pendingInvites.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30">Pending Invites</p>
          <div className="space-y-2">
            {pendingInvites.map(inv => (
              <div key={inv.id} className="flex items-center justify-between bg-raised border border-neon-amber/20 rounded px-4 py-2">
                <div>
                  <span className="text-sm text-primary">{inv.display_name}</span>
                  <span className="text-xs text-faint ml-2">
                    expires {new Date(inv.expires_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex gap-1">
                  <NeonButton
                    variant="ghost"
                    className="text-xs px-2 py-1"
                    onClick={() => copyInviteLink(inv.token)}
                  >
                    {copiedToken === inv.token ? 'Copied!' : 'Copy Link'}
                  </NeonButton>
                  <NeonButton
                    variant="ghost"
                    className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                    onClick={() => handleCancelInvite(inv.id)}
                  >
                    Cancel
                  </NeonButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </NeonCard>
  );

  const integrationsCard = (
    <div ref={integrationsCardRef}>
      <NeonCard
        title="Integrations"
        className={`mb-4 transition-shadow ${integrationsHighlighted ? 'ring-2 ring-neon-cyan' : ''}`}
      >
      <div className="space-y-4">
        {Object.entries(TOGGLE_SETTINGS).map(([key, { label, description, defaultOn }]) => {
          const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-primary">{label}</p>
                <p className="text-xs text-muted">{description}</p>
              </div>
              <button
                onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                  isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                    isOn ? 'translate-x-6' : ''
                  }`}
                />
              </button>
            </div>
          );
        })}
        {/* v2.39.0 — JOIN_POLICY 2-option select (approval rooms). */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">{JOIN_POLICY_META.label}</p>
            <p className="text-xs text-muted">{JOIN_POLICY_META.description}</p>
          </div>
          <select
            value={settings[JOIN_POLICY_KEY] || 'open'}
            onChange={e => handleChange(JOIN_POLICY_KEY, e.target.value)}
            className={`${inputClass} w-auto min-w-[190px]`}
          >
            {JOIN_POLICY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {/* v2.80.0 — AUTO_APPROVE_GUILD_MEMBERS: only meaningful when
            JOIN_POLICY is 'approval'. Enabled/disabled off the current
            (unsaved) select value so flipping JOIN_POLICY live-updates it. */}
        {(() => {
          const approvalSelected = (settings[JOIN_POLICY_KEY] || 'open') === 'approval';
          const autoApproveOn = settings[AUTO_APPROVE_GUILD_KEY] === 'true';
          return (
            <div className={`flex items-center justify-between gap-4 ${approvalSelected ? '' : 'opacity-50'}`}>
              <div>
                <p className="text-sm font-medium text-primary">{AUTO_APPROVE_GUILD_META.label}</p>
                <p className="text-xs text-muted">
                  {AUTO_APPROVE_GUILD_META.description}
                  {!approvalSelected && ' (Only applies when Room visibility is set to "Approval required".)'}
                </p>
              </div>
              <button
                onClick={() => handleChange(AUTO_APPROVE_GUILD_KEY, autoApproveOn ? 'false' : 'true')}
                disabled={!approvalSelected}
                className={`relative w-12 h-6 rounded-full transition-colors border-none ${
                  approvalSelected ? 'cursor-pointer' : 'cursor-not-allowed'
                } ${autoApproveOn && approvalSelected ? 'bg-neon-cyan' : 'bg-raised border border-border'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                    autoApproveOn && approvalSelected ? 'translate-x-6' : ''
                  }`}
                />
              </button>
            </div>
          );
        })()}
        {/* 2026-08-17 — Discord link reminders. Unlike auto-approve this is
            unconditional: a room can have Discord configured for announcements
            without wanting players nagged to link. Default ON, so an unset
            room behaves as it did before the setting existed. */}
        {(() => {
          const remindersOn = settings[DISCORD_REMINDERS_KEY] !== 'false';
          return (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-primary">{DISCORD_REMINDERS_META.label}</p>
                <p className="text-xs text-muted">{DISCORD_REMINDERS_META.description}</p>
              </div>
              <button
                onClick={() => handleChange(DISCORD_REMINDERS_KEY, remindersOn ? 'false' : 'true')}
                className={`relative w-12 h-6 rounded-full transition-colors border-none cursor-pointer ${
                  remindersOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                    remindersOn ? 'translate-x-6' : ''
                  }`}
                />
              </button>
            </div>
          );
        })()}
      </div>
      </NeonCard>
    </div>
  );

  if (loading) return <LoadingState message="Loading settings..." />;

  return (
    <div>
      <div className="sticky top-0 z-20 bg-deep/95 backdrop-blur-sm -mx-4 px-4 py-3 mb-4 border-b border-border/20">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold">Settings</h1>
          <div className="flex items-center gap-3">
            {isDirty && (
              <span className="text-xs text-neon-amber whitespace-nowrap">
                {dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? '' : 's'}
              </span>
            )}
            <NeonButton onClick={handleSave} disabled={saving || !isDirty}>
              {saving ? 'Saving...' : 'Save All Changes'}
            </NeonButton>
          </div>
        </div>
      </div>

      {/* v2.132.0 — ONE room theme field.
          The old pair was "Public Theme" + "Admin Theme", and the second was
          never a room setting at all: it wrote the signed-in admin's OWN
          `/me/preferences.ui_theme`, sitting in a page whose every other
          control edits the room. That personal picker now lives where the
          rest of a person's display choices live — the user menu's Display
          settings (and Account settings) — and it applies to this admin's
          view of the room's public pages too, so there is nothing left for a
          room-scoped "admin theme" to mean. */}
      <NeonCard title="Theme" className="mb-4">
        <div>
          <label className="text-xs text-faint block mb-1" htmlFor="room-default-theme">Room default theme</label>
          <ThemePicker
            id="room-default-theme"
            value={normalizeThemeId(settings.UI_THEME) || publicTheme}
            onChange={t => {
              const newTheme = (t ?? 'dark') as ThemeId;
              handleChange('UI_THEME', newTheme);
              setPublicTheme(newTheme);
            }}
            className={inputClass}
          />
          <p className="text-xs text-muted mt-1">
            What visitors see unless they pick their own theme in Display settings. Applied to the
            public leaderboard, kiosk, and all public-facing pages.
          </p>
        </div>
      </NeonCard>

      {categorized.map(({ category, entries }) => entries.length > 0 && (
        <Fragment key={category}>
        {category === 'Leaderboard Display' ? (
          /* v2.116.0 (C1) — the appearance controls moved to the Leaderboard
             page, where they edit against this room's REAL cards and scores
             instead of the mock-data preview that used to sit beside them.
             Only the pointer stays here; the keys stay claimed above. */
          <NeonCard title={category} className="mb-4">
            <p className="text-muted text-sm mb-3">
              Scoreboard appearance now lives on the Leaderboard page. Card style, theme,
              fine tuning and branding are edited in a panel beside the real scoreboard,
              so every change previews on your actual cards before you save it.
            </p>
            <Link
              to={`/${room.roomSlug}/admin/leaderboard`}
              className="inline-flex items-center gap-1.5 text-sm text-neon-cyan hover:underline no-underline"
            >
              <SlidersHorizontal size={14} />
              Configure display settings
            </Link>
          </NeonCard>
        ) : isIntegrationCardHidden(category) ? (
          /* D2 (standalone rooms, v2.32.0) — quiet affordance in place of a
             credential card whose integration toggle is off. Not airtight:
             a reveal, not a wall. The Integrations toggles card (below) is
             the real on/off switch and always renders. */
          <div className="mb-4 px-1">
            <button
              onClick={() => revealIntegrationCard(category)}
              className="text-xs text-faint hover:text-muted underline decoration-dotted cursor-pointer bg-transparent border-none p-0"
            >
              Integrations disabled for this room — Enable integrations…
            </button>
          </div>
        ) : (
          /* ── All other categories ── */
          <NeonCard title={category} className="mb-4">
            {category === 'Discord' && (
              <div className="mb-3 px-3 py-2 rounded border border-neon-cyan/20 bg-neon-cyan/5 text-xs text-muted">
                Per-room Discord config. To silence Discord activity for this room, toggle <strong>Discord Integration</strong> off in Integrations. Changing the guild here is safe; you'll need to invite the bot to the new guild manually. Avoid swapping guilds mid-tournament — per-tournament channel IDs still reference the old guild.
              </div>
            )}
            {category === 'iScored' && (
              <>
                <div className="mb-3 px-3 py-2 rounded border border-neon-cyan/20 bg-neon-cyan/5 text-xs text-muted">
                  Legacy external bridge — not required to run a room. Per-room iScored account. All three fields must be set together to override the server default — partial config is treated as disabled. The password is encrypted at rest. Synced scores are name-only (unverifiable) and stay local to this room; they never reach the Global Scoreboard. To disconnect this room from iScored entirely, toggle <strong>iScored Integration</strong> off in Integrations. Avoid swapping accounts mid-tournament — existing games still reference the old iScored IDs.
                </div>
                <IScoredCredentialsCheck />
              </>
            )}
            <div className="space-y-3">
              {entries.map(([key, value]) => {
                const meta = SETTING_LABELS[key];
                return (
                  <div key={key}>
                    <div className="flex items-center gap-3">
                      <label className="w-64 shrink-0 text-sm font-mono text-muted flex items-center">
                        {meta?.label || key}
                        {meta?.description && <InfoTip text={meta.description} />}
                      </label>
                      {DEAD_KEYS.has(key) ? (
                        <div className="flex-1">
                          <p className="text-sm text-muted font-mono px-3 py-2 bg-surface border border-border/50 rounded">
                            {(key === 'GAME_ROOM_NAME' ? room.roomName : room.roomSlug) || value || '—'}
                          </p>
                          <p className="text-xs text-faint mt-1">Contact your server admin to rename this room.</p>
                        </div>
                      ) : (key === 'SCOREBOARD_CARD_OPACITY' || key === 'SCOREBOARD_BG_OPACITY' || key === 'SCOREBOARD_GLASS_OPACITY') ? (
                        <div className="flex items-center gap-3 flex-1">
                          <input type="range" min="0" max="100" step="5"
                            value={Math.round((parseFloat(value || '1') * 100))}
                            onChange={e => handleChange(key, String(parseInt(e.target.value, 10) / 100))}
                            className="flex-1 accent-neon-cyan cursor-pointer"
                          />
                          <span className="text-sm text-muted w-12 text-right">{Math.round((parseFloat(value || '1') * 100))}%</span>
                        </div>
                      ) : key === 'KIOSK_ZOOM' ? (
                        <input
                          type="number"
                          min="50"
                          max="300"
                          step="5"
                          placeholder="(uses Scoreboard Zoom)"
                          value={value}
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        />
                      ) : SELECT_OPTIONS[key] ? (
                        <select
                          value={value || SELECT_OPTIONS[key][0].value}
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        >
                          {SELECT_OPTIONS[key].map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : key.startsWith('GLOBAL_CARD_CSS_') || key === 'GLOBAL_CARD_BG_COLOR' ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input type="color" value={value || '#000000'}
                            onChange={e => handleChange(key, e.target.value)}
                            className="w-10 h-9 rounded border border-border cursor-pointer bg-transparent p-0.5"
                          />
                          <input type="text" value={value}
                            onChange={e => handleChange(key, e.target.value)}
                            placeholder="#000000" className={`${inputClass} flex-1`}
                          />
                          {value && (
                            <button onClick={() => handleChange(key, '')}
                              className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none whitespace-nowrap"
                            >Clear</button>
                          )}
                        </div>
                      ) : isMaskedSecret(value) ? (
                        <input
                          type="password"
                          value=""
                          placeholder="●●●●●●●● (stored — leave blank to keep, type to replace)"
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        />
                      ) : (
                        <input
                          type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                          value={value}
                          onChange={e => handleChange(key, e.target.value)}
                          className={`${inputClass} flex-1`}
                        />
                      )}
                      {isSensitive(key) && !isMaskedSecret(value) && (
                        <button onClick={() => toggleReveal(key)}
                          className="text-xs text-faint hover:text-muted cursor-pointer bg-transparent border-none"
                        >{revealed.has(key) ? 'Hide' : 'Show'}</button>
                      )}
                      {isMaskedSecret(value) && (
                        <button
                          onClick={() => handleChange(key, '')}
                          className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none whitespace-nowrap"
                          title="Remove this stored secret"
                        >Remove</button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* v2.123.0 — per-room opt-in, rebuilt in v2.125.0 as "Arcaid
                  Chat Responses": a master switch, four category sub-toggles, a
                  multi-channel picker and a cooldown. Lives in the Discord card
                  (not Integrations) because it is a property of THIS room's
                  Discord server. ABSENT MEANS OFF: replying in someone else's
                  server is a social choice, so this is the rare opt-in toggle.
                  Rendered from its own component — see the comment at the top
                  of ChatResponsesSettings.tsx. */}
              {category === 'Discord' && (
                <ChatResponsesSettings
                  roomId={room.roomId}
                  settings={settings}
                  onSaveNow={saveSettingsNow}
                  hasGuild={!!settings.DISCORD_GUILD_ID?.trim()}
                />
              )}

              {/* Inline toggle for Game Room (style-system revamp P0, item 10 —
                  REQUIRE_SCORE_PHOTO is submission policy, relocated here out
                  of the appearance card; label/description/behavior unchanged) */}
              {category === 'Game Room' && (
                <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                  {Object.entries(GAME_ROOM_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                    const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <button
                          onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Inline toggle for iScored — the per-room delete kill-switch.
                  Lives in this card (not Integrations) because it qualifies
                  the iScored connection itself, not whether the room has one. */}
              {category === 'iScored' && (
                <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                  {Object.entries(ISCORED_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                    const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <button
                          onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Inline toggles for Kiosk */}
              {category === 'Kiosk' && (
                <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
                  {Object.entries(KIOSK_TOGGLES).map(([key, { label, description, defaultOn }]) => {
                    const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-primary">{label}</p>
                          <p className="text-xs text-muted">{description}</p>
                        </div>
                        <button
                          onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                          className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </NeonCard>
        )}

        {/* Integrations — renders right after Game Room */}
        {category === 'Game Room' && integrationsCard}

        {/* Users — renders right after Discord */}
        {category === 'Discord' && usersCard}
        </Fragment>
      ))}

      {uncategorizedKeys.length > 0 && (
        <NeonCard title="Other" className="mb-4">
          <div className="space-y-3">
            {uncategorizedKeys.map(key => {
              const value = settings[key] ?? '';
              if (isMaskedSecret(value)) {
                return (
                  <div key={key} className="flex items-center gap-3">
                    <label className="w-64 shrink-0 text-sm font-mono text-muted">{key}</label>
                    <input
                      type="password"
                      value=""
                      placeholder="●●●●●●●● (stored — leave blank to keep, type to replace)"
                      onChange={e => handleChange(key, e.target.value)}
                      className={`${inputClass} flex-1`}
                    />
                  </div>
                );
              }
              return (
                <div key={key} className="flex items-center gap-3">
                  <label className="w-64 shrink-0 text-sm font-mono text-muted">{key}</label>
                  <input
                    type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                    value={value}
                    onChange={e => handleChange(key, e.target.value)}
                    className={`${inputClass} flex-1`}
                  />
                </div>
              );
            })}
          </div>
        </NeonCard>
      )}

      {deleteAdminTarget && (
        <ConfirmModal
          title="Remove Admin"
          message={`Are you sure you want to remove ${deleteAdminTarget.display_name || deleteAdminTarget.username}? They will no longer be able to log in.`}
          confirmLabel="Remove"
          onConfirm={handleDeleteAdmin}
          onCancel={() => setDeleteAdminTarget(null)}
        />
      )}
    </div>
  );
}
