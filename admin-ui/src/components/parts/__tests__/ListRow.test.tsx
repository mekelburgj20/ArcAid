import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ListRows, ListRow } from '../ListRow';
import Button from '../Button';

describe('ListRow (G23)', () => {
    it('a list of listitems, the name a router link, a long name whole', () => {
        const long = 'The Saturday Night Silverball Society of Greater Springfield';
        render(
            <MemoryRouter>
                <ListRows label="Rooms">
                    <ListRow tile="NA" name="Neon Alley" caption="Member" href="/neon" />
                    <ListRow tile="LN" name={long} href="/long" />
                </ListRows>
            </MemoryRouter>,
        );
        expect(screen.getByRole('list', { name: 'Rooms' })).toBeInTheDocument();
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
        expect(screen.getByRole('link', { name: 'Neon Alley' })).toHaveAttribute('href', '/neon');
        expect(screen.getByRole('link', { name: long })).toHaveTextContent(long);
        expect(screen.getByText('Member')).toBeInTheDocument();
    });

    it('trailing stays clickable beside the row link; onClick makes a button', () => {
        const leave = vi.fn();
        const open = vi.fn();
        render(
            <MemoryRouter>
                <ListRow tile="NA" name="Neon Alley" href="/neon" trailing={<Button size="xs" onClick={leave}>Leave</Button>} />
                <ListRow tile="TC" name="Tilt Club" onClick={open} />
            </MemoryRouter>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
        expect(leave).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Tilt Club' }));
        expect(open).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Leave' }).closest('.part-row__end')).not.toBeNull();
    });

    it('a row with no target is plain text', () => {
        render(<ListRow tile="X" name="Plain" />);
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('a control in below stays clickable on a row with a link', () => {
        const pick = vi.fn();
        render(
            <MemoryRouter>
                <ListRows testId="rows">
                    <ListRow testId="row-1" tile="X" name="Table" href="/t" below={<button type="button" aria-pressed="false" onClick={pick}>VPX</button>} />
                </ListRows>
            </MemoryRouter>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'VPX' }));
        expect(pick).toHaveBeenCalled();
        expect(screen.getByTestId('row-1').querySelector('.part-row__below')).not.toBeNull();
        expect(screen.getByTestId('rows')).toBeInTheDocument();
    });
});
