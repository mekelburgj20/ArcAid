import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from '../Settings';
import { RoomContext } from '../../contexts/RoomContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import { ToastProvider } from '../../components/Toast';
import { setToken } from '../../lib/api';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * Regression net for the room-admin Settings page's newer toggles/selects and
 * their save wiring (LAUNCH.md Tier 1 — this page had zero FE coverage).
 *
 * Scope is deliberately narrow: this is NOT a pixel test of the whole
 * 1900-line page. It locks:
 *   - ROOM_LISTED default-on-when-absent semantics (v2.80.0 membership/privacy)
 *   - JOIN_POLICY select + its "flip to approval" confirm copy
 *   - AUTO_APPROVE_GUILD_MEMBERS conditional enable (only meaningful when
 *     JOIN_POLICY === 'approval')
 *   - ISCORED_ENABLED default-off-for-new-rooms posture + the credential
 *     card's show/hide gating + the masked-secret ('mask:<KEY>') round-trip,
 *     which is a no-op server-side (GameRoomSettingsService.saveMany skips
 *     isMask() values) — the FE has NO guard of its own, so the raw sentinel
 *     is what actually goes out on the wire when a masked field is untouched.
 *     This is documented, existing, safe behavior — not a bug to fix here.
 *   - The isDirty/settingChanged dirty-tracking core (default-resolved
 *     boolean diffing) and the DANGEROUS_KEYS confirm() save gate.
 *
 * Skipped: the beforeunload warning and the in-app <a>-click interception
 * guard (both in Settings.tsx around the isDirty effects). Both are thin
 * event-listener wrappers around the same isDirty value already covered here
 * via the dirty-count indicator + Save button disabled state; exercising the
 * click-capture guard meaningfully needs real anchor navigation semantics
 * jsdom doesn't model well, and would mostly re-test window.confirm plumbing
 * rather than page logic. Noted per the task brief rather than pinned.
 */

const ROOM_ID = 'room-1';
const ROOM_SLUG = 'test-room';

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={[`/${ROOM_SLUG}/admin/settings`]}>
      <ThemeProvider>
        <ToastProvider>
          <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: ROOM_SLUG, roomName: 'Test Room' }}>
            <Settings />
          </RoomContext.Provider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

type FetchArgs = [url: string, init?: RequestInit];

/** Stubs global fetch for the settings GET/POST + the admin-list GETs the
 *  page fires on mount (all swallowed on error by the component, but stubbed
 *  anyway to keep the console clean and avoid unrelated act() noise).
 *  `opts` lets Users-card tests seed local/Discord admins and the guild-wide
 *  typeahead's search results without hand-rolling a whole fetch mock. */
function stubFetch(settingsResponse: Record<string, string>, opts: {
  localAdmins?: Array<{ id: string; username: string; display_name: string; created_at: string }>;
  discordAdmins?: Array<{ discord_user_id: string; role: string; display_name: string | null; username: string | null }>;
  guildMembers?: Array<{ discordUserId: string; displayName: string; username: string; avatarHash: string | null }>;
} = {}) {
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/settings') && method === 'GET') return j(settingsResponse);
    if (url.includes('/settings') && method === 'POST') return j({ success: true });
    if (url.includes('/admins/invites')) return j([]);
    // P2 style profiles — the block renders at the top of the Leaderboard
    // Display card, so an unrouted response here would break every test in
    // this file rather than just its own.
    if (url.includes('/admin/style-profiles')) return j({ profiles: [], current: {} });
    // Order matters: the guild-wide search path contains "/admin/" but not
    // the exact "/admin/members" substring, so it must be checked first.
    if (url.includes('/admin/guild-members/search')) {
      if (method === 'POST') return j({ success: true });
      return j({ members: opts.guildMembers ?? [] });
    }
    if (url.includes('/admin/members')) return j([]);
    if (url.includes('/admins/discord')) return j({ success: true });
    if (url.includes('/admins')) return j({ localAdmins: opts.localAdmins ?? [], discordAdmins: opts.discordAdmins ?? [] });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** The saved payload from the most recent POST .../settings call, or null. */
function lastSavePayload(fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => unknown>>): Record<string, string> | null {
  const call = fetchMock.mock.calls
    .filter((c: FetchArgs) => c[0].includes('/settings') && (c[1]?.method || '').toUpperCase() === 'POST')
    .pop();
  if (!call) return null;
  return JSON.parse((call[1] as RequestInit).body as string);
}

/** Toggle rows and the JOIN_POLICY/AUTO_APPROVE select+button share one DOM
 *  shape: a row div with a label div (two <p>s) and a control (button or
 *  select) as its sibling. Locate the control by its label text. */
function controlFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const row = label.closest('div')!.parentElement as HTMLElement;
  return row;
}

