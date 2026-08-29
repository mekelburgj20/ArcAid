import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScorePhotoModal from '../ScorePhotoModal';

/**
 * v2.147.0 — per-score share. `sharePath` is optional and additive: passing
 * it renders the existing `ShareButton` (icon-only) in the header next to the
 * close X; omitting it keeps this modal byte-identical to its pre-share
 * behavior. Companion to GameQuickView.photo.test.tsx (same lightbox), scoped
 * to just this new prop rather than re-covering the photo/no-photo body.
 */
describe('ScorePhotoModal — share button', () => {
  it('renders no Share button when sharePath is omitted', () => {
    render(
      <ScorePhotoModal
        playerName="Ada"
        score={4200}
        photoUrl={null}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });

  it('renders a Share button when sharePath is given', () => {
    render(
      <ScorePhotoModal
        playerName="Ada"
        score={4200}
        photoUrl={null}
        sharePath="/rtx_pinball/games/Whirlwind?score=11"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('still renders the photo and the close button regardless of sharePath', () => {
    render(
      <ScorePhotoModal
        playerName="Ada"
        score={4200}
        photoUrl="/api/score-photos/ada.jpg"
        sharePath="/rtx_pinball/games/Whirlwind?score=11"
        onClose={() => {}}
      />,
    );
    expect(screen.getByAltText('Ada — 4,200 photo evidence')).toBeInTheDocument();
  });
});
