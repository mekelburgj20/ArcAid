import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from '../Settings';
import { RoomContext } from '../../contexts/RoomContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import { ToastProvider } from '../../components/Toast';
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

/** Stubs global fetch for the settings GET/POST + the three admin-list GETs
 *  the page fires on mount (all swallowed on error by the component, but
 *  stubbed anyway to keep the console clean and avoid unrelated act() noise). */
function stubFetch(settingsResponse: Record<string, string>) {
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/settings') && method === 'GET') return j(settingsResponse);
    if (url.includes('/settings') && method === 'POST') return j({ success: true });
    if (url.includes('/admins/invites')) return j([]);
    if (url.includes('/admin/members')) return j([]);
    if (url.includes('/admins')) return j({ localAdmins: [], discordAdmins: [] });
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
});
