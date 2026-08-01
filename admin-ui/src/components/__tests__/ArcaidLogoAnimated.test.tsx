import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ArcaidLogoAnimated from '../ArcaidLogoAnimated';

/** The component ships its CSS in a local <style> block; jsdom does not apply
 *  it, so the styling assertions read the emitted rule text instead. */
function css(container: HTMLElement): string {
  return container.querySelector('style')!.textContent ?? '';
}

// Logo refresh (v2.45.0) — "Delta House Chrome". The wordmark is rendered as
// four stacked, aria-hidden decorative text layers (pink/cyan glitch-ghosts +
// the chrome layer) so a screen reader isn't read "Arcaid" four times; the
// single accessible name comes from the wrapping role="img" aria-label.
describe('ArcaidLogoAnimated', () => {
  it('renders one accessible "Arcaid" image label, no crash, honors maxWidth', () => {
    render(<ArcaidLogoAnimated maxWidth={640} />);

    const img = screen.getByRole('img', { name: 'Arcaid' });
    expect(img).toBeInTheDocument();

    // The four duplicate text layers exist in the DOM (for the visual glitch
    // effect) but are aria-hidden — only one accessible node should match.
    expect(screen.getAllByRole('img', { name: 'Arcaid' })).toHaveLength(1);
  });

  it('defaults maxWidth to a hero-sized value when not provided', () => {
    const { container } = render(<ArcaidLogoAnimated />);
    const wrap = container.querySelector('.arcaid-logo-wrap') as HTMLElement;
    expect(wrap).toBeInTheDocument();
    expect(wrap.style.maxWidth).toBe('720px');
  });
});

// v2.60.0 — the light variant. Same canvas, same crop, same glitch cadence;
// only the lighting changes. These lock the five differences the design pack
// enumerates, and (just as importantly) that the dark render did not move.
describe('ArcaidLogoAnimated — variant', () => {
  it('defaults to dark and keeps the dark composition unchanged', () => {
    const { container } = render(<ArcaidLogoAnimated />);
    const wrap = container.querySelector('.arcaid-logo-wrap') as HTMLElement;

    expect(wrap.classList.contains('arcaid-logo-dark')).toBe(true);
    expect(wrap.classList.contains('arcaid-logo-light')).toBe(false);

    // No backdrop plate, and no dark glyph-shadow copies.
    expect(container.querySelector('.arcaid-logo-plate')).toBeNull();
    expect(container.querySelector('.arcaid-logo-sh1')).toBeNull();
    expect(container.querySelector('.arcaid-logo-sh2')).toBeNull();

    // Single pale-pink delta stroke, not the three-layer glass tube.
    expect(container.querySelector('[stroke="#FFA8BE"]')).toBeTruthy();
    expect(container.querySelector('.arcaid-logo-tube-core')).toBeNull();

    // Dark glitch cyan, and the cyan halo still on the wordmark.
    expect(container.querySelector('[stroke="#5BC8F5"]')).toBeTruthy();
    expect(css(container)).toContain('drop-shadow(0 0 10px rgba(53, 214, 232, .8))');
  });

  it('light adds the purple backdrop plate at the measured position', () => {
    const { container } = render(<ArcaidLogoAnimated variant="light" />);
    const wrap = container.querySelector('.arcaid-logo-wrap') as HTMLElement;

    expect(wrap.classList.contains('arcaid-logo-light')).toBe(true);
    expect(container.querySelector('.arcaid-logo-plate')).toBeTruthy();

    const rules = css(container);
    expect(rules).toContain('left: 17px');
    expect(rules).toContain('top: 210px');
    expect(rules).toContain('width: 556px');
    expect(rules).toContain('height: 138px');
    expect(rules).toContain('skewX(-10deg)');
    expect(rules).toContain('linear-gradient(180deg, #4A1D82 0%, #2A0C52 46%, #1B0638 62%, #3A1468 100%)');
  });

  it('light drops the cyan halo for a cast shadow plus two blurred glyph copies', () => {
    const { container } = render(<ArcaidLogoAnimated variant="light" />);

    expect(container.querySelector('.arcaid-logo-sh1')).toBeTruthy();
    expect(container.querySelector('.arcaid-logo-sh2')).toBeTruthy();

    const rules = css(container);
    // The halo rule survives for the dark variant, but the light variant must
    // override .arcaid-logo-word's filter with the flat cast shadow.
    expect(rules).toContain('.arcaid-logo-light .arcaid-logo-word {');
    expect(rules).toContain('filter: drop-shadow(0 2px 2px rgba(10,16,25,.45));');
    expect(rules).toContain('filter: blur(22px)');
    expect(rules).toContain('filter: blur(9px)');
  });

  it('light rebuilds the delta as a three-layer glass tube and darkens the glitch cyan', () => {
    const { container } = render(<ArcaidLogoAnimated variant="light" />);

    expect(container.querySelector('.arcaid-logo-tube-bloom')).toBeTruthy();
    expect(container.querySelector('.arcaid-logo-tube-core')).toBeTruthy();
    expect(container.querySelector('.arcaid-logo-tube-fil')).toBeTruthy();
    // The dark variant's single pale-pink stroke is gone.
    expect(container.querySelector('[stroke="#FFA8BE"]')).toBeNull();

    // Glitch cyan #5BC8F5 -> #0F9BD1 so it holds on a light surface.
    expect(container.querySelector('[stroke="#5BC8F5"]')).toBeNull();
    expect(container.querySelector('[stroke="#0F9BD1"]')).toBeTruthy();
    expect(css(container)).toContain('.arcaid-logo-light .arcaid-logo-word .arcaid-logo-cyan { color: #0F9BD1; }');
  });

  it('light gives the pinball a dark rim and a contact shadow', () => {
    const { container } = render(<ArcaidLogoAnimated variant="light" />);
    const rules = css(container);
    expect(rules).toContain('inset 0 0 0 1px rgba(12,33,54,.50)');
    expect(rules).toContain('0 2px 6px rgba(16,38,62,.45)');
  });

  it('keeps the v2.45.6 glitch cadence identical across variants', () => {
    const dark = css(render(<ArcaidLogoAnimated />).container);
    const light = css(render(<ArcaidLogoAnimated variant="light" />).container);

    for (const rules of [dark, light]) {
      expect(rules).toContain('arcaidGlitchText 18s steps(1) infinite');
      expect(rules).toContain('arcaidGlitchTri 26s steps(1) infinite');
      expect(rules).toContain('animation-delay: -7.7s');
      expect(rules).toContain('animation-delay: -3.1s');
      expect(rules).toContain('animation-delay: -12.4s');
    }

    // The keyframe timing offsets themselves are shared verbatim — only the
    // opacity stops are parameterised, and their dark fallbacks are the old
    // literal values.
    const keyframes = (s: string) => s.slice(s.indexOf('@keyframes arcaidGlitchText'), s.indexOf('.arcaid-logo-tri-p'));
    expect(keyframes(light)).toBe(keyframes(dark));
    expect(keyframes(dark)).toContain('var(--arcaid-gl-rest, .75)');
  });
});
