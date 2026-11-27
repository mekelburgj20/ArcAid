import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../RoomSwitcher';

/**
 * G26 - when the menu chunk cannot load (offline, a stale deploy), the nav
 * still works: the hand-drawn button stays and takes the viewer to the room
 * list, the landing page (where your rooms are too since G35c retired My
 * Rooms). Nothing reloads the page.
 */

vi.mock('../RoomSwitcherMenu', () => {
    throw new Error('Failed to fetch dynamically imported module: /assets/RoomSwitcherMenu.js');
});

const CURRENT: SwitcherCurrentRoom = { slug: 'rtx_pinball', name: 'RTX Pinball', title: 'RTX PINBALL', logoUrl: null, roomId: 'r1' };

function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderSwitcher(signedIn: boolean) {
    return render(
        <MemoryRouter initialEntries={['/rtx_pinball']}>
            <RoomSwitcher current={CURRENT} rooms={[]} loading={false} signedIn={signedIn} variant="inline" />
            <Where />
        </MemoryRouter>,
    );
}

const trigger = () => screen.getByRole('button', { name: 'RTX PINBALL, switch game room' });

describe('RoomSwitcher when its menu chunk fails to load', () => {
    it('signed in: a press made while it was loading goes to the room list, where your rooms are', async () => {
        renderSwitcher(true);
        fireEvent.click(trigger());
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
        // While the menu cannot load, the button does not claim a pop-up.
        expect(trigger()).not.toHaveAttribute('aria-haspopup');
        expect(trigger()).not.toHaveAttribute('aria-expanded');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('signed out: after the failure the button stays, and a press (which retries first) goes to the room list', async () => {
        renderSwitcher(false);
        fireEvent.pointerEnter(trigger()); // the download starts, and fails
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(trigger()).not.toHaveAttribute('aria-haspopup');
        expect(screen.getByTestId('where')).toHaveTextContent('/rtx_pinball');

        fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
        expect(screen.queryByRole('menu')).toBeNull();
    });
});
