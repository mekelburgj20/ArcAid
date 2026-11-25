import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmptyState from '../EmptyState';
import Button from '../Button';

describe('EmptyState (G23)', () => {
    it('shows the title, the sentence and the action', () => {
        render(<EmptyState title="No tables yet" action={<Button>Add a table</Button>}>Tables you add show up here.</EmptyState>);
        expect(screen.getByText('No tables yet')).toBeInTheDocument();
        expect(screen.getByText('Tables you add show up here.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add a table' })).toBeInTheDocument();
    });

    it('hides the triangle from assistive tech and takes a pink tone', () => {
        const { container } = render(<EmptyState title="Nothing" tone="pink" />);
        expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('.part-empty--pink')).not.toBeNull();
        expect(container.querySelector('.part-empty__action')).toBeNull();
    });
});
