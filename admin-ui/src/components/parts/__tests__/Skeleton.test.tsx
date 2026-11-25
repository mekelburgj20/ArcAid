import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton, SkeletonRows, SkeletonTiles } from '../Skeleton';

describe('Skeleton (G23)', () => {
    it('rows are a busy status with a hidden label and one row per count', () => {
        const { container } = render(<SkeletonRows count={4} />);
        const status = screen.getByRole('status');
        expect(status.getAttribute('aria-busy')).toBe('true');
        expect(status).toHaveTextContent('Loading');
        expect(container.querySelectorAll('.part-row')).toHaveLength(4);
        expect(container.querySelectorAll('.part-skel__tile')).toHaveLength(4);
    });

    it('tiles take a custom label and count', () => {
        const { container } = render(<SkeletonTiles count={3} label="Loading your stats" />);
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Loading your stats');
        expect(status.getAttribute('aria-busy')).toBe('true');
        expect(container.querySelectorAll('.part-tile')).toHaveLength(3);
    });

    it('one bar is decorative and takes its size', () => {
        const { container } = render(<Skeleton width="40%" height={12} />);
        const bar = container.querySelector('.part-skel__bar') as HTMLElement;
        expect(bar.getAttribute('aria-hidden')).toBe('true');
        expect(bar.style.width).toBe('40%');
        expect(bar.style.height).toBe('12px');
    });
});