async function waitForLoaded() {
  // Loading gate flips off once the settings GET resolves.
  await waitFor(() => expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());
}

/** Unsigned fake admin JWT — decode-only on the FE (`getTokenDiscordId`),
 *  same idiom as PicksDisposition.test.tsx's `fakeJwt`. */
function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeAdminJwt(discordId: string): string {
  return `${b64url({ alg: 'none' })}.${b64url({ role: 'room_admin', discordId })}.sig`;
}

describe('Settings page — ROOM_LISTED, JOIN_POLICY, AUTO_APPROVE_GUILD_MEMBERS, iScored posture', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
    // jsdom has no scrollIntoView; the integration-card reveal affordance calls
    // it on click (Settings.tsx's revealIntegrationCard).
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  describe('ROOM_LISTED', () => {
    it('defaults to ON (listed) when the key is absent from stored settings', async () => {
      stubFetch({});
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('Listed on Arcaid')).getByRole('button');
      expect(button.className).toMatch(/bg-neon-cyan/);
    });

    it('renders OFF when explicitly stored as \'false\'', async () => {
      stubFetch({ ROOM_LISTED: 'false' });
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('Listed on Arcaid')).getByRole('button');
      expect(button.className).not.toMatch(/bg-neon-cyan/);
    });

    it('toggling off marks the page dirty and saves ROOM_LISTED=false (not dangerous — no confirm)', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const fetchMock = stubFetch({});
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('Listed on Arcaid')).getByRole('button');
      fireEvent.click(button);

      expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();
      const saveBtn = screen.getByRole('button', { name: /Save All Changes/ });
      expect(saveBtn).not.toBeDisabled();

      fireEvent.click(saveBtn);
      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ROOM_LISTED).toBe('false');
      // ROOM_LISTED is not in DANGEROUS_KEYS — saving it never prompts.
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('toggling off then back on reads as clean (default-resolved dirty diff)', async () => {
      stubFetch({});
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('Listed on Arcaid')).getByRole('button');
      fireEvent.click(button); // off
      expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();
      fireEvent.click(button); // back on (== absent-default)

      await waitFor(() => expect(screen.queryByText(/unsaved change/)).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: /Save All Changes/ })).toBeDisabled();
    });
  });

  describe('JOIN_POLICY', () => {
    it('renders the current stored value', async () => {
      stubFetch({ JOIN_POLICY: 'approval' });
      renderSettings();
      await waitForLoaded();

      const select = within(controlFor('Room visibility')).getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('approval');
    });

    it('defaults to "open" when the key is absent', async () => {
      stubFetch({});
      renderSettings();
      await waitForLoaded();

      const select = within(controlFor('Room visibility')).getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('open');
    });

    it('flipping open -> approval shows the dedicated consequences confirm, and saves on accept', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const fetchMock = stubFetch({});
      renderSettings();
      await waitForLoaded();

      const select = within(controlFor('Room visibility')).getByRole('combobox') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'approval' } });

      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      expect(confirmSpy).toHaveBeenCalledWith(
        'Switching to "Approval required" will make this room invisible to non-members (no scores, leaderboards, or other content) until a room admin approves their request. Save this change?',
      );
      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.JOIN_POLICY).toBe('approval');
    });

    it('cancelling the confirm leaves the change unsaved', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const fetchMock = stubFetch({});
      renderSettings();
      await waitForLoaded();

      const select = within(controlFor('Room visibility')).getByRole('combobox') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'approval' } });
      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      // Give any (incorrect) save a tick to fire, then assert it didn't.
      await new Promise(r => setTimeout(r, 0));
      expect(lastSavePayload(fetchMock)).toBeNull();
      expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    });
  });

  describe('AUTO_APPROVE_GUILD_MEMBERS', () => {
    it('is disabled and dimmed while JOIN_POLICY is "open"', async () => {
      stubFetch({ JOIN_POLICY: 'open' });
      renderSettings();
      await waitForLoaded();

      const row = controlFor('Auto-approve Discord server members');
      expect(row.className).toMatch(/opacity-50/);
      expect(within(row).getByRole('button')).toBeDisabled();
    });

    it('is enabled once JOIN_POLICY is "approval", and clicking it saves without a confirm (only JOIN_POLICY is dangerous)', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const fetchMock = stubFetch({ JOIN_POLICY: 'approval' });
      renderSettings();
      await waitForLoaded();

      const row = controlFor('Auto-approve Discord server members');
      expect(row.className).not.toMatch(/opacity-50/);
      const button = within(row).getByRole('button');
      expect(button).not.toBeDisabled();

      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.AUTO_APPROVE_GUILD_MEMBERS).toBe('true');
      // JOIN_POLICY itself didn't change from baseline ('approval' -> 'approval').
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('live-updates enablement off the unsaved JOIN_POLICY select value, not the saved baseline', async () => {
      stubFetch({ JOIN_POLICY: 'open' });
      renderSettings();
      await waitForLoaded();

      const select = within(controlFor('Room visibility')).getByRole('combobox') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'approval' } });

      const row = controlFor('Auto-approve Discord server members');
      expect(within(row).getByRole('button')).not.toBeDisabled();
    });
  });

  describe('iScored posture (ISCORED_ENABLED default-off for new rooms + credential masking)', () => {
    it('shows the credential card when ISCORED_ENABLED is absent (legacy-room default-on-when-absent)', async () => {
      stubFetch({});
      renderSettings();
      await waitForLoaded();

      expect(screen.getByText('iScored Username')).toBeInTheDocument();
      expect(screen.queryByText('Integrations disabled for this room — Enable integrations…')).not.toBeInTheDocument();
    });

    it('hides the credential card behind a reveal affordance when ISCORED_ENABLED=false (new-room default since v2.81.0)', async () => {
      stubFetch({ ISCORED_ENABLED: 'false' });
      renderSettings();
      await waitForLoaded();

      expect(screen.queryByText('iScored Username')).not.toBeInTheDocument();
      const revealLink = screen.getByText('Integrations disabled for this room — Enable integrations…');
      expect(revealLink).toBeInTheDocument();

      fireEvent.click(revealLink);
      expect(await screen.findByText('iScored Username')).toBeInTheDocument();
    });

    it('the iScored Integration toggle reflects ISCORED_ENABLED=false and its own switch is off', async () => {
      stubFetch({ ISCORED_ENABLED: 'false' });
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('iScored Integration')).getByRole('button');
      expect(button.className).not.toMatch(/bg-neon-cyan/);
    });

    it('flipping ISCORED_ENABLED on is a DANGEROUS_KEYS change and prompts before saving', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const fetchMock = stubFetch({ ISCORED_ENABLED: 'false' });
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor('iScored Integration')).getByRole('button');
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      expect(confirmSpy).toHaveBeenCalledWith(
        "You're changing: iScored Integration. This affects how players access this room. Save these changes?",
      );
      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ISCORED_ENABLED).toBe('true');
    });

    it('renders a masked ISCORED_PASSWORD as a blank "stored" field with Remove, and no Show/Hide toggle', async () => {
      stubFetch({
        ISCORED_ENABLED: 'true',
        ISCORED_USERNAME: 'bob',
        ISCORED_PASSWORD: 'mask:ISCORED_PASSWORD',
        ISCORED_PUBLIC_URL: 'https://iscored.info/bob',
      });
      renderSettings();
      await waitForLoaded();

      const input = screen.getByPlaceholderText('●●●●●●●● (stored — leave blank to keep, type to replace)') as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.type).toBe('password');
      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();
    });

    it('KNOWN BEHAVIOR (not a bug, guarded server-side): saving without touching a masked field round-trips the literal mask:<KEY> sentinel', async () => {
      // GameRoomSettingsService.saveMany (src/services/GameRoomSettingsService.ts)
      // skips any value where isMask(value) is true, so this sentinel is a
      // no-op write server-side — the encrypted column is left untouched.
      // The FE itself has NO round-trip guard; this test pins that the wire
      // payload really does carry the raw sentinel, so nobody "fixes" the FE
      // in a way that silently starts omitting untouched masked keys (which
      // would change save semantics — omission vs. an explicit no-op value)
      // without also checking the BE contract this relies on.
      const fetchMock = stubFetch({
        ISCORED_ENABLED: 'true',
        ISCORED_USERNAME: 'bob',
        ISCORED_PASSWORD: 'mask:ISCORED_PASSWORD',
        ISCORED_PUBLIC_URL: 'https://iscored.info/bob',
      });
      renderSettings();
      await waitForLoaded();

      // Touch an unrelated field so the page is dirty enough to save.
      const urlInput = screen.getByDisplayValue('https://iscored.info/bob');
      fireEvent.change(urlInput, { target: { value: 'https://iscored.info/bob2' } });

      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));
      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ISCORED_PASSWORD).toBe('mask:ISCORED_PASSWORD');
    });

    it('typing over a masked field replaces it with the new plaintext in the save payload', async () => {
      const fetchMock = stubFetch({
        ISCORED_ENABLED: 'true',
        ISCORED_PASSWORD: 'mask:ISCORED_PASSWORD',
      });
      renderSettings();
      await waitForLoaded();

      const input = screen.getByPlaceholderText('●●●●●●●● (stored — leave blank to keep, type to replace)');
      fireEvent.change(input, { target: { value: 'newSecretPass1' } });

      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));
      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ISCORED_PASSWORD).toBe('newSecretPass1');
    });

    // v2.120.0 — ISCORED_ALLOW_DELETE, the per-room iScored delete kill-switch.
    // It renders inside the iScored CREDENTIAL card (not Integrations, not
    // "Other"), because it qualifies the connection rather than establishing
    // one. Default-on-when-absent, same rule as the server helper
    // (`iscoredDeletesAllowed`: any value but the literal 'false' allows).
    const ALLOW_DELETE_LABEL = 'Allow Arcaid to delete games on iScored';

    it('renders the delete kill-switch INSIDE the iScored card, defaulted on when absent', async () => {
      stubFetch({ ISCORED_ENABLED: 'true' });
      renderSettings();
      await waitForLoaded();

      // The NeonCard renders its title as an <h3> sibling of the body, so the
      // heading's parent IS the card — scoping to it proves placement.
      const iscoredCard = screen.getByRole('heading', { name: 'iScored' }).parentElement as HTMLElement;
      expect(within(iscoredCard).getByText(ALLOW_DELETE_LABEL)).toBeInTheDocument();
      expect(within(iscoredCard).getByText('iScored Username')).toBeInTheDocument();

      // Absent → on.
      const button = within(controlFor(ALLOW_DELETE_LABEL)).getByRole('button');
      expect(button.className).toMatch(/bg-neon-cyan/);
    });

    it('never leaks into the raw "Other" card', async () => {
      stubFetch({ ISCORED_ENABLED: 'true', ISCORED_ALLOW_DELETE: 'false' });
      renderSettings();
      await waitForLoaded();

      expect(screen.queryByRole('heading', { name: 'Other' })).not.toBeInTheDocument();
    });

    it("turning it off saves ISCORED_ALLOW_DELETE='false' with no confirm() prompt", async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const fetchMock = stubFetch({ ISCORED_ENABLED: 'true' });
      renderSettings();
      await waitForLoaded();

      fireEvent.click(within(controlFor(ALLOW_DELETE_LABEL)).getByRole('button'));
      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ISCORED_ALLOW_DELETE).toBe('false');
      // Deliberately NOT a DANGEROUS_KEYS member: turning deletes OFF is the
      // safe direction and the generic confirm copy would misdescribe it.
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it("reads 'false' as off", async () => {
      stubFetch({ ISCORED_ENABLED: 'true', ISCORED_ALLOW_DELETE: 'false' });
      renderSettings();
      await waitForLoaded();

      const button = within(controlFor(ALLOW_DELETE_LABEL)).getByRole('button');
      expect(button.className).not.toMatch(/bg-neon-cyan/);
    });

    it('clicking Remove clears the masked field to empty string (server deletes the row on save)', async () => {
      const fetchMock = stubFetch({
        ISCORED_ENABLED: 'true',
        ISCORED_PASSWORD: 'mask:ISCORED_PASSWORD',
      });
      renderSettings();
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

      await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
      expect(lastSavePayload(fetchMock)!.ISCORED_PASSWORD).toBe('');
    });
  });

  // ---------------------------------------------------------------------
  // Users card — Local Admins visibility (feature/admin-users-card Task A).
  // "Invite Local User" and its creation form are retired outright; the
  // Local Admins section itself now only renders for legacy rooms that
  // already have accounts, purely so they stay cleanable via Remove.
  // ---------------------------------------------------------------------
  describe('Users card — Local Admins visibility (Task A)', () => {
    it('never renders "Invite Local User" or an invite-creation form', async () => {
      stubFetch({}, { localAdmins: [{ id: 'la-1', username: 'bob', display_name: 'Bob', created_at: '2026-01-01' }] });
      renderSettings();
      await waitForLoaded();

      expect(screen.queryByText('Invite Local User')).not.toBeInTheDocument();
      expect(screen.queryByText('Display Name *')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('e.g. John Smith')).not.toBeInTheDocument();
    });

    it('hides the whole Local Admins section (header + empty copy) when no local admin accounts exist', async () => {
      stubFetch({}, { localAdmins: [] });
      renderSettings();
      await waitForLoaded();

      expect(screen.queryByText('Local Admins')).not.toBeInTheDocument();
      expect(screen.queryByText('No local admin accounts.')).not.toBeInTheDocument();
      expect(screen.queryByText('Username/password accounts for users without Discord.')).not.toBeInTheDocument();
    });

    it('shows the Local Admins section with a working Remove affordance when legacy accounts exist', async () => {
      stubFetch({}, { localAdmins: [{ id: 'la-1', username: 'bob', display_name: 'Bob', created_at: '2026-01-01' }] });
      renderSettings();
      await waitForLoaded();

      expect(screen.getByText('Local Admins')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
      expect(screen.getByText('@bob')).toBeInTheDocument();

      const row = screen.getByText('Bob').closest('div')!.parentElement as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));

      // Confirm modal gates the actual delete — just prove the affordance
      // is wired, not the full delete flow (out of scope here).
      expect(await screen.findByText(/Are you sure you want to remove Bob/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // Users card — guild-wide admin typeahead (feature/admin-users-card Task
  // B). When the room has a linked Discord guild, "Add Discord Admin" opens
  // a Picks-nominee-style typeahead over the WHOLE guild instead of just the
  // room roster picker. Real timers throughout (matches PicksDisposition's
  // idiom); `findBy*`'s generous default wait plus an explicit 2000ms
  // override absorbs the 300ms debounce.
  // ---------------------------------------------------------------------
  describe('Users card — guild-wide admin typeahead (Task B)', () => {
    afterEach(() => setToken(null));

    it('rooms without a linked guild keep the room-roster MemberAdminPicker', async () => {
      stubFetch({}); // no DISCORD_GUILD_ID
      renderSettings();
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      expect(await screen.findByTestId('member-admin-picker-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('guild-admin-typeahead')).not.toBeInTheDocument();
    });

    it('a linked guild swaps in the guild-wide typeahead instead of the roster picker', async () => {
      stubFetch({ DISCORD_GUILD_ID: 'guild-1' });
      renderSettings();
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      expect(await screen.findByLabelText('Search Discord server members')).toBeInTheDocument();
      expect(screen.queryByTestId('member-admin-picker')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-admin-picker-empty')).not.toBeInTheDocument();
      // The paste-ID advanced fallback stays available in both modes.
      expect(screen.getByPlaceholderText('e.g. ChuckRibbits')).toBeInTheDocument();
    });

    it('typing 2+ chars renders suggestions after the debounce', async () => {
      stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, {
        guildMembers: [{ discordUserId: '555566667777888899', displayName: 'Charlie', username: 'charlie', avatarHash: null }],
      });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'ch' } });

      const list = await screen.findByTestId('guild-admin-typeahead', {}, { timeout: 2000 });
      expect(await within(list).findByText('Charlie', {}, { timeout: 2000 })).toBeInTheDocument();
    });

    it('a single character does not issue a search request', async () => {
      const fetchMock = stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, { guildMembers: [] });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'c' } });

      // Let the 300ms debounce window elapse to prove no request was queued.
      await new Promise((resolve) => { setTimeout(resolve, 400); });
      expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/admin/guild-members/search'))).toBe(false);
      expect(screen.queryByTestId('guild-admin-typeahead-empty')).not.toBeInTheDocument();
    });

    it('a completed empty search shows the no-matches line', async () => {
      stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, { guildMembers: [] });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'zzzz' } });

      expect(await screen.findByTestId('guild-admin-typeahead-empty', {}, { timeout: 2000 }))
        .toHaveTextContent('No matching Discord server members.');
    });

    it('excludes members who are already Discord admins of this room', async () => {
      stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, {
        discordAdmins: [{ discord_user_id: '222222222222222222', role: 'admin', display_name: 'Krobs', username: 'krobs' }],
        guildMembers: [
          { discordUserId: '222222222222222222', displayName: 'Krobs', username: 'krobs', avatarHash: null },
          { discordUserId: '333333333333333333', displayName: 'ChuckRibbits', username: 'chuck', avatarHash: null },
        ],
      });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'ch' } });

      const list = await screen.findByTestId('guild-admin-typeahead', {}, { timeout: 2000 });
      expect(within(list).getByText('ChuckRibbits')).toBeInTheDocument();
      expect(within(list).queryByText('Krobs')).not.toBeInTheDocument();
    });

    it('excludes the signed-in viewer from suggestions', async () => {
      setToken(fakeAdminJwt('111111111111111111'));
      stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, {
        guildMembers: [
          { discordUserId: '111111111111111111', displayName: 'ViewerAdmin', username: 'viewer', avatarHash: null },
          { discordUserId: '222222222222222222', displayName: 'Krobs', username: 'krobs', avatarHash: null },
        ],
      });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'vi' } });

      const list = await screen.findByTestId('guild-admin-typeahead', {}, { timeout: 2000 });
      await within(list).findByText('Krobs', {}, { timeout: 2000 });
      expect(within(list).queryByText('ViewerAdmin')).not.toBeInTheDocument();
    });

    it('clicking a suggestion POSTs the admin-add endpoint and refreshes the admin list', async () => {
      const fetchMock = stubFetch({ DISCORD_GUILD_ID: 'guild-1' }, {
        guildMembers: [{ discordUserId: '555566667777888899', displayName: 'Charlie', username: 'charlie', avatarHash: null }],
      });
      renderSettings();
      await waitForLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'Add Discord Admin' }));

      const input = await screen.findByLabelText('Search Discord server members');
      fireEvent.change(input, { target: { value: 'ch' } });

      const list = await screen.findByTestId('guild-admin-typeahead', {}, { timeout: 2000 });
      fireEvent.click(within(list).getByText('Charlie'));

      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/admins/discord') && (c[1] as RequestInit)?.method === 'POST');
        expect(postCall).toBeTruthy();
        expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ discord_user_id: '555566667777888899' });
      });
      expect(await screen.findByText('Charlie added.')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // v2.116.0 (C1) — the Leaderboard Display card's controls moved to the
  // admin Leaderboard page's display rail. Two things must hold here: the
  // page points at their new home, and it still CLAIMS their keys. The
  // second is the silent one — `managedKeys` is built from CATEGORIES plus
  // the toggle maps, so dropping either would dump every moved key into the
  // raw "Other" card as an unlabelled text input.
  // ---------------------------------------------------------------------
  describe('Leaderboard Display relocation (C1)', () => {
    it('replaces the appearance controls with a link to the Leaderboard page', async () => {
      stubFetch({});
      renderSettings();
      await waitForLoaded();

      const link = screen.getByRole('link', { name: /Configure display settings/ });
      expect(link).toHaveAttribute('href', `/${ROOM_SLUG}/admin/leaderboard`);

      // None of the relocated groups renders here any more.
      expect(screen.queryByText('Style Profiles')).not.toBeInTheDocument();
      expect(screen.queryByText('Look')).not.toBeInTheDocument();
      expect(screen.queryByText('Fine tuning')).not.toBeInTheDocument();
      expect(screen.queryByText('Branding')).not.toBeInTheDocument();
      expect(screen.queryByText('Card Background Fill')).not.toBeInTheDocument();
      expect(screen.queryByText('Leaderboard Title')).not.toBeInTheDocument();
    });

    it('keeps every moved key out of the raw "Other" card', async () => {
      const MOVED_KEYS = [
        // CATEGORIES['Leaderboard Display']
        'SCOREBOARD_LAYOUT', 'SCOREBOARD_GAME_TITLE_STYLE', 'SCOREBOARD_MAX_SCORES',
        'SCOREBOARD_RANKINGS_POSITION', 'SCOREBOARD_ZOOM', 'SCOREBOARD_QR_MODE',
        // SCOREBOARD_TOGGLES (imported from lib/displaySettings)
        'SCOREBOARD_HIDE_EMPTY', 'SCOREBOARD_TITLE_HIDDEN', 'SCOREBOARD_CARD_BG_FILL',
        'SCOREBOARD_GAME_HEADER_ENABLED', 'SCOREBOARD_RANKINGS_STICKY',
        // Fine tuning + branding
        'SCOREBOARD_MIN_SCORES', 'SCOREBOARD_CARD_SPACING', 'SCOREBOARD_TITLE_FONT_SIZE',
        'SCOREBOARD_QR_SIZE', 'SCOREBOARD_QR_POSITION', 'SCOREBOARD_QR_OFFSET_PX',
        'SCOREBOARD_MOBILE_VERTICAL', 'SCOREBOARD_MOBILE_SCALE',
        'SCOREBOARD_BG_URL', 'SCOREBOARD_BG_MODE', 'SCOREBOARD_BG_OPACITY',
        'LOGO_URL', 'LOGO_POSITION', 'LOGO_MAX_HEIGHT', 'SCOREBOARD_LOGO_ENABLED',
        'SCOREBOARD_TITLE', 'SCOREBOARD_TITLE_STYLE', 'SCOREBOARD_TITLE_SIZE',
        'SCOREBOARD_STYLE', 'SCOREBOARD_THEME', 'SCOREBOARD_PODIUM_VARIANT',
        'SCOREBOARD_SHOW_TIMER',
      ];
      stubFetch(Object.fromEntries(MOVED_KEYS.map(k => [k, 'x'])));
      renderSettings();
      await waitForLoaded();

      expect(screen.queryByRole('heading', { name: 'Other' })).not.toBeInTheDocument();
      for (const key of MOVED_KEYS) {
        expect(screen.queryByText(key), `${key} leaked into "Other"`).not.toBeInTheDocument();
      }
    });
  });
});

