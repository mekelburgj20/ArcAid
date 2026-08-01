import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalScoreboardTitle from '../GlobalScoreboardTitle';
import { ThemeProvider } from '../ThemeProvider';

/** The treatment ships in a component-local <style> block; jsdom does not
 *  apply it, so the CSS assertions read the emitted rule text. */
function css(container: HTMLElement): string {
  return container.querySelector('style')!.textContent ?? '';
}

/** The visitor's explicit global-page polarity choice (ThemeProvider). */
function setPolarity(polarity: 'light' | 'dark') {
  localStorage.setItem('arcaid-global-theme', polarity);
}

function renderTitle(children?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/scoreboard']}>
      <ThemeProvider>
        <GlobalScoreboardTitle>{children}</GlobalScoreboardTitle>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

// v2.60.0 — the design pack's neon-trophy lockup replaces the flat
// Trophy-icon + <h1> pairing. The pack stacks seven identical copies of the
// wordmark to build the glitch; the accessibility contract is that a screen
// reader still meets exactly one heading reading "Global Scoreboard".
describe('GlobalScoreboardTitle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('exposes exactly one heading, named "Global Scoreboard"', () => {
    setPolarity('dark');
    renderTitle();

    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe('H1');
    expect(headings[0]).toHaveAccessibleName('Global Scoreboard');
  });

  it('hides every decorative layer, including the trophy, from assistive tech', () => {
    setPolarity('dark');
    const { container } = renderTitle();

    expect(container.querySelector('.gs-trophy')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.gs-plate')).toHaveAttribute('aria-hidden', 'true');

    // Seven visual copies of the word, six of them aria-hidden decoration.
    const copies = container.querySelectorAll('.gs-word > span');
    expect(copies).toHaveLength(8); // 7 visual layers + the visually-hidden one
    const hidden = container.querySelectorAll('.gs-word > span[aria-hidden="true"]');
    expect(hidden).toHaveLength(7);
  });

  it('swaps the theme class off the visitor\'s global-page polarity', () => {
    setPolarity('dark');
    const dark = renderTitle();
    expect(dark.container.querySelector('.gs-title')!.classList.contains('gs-dark')).toBe(true);
    expect(dark.container.querySelector('.gs-title')!.classList.contains('gs-light')).toBe(false);
    dark.unmount();

    localStorage.clear();
    setPolarity('light');
    const light = renderTitle();
    expect(light.container.querySelector('.gs-title')!.classList.contains('gs-light')).toBe(true);
    expect(light.container.querySelector('.gs-title')!.classList.contains('gs-dark')).toBe(false);
  });

  it('keeps the pack\'s prefers-reduced-motion block', () => {
    setPolarity('dark');
    const rules = css(renderTitle().container);

    expect(rules).toContain('@media (prefers-reduced-motion: reduce)');
    for (const cls of ['.gs-trophy', '.gs-t-fil', '.gs-fringe-a', '.gs-fringe-b', '.gs-slice-a', '.gs-slice-b']) {
      expect(rules.slice(rules.indexOf('@media (prefers-reduced-motion: reduce)'))).toContain(cls);
    }
    expect(rules.slice(rules.indexOf('@media (prefers-reduced-motion: reduce)'))).toContain('animation: none;');
  });

  it('self-hosts both Orbitron weights and never reaches for Google Fonts', () => {
    setPolarity('dark');
    const rules = css(renderTitle().container);

    expect(rules).toContain("src: url('/fonts/orbitron-900.woff2') format('woff2')");
    expect(rules).toContain("src: url('/fonts/orbitron-400.woff2') format('woff2')");
    expect(rules).not.toContain('fonts.googleapis.com');
    expect(rules).not.toContain('@import');
  });

  it('scales the whole lockup off one container-query-driven root size', () => {
    setPolarity('dark');
    const rules = css(renderTitle().container);

    expect(rules).toContain('container-type: inline-size');
    // Pinned to the design's native 68px once the container can hold 902px.
    expect(rules).toContain('font-size: min(68px, calc(100cqw / 13.2647))');
    // …with a viewport-unit fallback for engines without cqw.
    expect(rules).toContain('font-size: min(68px, 7.5vw)');
    expect(rules).toContain('--gs-fringe: .55');
  });

  it('renders caller content indented to the wordmark', () => {
    setPolarity('dark');
    const { container } = renderTitle(<p className="gs-sub">High scores from every Arcaid room.</p>);

    expect(screen.getByText('High scores from every Arcaid room.')).toBeInTheDocument();
    expect(container.querySelector('.gs-body')).toBeTruthy();
    expect(css(container)).toContain('.gs-body { padding-left: 2.3235em; }');
  });
});
