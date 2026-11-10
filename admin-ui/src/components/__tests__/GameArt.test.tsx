import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GameArt from '../GameArt';

/** v2.240.0 (B25) — the table-art thumbnail beside each game on the results pages. */
describe('GameArt', () => {
  it('draws the art, decorative and lazy', () => {
    render(<GameArt src="/api/catalogue-images/godzilla.png" name="Godzilla" size={40} />);
    const img = screen.getByTestId('game-art');
    expect(img).toHaveAttribute('src', '/api/catalogue-images/godzilla.png');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('width', '40');
    expect(img.style.getPropertyValue('--art')).toBe('40px');
    expect(img.style.getPropertyValue('--art-sm')).toBe('40px');
  });

  it('with no art, draws the game\'s initials on a tile the same size', () => {
    render(<GameArt src={null} name="Attack from Mars" size={40} />);
    const tile = screen.getByTestId('game-art-fallback');
    expect(tile).toHaveTextContent('AM');
    expect(tile.style.getPropertyValue('--art')).toBe('40px');
  });

  it('takes its own phone size (v2.241.0)', () => {
    render(<GameArt src="/a.png" name="Godzilla" size={112} mobileSize={84} />);
    const img = screen.getByTestId('game-art');
    expect(img.style.getPropertyValue('--art')).toBe('112px');
    expect(img.style.getPropertyValue('--art-sm')).toBe('84px');
    expect(img.className).toContain('sm:w-[var(--art)]');
  });

  it('falls back to the initials when the art fails to load, and tries a new src again', () => {
    const { rerender } = render(<GameArt src="/broken.png" name="Godzilla" />);
    fireEvent.error(screen.getByTestId('game-art'));
    expect(screen.getByTestId('game-art-fallback')).toHaveTextContent('GO');

    rerender(<GameArt src="/fixed.png" name="Godzilla" />);
    expect(screen.getByTestId('game-art')).toHaveAttribute('src', '/fixed.png');
  });

  it('initials: two significant words, else the first two letters', () => {
    const initials = (name: string) => {
      const { unmount } = render(<GameArt src={null} name={name} />);
      const text = screen.getByTestId('game-art-fallback').textContent;
      unmount();
      return text;
    };
    expect(initials('The Addams Family')).toBe('TA');
    expect(initials('Twilight Zone')).toBe('TZ');
    expect(initials('Godzilla (Stern 2021)')).toBe('GS');
    expect(initials('funhouse')).toBe('FU');
  });
});
