import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DisplaySettingsPanel from '../scoreboard/DisplaySettingsPanel';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.116.0 (C1) — the room-display controls after their move off the Settings
 * page. This is a RELOCATION test: it pins that every group that used to live
 * in the "Leaderboard Display" card is still here (profiles, the Look picker,
 * the five toggles, Fine tuning, Branding) and that a control edit reports the
 * key its Settings-page ancestor reported, not a renamed one.
 *
 * The panel is a pure controlled component — it holds no settings state of its
 * own — so "the surface live-previews the edit" is the HOST's contract and is
 * pinned in LeaderboardDisplayRail.test.tsx instead.
 */

const ROOM_ID = 'room-1';

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    // StyleProfiles renders nothing until this resolves, and it sits at the
    // top of the panel — an unrouted response would blank half the tests.
    if (url.includes('/admin/style-profiles')) return j({ profiles: [], current: {} });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPanel(
  settings: Record<string, string> = {},
  overrides: Partial<React.ComponentProps<typeof DisplaySettingsPanel>> = {},
) {
  const onChange = vi.fn();
  const onServerChange = vi.fn();
  render(
    <MemoryRouter>
      <DisplaySettingsPanel
        roomId={ROOM_ID}
        roomName="Test Room"
        settings={settings}
        onChange={onChange}
        onServerChange={onServerChange}
        hasUnsavedChanges={false}
        onProfileApplied={vi.fn()}
        toast={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onChange, onServerChange };
}

/** Toggle/number rows share one DOM shape: a label div (two <p>s) and the
 *  control as its sibling. Locate the row by its label text. */
function rowFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  return label.closest('div')!.parentElement as HTMLElement;
}

describe('DisplaySettingsPanel — relocated control groups', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubFetch();
  });

  it('renders every group that lived in the Settings "Leaderboard Display" card', async () => {
    renderPanel();

    // Style Profiles (async-loaded, sits first)
    expect(await screen.findByText('Style Profiles')).toBeInTheDocument();
    // StyleThemePicker
    expect(screen.getByText('Look')).toBeInTheDocument();
    // The five inline toggles
    for (const label of [
      'Hide Empty Games', 'Hide Game Room Title', 'Card Background Fill',
      'Game Art Header', 'Always Visible Rankings',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Fine tuning + Branding
    expect(screen.getByText('Fine tuning')).toBeInTheDocument();
    expect(screen.getByText('Card Spacing (px)')).toBeInTheDocument();
    expect(screen.getByText('QR Code Position')).toBeInTheDocument();
    expect(screen.getByText('Mobile Density')).toBeInTheDocument();
    expect(screen.getByText('Branding')).toBeInTheDocument();
    expect(screen.getByText('Background Image')).toBeInTheDocument();
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.getByText('Leaderboard Title')).toBeInTheDocument();
  });

  it('a toggle reports its own key, default-resolved', () => {
    // SCOREBOARD_CARD_BG_FILL defaults ON, so the first click turns it off.
    const { onChange } = renderPanel();
    fireEvent.click(within(rowFor('Card Background Fill')).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_CARD_BG_FILL', 'false');
  });

  it('an off-default toggle reports true on first click', () => {
    const { onChange } = renderPanel();
    fireEvent.click(within(rowFor('Hide Empty Games')).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_HIDE_EMPTY', 'true');
  });

  it('a fine-tuning number reports its key', () => {
    const { onChange } = renderPanel();
    const input = within(rowFor('Card Spacing (px)')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '32' } });
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_CARD_SPACING', '32');
  });

  it('a branding field reports its key', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByPlaceholderText('Leave empty to use room name'), {
      target: { value: 'Arcade Night' },
    });
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_TITLE', 'Arcade Night');
  });

  it('reflects the settings it is handed rather than any state of its own', () => {
    renderPanel({ SCOREBOARD_TITLE: 'Stored Title', SCOREBOARD_CARD_SPACING: '40' });
    expect(screen.getByDisplayValue('Stored Title')).toBeInTheDocument();
    expect(within(rowFor('Card Spacing (px)')).getByRole('spinbutton')).toHaveValue(40);
  });

  it('offers the phone preview only when the host supplies one (desktop)', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /Phone preview/ })).not.toBeInTheDocument();
  });

  it('renders the host-supplied phone preview when toggled on', () => {
    renderPanel({}, { renderPhonePreview: () => <div data-testid="phone-preview" /> });
    const toggle = screen.getByRole('button', { name: /Phone preview/ });
    expect(screen.queryByTestId('phone-preview')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId('phone-preview')).toBeInTheDocument();
  });
});
