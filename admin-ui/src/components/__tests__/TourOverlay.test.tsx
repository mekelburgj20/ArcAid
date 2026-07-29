import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TourOverlay from '../TourOverlay';
import type { TourStep } from '../../lib/tourSteps';

/**
 * v2.48.0 — first-login player tutorial (tmp/first-login-tutorial-contract.md).
 * TourOverlay owns step navigation AND the finish/skip persistence writes
 * (POST /me/tutorial-status vs. sessionStorage-only dismissal), so these
 * tests exercise it directly with real DOM anchors rather than going through
 * TourController's gating fetch.
 */

const ALL_STEPS: TourStep[] = [
  { key: 'nav', selector: '[data-tour="nav"]', title: 'Find your way around', body: 'Nav body copy.' },
  { key: 'nav-scores', selector: '[data-tour="nav-scores"]', title: 'Scores', body: 'Scores body copy.' },
  { key: 'game-card-title', selector: '[data-tour="game-card-title"]', title: 'Game details', body: 'Card body copy.' },
  { key: 'user-menu', selector: '[data-tour="user-menu"]', title: 'Account menu', body: 'Menu body copy.' },
];

/** Mounts real DOM anchors (queried via document.querySelector by TourOverlay,
 * not scoped to the RTL container) alongside the overlay itself. */
function Anchors({ tours }: { tours: string[] }) {
  return (
    <>
      {tours.map(t => (
        <div key={t} data-tour={t} style={{ width: 40, height: 20 }} />
      ))}
    </>
  );
}

function renderOverlay(tours: string[], steps: TourStep[] = ALL_STEPS) {
  const onClose = vi.fn();
  const utils = render(
    <>
      <Anchors tours={tours} />
      <TourOverlay steps={steps} playerToken="test-token" onClose={onClose} />
    </>,
  );
  return { ...utils, onClose };
}

describe('TourOverlay', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ seenAt: '2026-07-28T00:00:00.000Z' }) })) as unknown as typeof fetch);
  });

  it('renders the first step with its title, body, and step count', () => {
    renderOverlay(['nav', 'nav-scores']);
    expect(screen.getByRole('dialog', { name: 'Welcome tour' })).toBeInTheDocument();
    expect(screen.getByText('Find your way around')).toBeInTheDocument();
    expect(screen.getByText('Nav body copy.')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  });

  it('Next advances to the next step, Back returns to the previous one', () => {
    renderOverlay(['nav', 'nav-scores']);
    expect(screen.getByText('Nav body copy.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Scores body copy.')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Nav body copy.')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  });

  it('skips a step whose anchor does not exist in the DOM', () => {
    // nav-scores and game-card-title anchors absent — only nav + user-menu present.
    renderOverlay(['nav', 'user-menu']);
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Find your way around')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));
    // Jumps straight from nav to user-menu, skipping the two missing-anchor steps.
    expect(screen.getByText('Account menu')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Finish')).toBeInTheDocument();
  });

  it('finishing the tour (last step Next -> Finish) always POSTs tutorial-status', async () => {
    const { onClose } = renderOverlay(['nav']);
    fireEvent.click(screen.getByText('Finish'));

    expect(fetch).toHaveBeenCalledWith(
      '/api/me/tutorial-status',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer test-token' } }),
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Skip with "Don\'t show this again" checked (default) POSTs tutorial-status', async () => {
    const { onClose } = renderOverlay(['nav', 'nav-scores']);
    expect(screen.getByRole('checkbox')).toBeChecked();

    fireEvent.click(screen.getByText('Skip tour'));

    expect(fetch).toHaveBeenCalledWith(
      '/api/me/tutorial-status',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer test-token' } }),
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Skip with the checkbox unchecked sets sessionStorage and does not POST', () => {
    const { onClose } = renderOverlay(['nav', 'nav-scores']);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();

    fireEvent.click(screen.getByText('Skip tour'));

    expect(sessionStorage.getItem('arcaid_tutorial_dismissed')).toBe('1');
    expect(fetch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key triggers Skip, respecting the checkbox state', () => {
    const { onClose } = renderOverlay(['nav']);
    fireEvent.click(screen.getByRole('checkbox')); // uncheck
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(sessionStorage.getItem('arcaid_tutorial_dismissed')).toBe('1');
    expect(fetch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('renders null and never shows a dialog when no step anchors exist in the DOM', async () => {
    const { onClose } = renderOverlay([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    // Treated as "finished" — still marks seen server-side.
    expect(fetch).toHaveBeenCalledWith(
      '/api/me/tutorial-status',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
