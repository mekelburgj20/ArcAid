import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GameInfoPopup from '../GameInfoPopup';

/**
 * "What's allowed" — the section that lets a player see a tournament's engine
 * and hardware rules without opening the submit sheet.
 *
 * The behaviours worth pinning are the ones a scoreboard would suffer for:
 * the fetch must be LAZY (a wall of cards must not fire N requests), it must
 * happen ONCE per card, and a failure must leave the pre-existing notes/link
 * popup intact rather than blanking it.
 */
describe('GameInfoPopup — What\'s allowed', () => {
  const payload = {
    platforms: ['vpx', 'pinball_fx', 'atgames'],
    submittable: ['vpx', 'atgames'],
    features: ['vpxs'],
    tournamentRules: {
      engines: { required: [], excluded: ['fx'] },
      devices: { required: [], excluded: [] },
    },
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not fetch until the bubble is opened, then fetches exactly once', async () => {
    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" />);
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Game info'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('/api/submit/platforms?roomId=room-1&gameName=WHO+dunnit');

    // Close and reopen — the resolution is cached for the popup's life.
    fireEvent.click(screen.getByLabelText('Game info'));
    fireEvent.click(screen.getByLabelText('Game info'));
    await waitFor(() => expect(screen.getByText('Visual Pinball X')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lists the engines and hardware the picker would offer, under a tournament heading', async () => {
    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" />);
    fireEvent.click(screen.getByLabelText('Game info'));

    await waitFor(() => expect(screen.getByText('This tournament allows')).toBeInTheDocument());
    expect(screen.getByText('Engines')).toBeInTheDocument();
    expect(screen.getByText('Hardware')).toBeInTheDocument();
    // `atgames` maps to engine `unknown` and is dropped by the picker's engine
    // fold, leaving VPX — exactly what SubmissionSheet would show.
    expect(screen.getByText('Visual Pinball X')).toBeInTheDocument();
    // The VPX device set, with AtGames guaranteed by the `vpxs` feature.
    expect(screen.getByText('AtGames Cabinet')).toBeInTheDocument();
    expect(screen.getByText('PC')).toBeInTheDocument();
    // Submittable is narrower than the game's platforms → say so.
    expect(screen.getByText(/Narrowed by this tournament/)).toBeInTheDocument();
  });

  it('labels an unrestricted game "Available on" and omits the narrowing note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        platforms: ['vpx'], submittable: ['vpx'], features: [], tournamentRules: null,
      }),
    })) as unknown as typeof fetch);

    render(<GameInfoPopup globalGameId="gg-1" />);
    fireEvent.click(screen.getByLabelText('Game info'));

    await waitFor(() => expect(screen.getByText('Available on')).toBeInTheDocument());
    expect(screen.queryByText(/Narrowed by/)).not.toBeInTheDocument();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('/api/submit/platforms?globalGameId=gg-1');
  });

  /**
   * v2.70.0 — the endpoint now ships `restrictedText` (it used to strip it, so
   * the FE's defensive read never had anything to render). These two pin the
   * behaviour the backend change lights up: the admin's own wording appears,
   * styled amber to read as a constraint rather than as another chip label,
   * and an absent/blank value renders nothing at all.
   */
  it('renders the tournament\'s restrictedText in amber above the chips', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...payload,
        tournamentRules: { ...payload.tournamentRules, restrictedText: 'Cabinet play only this round.' },
      }),
    })) as unknown as typeof fetch);

    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" />);
    fireEvent.click(screen.getByLabelText('Game info'));

    const line = await screen.findByText('Cabinet play only this round.');
    expect(line.className).toContain('text-neon-amber');
    // It is context for the chips, not a replacement — both still render.
    expect(screen.getByText('Visual Pinball X')).toBeInTheDocument();
  });

  it('renders no restriction line when the tournament set none', async () => {
    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" />);
    fireEvent.click(screen.getByLabelText('Game info'));

    await waitFor(() => expect(screen.getByText('This tournament allows')).toBeInTheDocument());
    // The base `payload` carries no restrictedText — nothing amber may appear.
    expect(document.querySelector('.text-neon-amber\\/90')).toBeNull();
  });

  it('keeps notes and the external link when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);

    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" notes="Play the left ramp." />);
    fireEvent.click(screen.getByLabelText('Game info'));

    await waitFor(() => expect(screen.getByText(/Couldn't load what's allowed/)).toBeInTheDocument());
    expect(screen.getByText('Play the left ramp.')).toBeInTheDocument();
  });

  it('renders the trigger even with no notes or link, once a fetch target exists', () => {
    render(<GameInfoPopup roomId="room-1" gameName="WHO dunnit" />);
    expect(screen.getByLabelText('Game info')).toBeInTheDocument();
  });

  it('still renders nothing at all when there is no content and no fetch target', () => {
    const { container } = render(<GameInfoPopup />);
    expect(container).toBeEmptyDOMElement();
  });
});
