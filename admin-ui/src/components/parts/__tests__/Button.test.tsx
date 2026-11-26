import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import Button, { ButtonLink } from '../Button';

/**
 * G21 - the shared button: three variants, three sizes, site tokens only (so
 * it needs no skin), `type="button"` unless the caller says otherwise.
 */
describe('Button', () => {
    it('defaults to a medium primary that never submits a form by accident', () => {
        const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
        render(<form onSubmit={onSubmit}><Button>Save</Button></form>);
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button.getAttribute('type')).toBe('button');
        expect(button.className).toBe(
            'part-focus inline-flex items-center justify-center gap-1.5 rounded border font-medium cursor-pointer transition-colors '
            + 'disabled:opacity-50 disabled:cursor-not-allowed px-4 py-1.5 text-sm '
            // The theme's lead (v2.263.0, G29), never a fixed accent.
            + 'border-lead/40 bg-lead/10 ink-lead hover:bg-lead/20',
        );
        fireEvent.click(button);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('keeps a type the caller passes', () => {
        render(<Button type="submit">Go</Button>);
        expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('submit');
    });

    it('draws the secondary and danger variants', () => {
        render(<><Button variant="secondary">Cancel</Button><Button variant="danger">Delete</Button></>);
        const secondary = screen.getByRole('button', { name: 'Cancel' }).className;
        expect(secondary).toContain('border-border bg-transparent text-muted hover:text-primary hover:border-muted');
        expect(secondary).not.toContain('lead');
        const danger = screen.getByRole('button', { name: 'Delete' }).className;
        expect(danger).toContain('border-neon-coral/40 bg-neon-coral/10 ink-danger hover:bg-neon-coral/20');
        // The theme-aware token, never Tailwind's fixed rose.
        expect(danger).not.toContain('rose');
    });

    it('draws the three sizes', () => {
        render(<><Button>M</Button><Button size="sm">S</Button><Button size="xs">X</Button></>);
        expect(screen.getByRole('button', { name: 'M' }).className).toContain(' px-4 py-1.5 text-sm ');
        expect(screen.getByRole('button', { name: 'S' }).className).toContain(' px-3 py-1.5 text-xs ');
        expect(screen.getByRole('button', { name: 'X' }).className).toContain(' px-2 py-1 text-xs ');
    });

    it('never animates every property or removes the focus ring', () => {
        render(<Button variant="danger" size="xs">B</Button>);
        const cls = screen.getByRole('button', { name: 'B' }).className;
        expect(cls).not.toContain('transition-all');
        expect(cls).not.toContain('outline-none');
    });

    it('appends layout classes, passes props through and forwards its ref', () => {
        const ref = createRef<HTMLButtonElement>();
        const onClick = vi.fn();
        render(<Button ref={ref} className="shrink-0 mb-3" onClick={onClick} aria-label="Pair" disabled>x</Button>);
        const button = screen.getByRole('button', { name: 'Pair' });
        expect(ref.current).toBe(button);
        expect(button.className.endsWith(' shrink-0 mb-3')).toBe(true);
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('fires onClick when enabled', () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Go</Button>);
        fireEvent.click(screen.getByRole('button', { name: 'Go' }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('ButtonLink is a router link drawn like a button', () => {
        render(<MemoryRouter><ButtonLink to="/my-rooms" variant="secondary" size="xs">Open</ButtonLink></MemoryRouter>);
        const link = screen.getByRole('link', { name: 'Open' });
        expect(link).toHaveAttribute('href', '/my-rooms');
        expect(link.className).toContain('px-2 py-1 text-xs');
        expect(link.className).toContain('no-underline');
    });
});
