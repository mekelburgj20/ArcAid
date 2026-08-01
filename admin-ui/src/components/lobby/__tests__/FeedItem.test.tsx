import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FeedItem from '../FeedItem';

// ---------------------------------------------------------------------------
// pick_prompt feed rows.
//
// The countdown is computed at render from the event's deadline, never baked
// into the title — the feed is append-only, so a stored "45 minutes remaining"
// would still be shouting it days later. These tests pin both halves: a live
// countdown while the window is open, and a neutral closed state after it.
// ---------------------------------------------------------------------------

/**
 * Deadlines carry a few seconds of slack so the floor-to-whole-minutes
 * countdown can't tick down a minute between construction and assertion.
 */
function inMinutes(mins: number): string {
  return new Date(Date.now() + mins * 60_000 + 5_000).toISOString();
}

function pickPromptEvent(overrides: Record<string, any> = {}) {
  const { metadata: metadataOverrides, ...rest } = overrides;
  return {
    id: 1,
    type: 'pick_prompt',
    icon: null,
    title: 'Justin, pick the next game for Weekly Grind',
    subtitle: null,
    game_name: null,
    created_at: new Date().toISOString(),
    ...rest,
    metadata: {
      deadline: inMinutes(45),
      windowMin: 60,
      pickerType: 'WINNER',
      fallback: 'runner_up',
      ...(metadataOverrides ?? {}),
    },
  };
}

function renderItem(event: any) {
  return render(
    <MemoryRouter>
      <FeedItem event={event} slug="rtx_pinball" />
    </MemoryRouter>,
  );
}

describe('FeedItem — pick_prompt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the server-composed title', () => {
    renderItem(pickPromptEvent());
    expect(screen.getByText('Justin, pick the next game for Weekly Grind')).toBeInTheDocument();
  });

  it('renders a live countdown derived from the deadline', () => {
    renderItem(pickPromptEvent());
    expect(screen.getByText(/45 minutes remaining/)).toBeInTheDocument();
  });

  it('names the runner-up as the consequence when that is the fallback', () => {
    renderItem(pickPromptEvent());
    expect(screen.getByText(/before the runner-up gets the pick/)).toBeInTheDocument();
  });

  it('names autopick when there is no runner-up to pass to', () => {
    renderItem(pickPromptEvent({ metadata: { fallback: 'autopick' } }));
    expect(screen.getByText(/before autopick/)).toBeInTheDocument();
  });

  it('formats windows over an hour as hours and minutes', () => {
    renderItem(pickPromptEvent({ metadata: { deadline: inMinutes(95) } }));
    expect(screen.getByText(/1h 35m remaining/)).toBeInTheDocument();
  });

  it('renders a closed state once the deadline has passed — never a stale countdown', () => {
    renderItem(pickPromptEvent({ metadata: { deadline: inMinutes(-10) } }));
    expect(screen.getByText('Pick window closed')).toBeInTheDocument();
    expect(screen.queryByText(/remaining/)).not.toBeInTheDocument();
  });

  it('ticks down as time passes', () => {
    vi.useFakeTimers();
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    renderItem(pickPromptEvent({ metadata: { deadline } }));

    expect(screen.getByText(/10 minutes remaining/)).toBeInTheDocument();

    // Past the deadline, the same row must flip to the closed state without a
    // remount — this is the "don't keep shouting" requirement.
    act(() => { vi.advanceTimersByTime(11 * 60_000); });
    expect(screen.getByText('Pick window closed')).toBeInTheDocument();
  });

  it('degrades gracefully when metadata carries no deadline', () => {
    renderItem(pickPromptEvent({ metadata: { deadline: undefined } }));
    expect(screen.getByText('Justin, pick the next game for Weekly Grind')).toBeInTheDocument();
    expect(screen.queryByText(/remaining/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pick window closed')).not.toBeInTheDocument();
  });

  it('does not render a countdown on other event types', () => {
    renderItem({
      id: 2,
      type: 'score_posted',
      icon: null,
      title: 'Justin submitted 1.2M on Fire Mountain',
      subtitle: null,
      game_name: 'Fire Mountain',
      created_at: new Date().toISOString(),
      metadata: { deadline: new Date(Date.now() + 30 * 60_000).toISOString() },
    });
    expect(screen.queryByText(/remaining before/)).not.toBeInTheDocument();
  });
});
