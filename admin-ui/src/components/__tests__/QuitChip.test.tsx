import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuitChip } from '../IntegrityChip';
import { quitLabelFor } from '../../lib/integrityBadge';

/** The quit chip (v2.189.0, W49): neutral, theme tokens only, nothing when there is no entry. */
describe('QuitChip', () => {
  it('renders the label and the explanation, in muted tokens rather than the flagged amber', () => {
    render(<QuitChip quit={quitLabelFor({ '5': { ball: 2 } }, 5)} />);
    const chip = screen.getByTestId('quit-chip');
    expect(chip).toHaveTextContent('Quit on ball 2');
    expect(chip.getAttribute('title')).toMatch(/still counts/);
    expect(chip.className).toMatch(/text-muted/);
    expect(chip.className).not.toMatch(/amber|red-|emerald/);
  });

  it('renders nothing for a row with no quit entry', () => {
    const { container } = render(<QuitChip quit={quitLabelFor({}, 5)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
