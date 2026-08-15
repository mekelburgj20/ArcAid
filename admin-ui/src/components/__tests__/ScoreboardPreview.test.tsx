import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScoreboardPreview from '../ScoreboardPreview';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

vi.mock('../../lib/portal', () => ({
  getPortal: vi.fn().mockResolvedValue({ public_theme: 'dark', ui_theme: 'dark' }),
}));

/**
 * Style-system revamp P1 — the Settings preview renders THE surface
 * (`ScoreboardSurface`) inside a real-viewport iframe, replacing the old
 * hand-rolled second implementation. Two things must hold: the preview shows
 * actual card content, and the phone toggle changes the iframe's VIEWPORT
 * (not merely a CSS width on a div — see DevicePreviewFrame for why).
 */
function renderPreview(settings: Record<string, string> = { SCOREBOARD_STYLE: 'arcade' }) {
  return render(
    <MemoryRouter>
      <ScoreboardPreview settings={settings} roomSlug="demo" roomName="Demo Room" />
    </MemoryRouter>
  );
}

function frame(container: HTMLElement): HTMLIFrameElement {
  return container.querySelector('iframe') as HTMLIFrameElement;
}

describe('ScoreboardPreview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the scoreboard inside an iframe rather than inline', async () => {
    const { container } = renderPreview();
    const iframe = frame(container);
    expect(iframe).toBeInTheDocument();

    await waitFor(() => {
      expect(iframe.contentDocument?.body.textContent).toContain('Medieval Madness');
    });
    // The mock content must NOT also be rendered in the parent document.
    expect(screen.queryByText('Medieval Madness')).not.toBeInTheDocument();
  });

  it('starts on desktop width and switches the iframe viewport to phone width', async () => {
    const { container } = renderPreview();
    const iframe = frame(container);

    expect(screen.getByRole('button', { name: /desktop/i })).toHaveAttribute('aria-pressed', 'true');
    expect(iframe.style.width).toBe('1100px');

    screen.getByRole('button', { name: /phone/i }).click();

    await waitFor(() => {
      expect(frame(container).style.width).toBe('390px');
    });
    expect(screen.getByRole('button', { name: /phone/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders a ranking group so the rankings settings have something to preview', async () => {
    const { container } = renderPreview();
    await waitFor(() => {
      expect(frame(container).contentDocument?.body.textContent).toContain('Season Standings');
    });
  });

  it('does not crash on a legacy room with no SCOREBOARD_STYLE', async () => {
    const { container } = renderPreview({});
    await waitFor(() => {
      expect(frame(container).contentDocument?.body.textContent).toContain('Medieval Madness');
    });
  });
});
