import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatTiles from '../StatTiles';

describe('StatTiles (G23)', () => {
    it('shows each label with its value, in one row of that many columns', () => {
        const { container } = render(<StatTiles tiles={[{ label: 'Plays', value: '128' }, { label: 'Rank', value: '3rd' }, { label: 'Points', value: '12,450' }]} />);
        expect(screen.getByText('Plays')).toBeInTheDocument();
        expect(screen.getByText('12,450')).toBeInTheDocument();
        expect(container.querySelectorAll('.part-tile')).toHaveLength(3);
        expect((container.querySelector('.part-tiles') as HTMLElement).style.getPropertyValue('--part-tiles-cols')).toBe('3');
    });

    it('caps the columns at four', () => {
        const tiles = ['a', 'b', 'c', 'd', 'e'].map(l => ({ label: l, value: 1 }));
        const { container } = render(<StatTiles tiles={tiles} />);
        expect((container.querySelector('.part-tiles') as HTMLElement).style.getPropertyValue('--part-tiles-cols')).toBe('4');
    });
});