/**
 * v2.125.0 — "Arcaid Chat Responses" (v2.123.0's "Arcaid Callout Responses").
 *
 * The retired `ENABLE_CALLOUTS` toggle that used to sit in the Integrations
 * card wrote a per-room key nothing read (the bot gated on the GLOBAL env var).
 * The four `CHAT_RESPONSES_*` keys are the real per-room gate, and the master
 * one is deliberately OPT-IN: absent reads as OFF, because replying in someone
 * else's Discord server is a social choice.
 *
 * THE CENTRAL CONTRACT IN THIS BLOCK IS INSTANT SAVE. Every test that changes
 * a control asserts the POST WITHOUT pressing "Save All Changes". The owner
 * flipped the old toggle off, never pressed Save, and the bot kept replying in
 * their Discord server — the switch showed OFF while the system was ON. These
 * tests exist so that cannot come back.
 */
describe('Settings page — Arcaid Chat Responses (per-room opt-in)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  const master = () => screen.getByRole('switch', { name: 'Arcaid Chat Responses' });

  it('reads OFF when the key is absent (opt-in, unlike most toggles here)', async () => {
    stubFetch({});
    renderSettings();
    await waitForLoaded();

    expect(master()).toHaveAttribute('aria-checked', 'false');
  });

  it('reads ON when stored as true', async () => {
    stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    expect(master()).toHaveAttribute('aria-checked', 'true');
  });

  it('the master toggle POSTs immediately, with NO Save press', async () => {
    const fetchMock = stubFetch({});
    renderSettings();
    await waitForLoaded();

    fireEvent.click(master());

    // No "Save All Changes" click anywhere in this test — that is the point.
    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    const payload = lastSavePayload(fetchMock)!;
    expect(payload.CHAT_RESPONSES_ENABLED).toBe('true');
    // The UI must not leave the sub-toggles reading "all off" while the backend
    // quietly applies its own default — it writes the same pair explicitly, in
    // the SAME request, so a half-failed save cannot leave the room enabled
    // with no categories.
    expect(JSON.parse(payload.CHAT_RESPONSES_CATEGORIES)).toEqual(['help', 'callouts']);
  });

  it('the instant POST carries ONLY the changed keys', async () => {
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true', DISCORD_GUILD_ID: '123' });
    renderSettings();
    await waitForLoaded();

    fireEvent.click(master());

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    // A partial POST cannot disturb a field the admin is midway through editing
    // elsewhere on the page (saveMany upserts only what it is given).
    expect(Object.keys(lastSavePayload(fetchMock)!)).toEqual(['CHAT_RESPONSES_ENABLED']);
  });

  it('turning it off saves the master key as false, immediately', async () => {
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    fireEvent.click(master());

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    expect(lastSavePayload(fetchMock)!.CHAT_RESPONSES_ENABLED).toBe('false');
  });

  it('a failed save reverts the switch instead of leaving it lying', async () => {
    // The whole reason for instant save is that the control must agree with the
    // server. If the write fails, the control has to go back.
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    fetchMock.mockImplementation((...args: FetchArgs) => {
      const [url, init] = args;
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/settings') && method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'nope' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });

    fireEvent.click(master());
    // Flips optimistically, then comes back when the write is refused.
    await waitFor(() => expect(master()).toHaveAttribute('aria-checked', 'true'));
  });

  it('the four category sub-toggles read from and instantly write the categories array', async () => {
    const fetchMock = stubFetch({
      CHAT_RESPONSES_ENABLED: 'true',
      CHAT_RESPONSES_CATEGORIES: JSON.stringify(['help', 'callouts']),
    });
    renderSettings();
    await waitForLoaded();

    expect(screen.getByRole('switch', { name: 'Helpful answers' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Game callouts' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Banter' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Easter eggs' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('switch', { name: 'Banter' }));

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    // Written in canonical order, not click order, so the stored value is
    // stable however the admin got there.
    expect(JSON.parse(lastSavePayload(fetchMock)!.CHAT_RESPONSES_CATEGORIES))
      .toEqual(['help', 'callouts', 'banter']);
  });

  it('turning a category OFF removes it from the array, immediately', async () => {
    const fetchMock = stubFetch({
      CHAT_RESPONSES_ENABLED: 'true',
      CHAT_RESPONSES_CATEGORIES: JSON.stringify(['help', 'callouts']),
    });
    renderSettings();
    await waitForLoaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Game callouts' }));

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    expect(JSON.parse(lastSavePayload(fetchMock)!.CHAT_RESPONSES_CATEGORIES)).toEqual(['help']);
  });

  it('stored channel ids render as removable chips', async () => {
    stubFetch({
      CHAT_RESPONSES_ENABLED: 'true',
      CHAT_RESPONSES_CHANNEL_IDS: JSON.stringify(['111', '222']),
    });
    renderSettings();
    await waitForLoaded();

    const chips = within(screen.getByTestId('chat-channel-chips')).getAllByRole('button');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('111');
  });

  it('the paste-an-ID fallback appends to the channel list, immediately', async () => {
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    // Empty list reads as "anywhere" — the documented absent state.
    expect(screen.getByText('Any channel the bot can read.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Channel ID'), { target: { value: '123456789012345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    expect(JSON.parse(lastSavePayload(fetchMock)!.CHAT_RESPONSES_CHANNEL_IDS))
      .toEqual(['123456789012345678']);
  });

  it('removing the last chip clears the row rather than storing an empty array', async () => {
    const fetchMock = stubFetch({
      CHAT_RESPONSES_ENABLED: 'true',
      CHAT_RESPONSES_CHANNEL_IDS: JSON.stringify(['111']),
    });
    renderSettings();
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Remove #111' }));

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    // Empty string is how GameRoomSettingsService is told to DELETE the row.
    expect(lastSavePayload(fetchMock)!.CHAT_RESPONSES_COOLDOWN_SEC).toBeUndefined();
    expect(lastSavePayload(fetchMock)!.CHAT_RESPONSES_CHANNEL_IDS).toBe('');
  });

  it('the cooldown defaults to 30 and commits on blur', async () => {
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    const input = screen.getByLabelText(/Cooldown \(seconds\)/) as HTMLInputElement;
    expect(input.value).toBe('30');
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input, { target: { value: '90' } });

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    expect(lastSavePayload(fetchMock)!.CHAT_RESPONSES_COOLDOWN_SEC).toBe('90');
  });

  it('the cooldown also commits on its own after the admin stops typing', async () => {
    const fetchMock = stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    const input = screen.getByLabelText(/Cooldown \(seconds\)/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.change(input, { target: { value: '45' } });

    // Mid-keystroke nothing has gone out, so "4" is never stored...
    expect(lastSavePayload(fetchMock)).toBeNull();

    // ...and then the debounce commits it with no further interaction. This is
    // what makes it safe for this field to skip the Save bar.
    await waitFor(
      () => expect(lastSavePayload(fetchMock)).not.toBeNull(),
      { timeout: 3000 },
    );
    expect(lastSavePayload(fetchMock)!.CHAT_RESPONSES_COOLDOWN_SEC).toBe('45');
  });

  it('none of these controls make the page dirty (they are already saved)', async () => {
    stubFetch({ CHAT_RESPONSES_ENABLED: 'true' });
    renderSettings();
    await waitForLoaded();

    expect(screen.getByRole('button', { name: /Save All Changes/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: 'Banter' }));

    // Baseline advances in lockstep with settings, so the Save bar stays inert
    // and the unsaved-changes navigation guard never fires for these keys.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Banter' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: /Save All Changes/ })).toBeDisabled();
  });

  it('the retired global toggle is gone, and a stored legacy value never leaks into "Other"', async () => {
    // The v2.123.0 pair is claimed too: the boot migration deletes those rows,
    // but a page loaded mid-upgrade must not leak them as raw text inputs.
    stubFetch({ ENABLE_CALLOUTS: 'true', CALLOUTS_ENABLED: 'true', CALLOUTS_CHANNEL_ID: '9' });
    renderSettings();
    await waitForLoaded();

    expect(screen.queryByText('Callouts (Easter Egg)')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other' })).not.toBeInTheDocument();
    expect(screen.queryByText('ENABLE_CALLOUTS')).not.toBeInTheDocument();
  });
});

/**
 * v2.132.0 — the Theme card is ONE field. "Admin Theme" was never a room
 * setting: it wrote the signed-in admin's `/me/preferences.ui_theme` from a
 * page whose every other control edits the room. It moved to Display settings
 * / Account settings, so this page must no longer write that endpoint at all.
 */
describe('Settings page — Room default theme (v2.132.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders a single "Room default theme" field and no "Admin Theme"', async () => {
    stubFetch({ UI_THEME: 'plasma' });
    renderSettings();
    await waitForLoaded();

    expect(screen.getByText('Room default theme')).toBeInTheDocument();
    expect(screen.queryByText('Admin Theme')).toBeNull();
    expect(screen.queryByText('Public Theme')).toBeNull();
    expect((document.getElementById('room-default-theme') as HTMLSelectElement).value).toBe('plasma');
  });

  it('stages UI_THEME on the room settings save and never posts /me/preferences', async () => {
    const fetchMock = stubFetch({ UI_THEME: 'plasma' });
    renderSettings();
    await waitForLoaded();

    fireEvent.change(document.getElementById('room-default-theme')!, { target: { value: 'midnight' } });
    fireEvent.click(screen.getByRole('button', { name: /Save All Changes/ }));

    await waitFor(() => expect(lastSavePayload(fetchMock)?.UI_THEME).toBe('midnight'));
    expect(fetchMock.mock.calls.some((c: FetchArgs) => String(c[0]).includes('/me/preferences'))).toBe(false);
  });
});
