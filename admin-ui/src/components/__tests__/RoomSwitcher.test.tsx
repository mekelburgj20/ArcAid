import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../RoomSwitcher';
import type { MemberRoom } from '../../lib/landingRooms';

/**
 * G26 - the room switcher: the room name in the nav opens the Arcaid menu of
 * the viewer's rooms (base-ui Menu underneath; the popup is portalled to
 * document.body). The menu is a lazy chunk, so every open is awaited
 * (`findByRole('menu')`); a press on the hand-drawn button before it arrives
 * is replayed (RoomSwitcher.lazy / .handoff / .fallback tests).
 */

const CURRENT: SwitcherCurrentRoom = { slug: 'rtx_pinball', name: 'RTX Pinball', title: 'RTX PINBALL', logoUrl: null, roomId: 'r1' };

function room(roomId: string, name: string, slug: string, lastActivityAt: string | null, logoUrl: string | null = null): MemberRoom {
    return { roomId, name, slug, logoUrl, lastActivityAt, joinedAt: '2026-01-01 12:00:00', source: 'self_join' };
}

const ROOMS: MemberRoom[] = [
    room('r1', 'RTX Pinball', 'rtx_pinball', '2026-11-01 10:00:00'),
    room('r4', 'Tilt Club After Dark', 'tilt_club', null),
    room('r2', 'Flipper Cove', 'flipper_cove', '2026-11-18 10:00:00', '/logo-cove.png'),
    room('r5', 'Arcade Annex', 'arcade_annex', null),
    room('r3', 'Neon Alley Pinball', 'neon_alley_pinball', '2026-11-20T10:00:00Z'),
];

function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderSwitcher(props: Partial<Parameters<typeof RoomSwitcher>[0]> = {}) {
    return render(
        <MemoryRouter initialEntries={['/rtx_pinball']}>
            <RoomSwitcher current={CURRENT} rooms={ROOMS} loading={false} signedIn variant="inline" {...props} />
            <Where />
        </MemoryRouter>,
    );
}

const trigger = () => screen.getByRole('button', { name: 'RTX PINBALL, switch game room' });

async function openMenu() {
    fireEvent.click(trigger());
    return screen.findByRole('menu');
}

/** The rows of the room list, in order (the current room is a disabled item, the rest are links). */
function roomRows(menu: HTMLElement) {
    return within(within(menu).getByRole('group')).getAllByRole('menuitem');
}

describe('RoomSwitcher', () => {
    it('names the room with its title on a closed button', () => {
        renderSwitcher();
        const button = trigger();
        expect(button).toHaveTextContent('RTX PINBALL');
        expect(button).toHaveAttribute('title', 'RTX PINBALL');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menu')).toBeNull();
        // No logo: an initials tile.
        expect(button).toHaveTextContent('RP');
    });

    it('lists the current room first, then the others by last activity (none last), then by name', async () => {
        renderSwitcher();
        const menu = await openMenu();
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        expect(within(menu).getByRole('group', { name: /Your game rooms/ })).toBeInTheDocument();
        expect(within(menu).getByText('5', { selector: '.arc-menu__count' })).toBeInTheDocument();

        const rows = roomRows(menu);
        expect(rows.map(r => r.querySelector('.arc-menu__name')!.textContent)).toEqual([
            'RTX Pinball', 'Neon Alley Pinball', 'Flipper Cove', 'Arcade Annex', 'Tilt Club After Dark',
        ]);

        const here = rows[0]!;
        expect(here.tagName).not.toBe('A');
        expect(here).toHaveAttribute('aria-current', 'page');
        expect(here).toHaveAttribute('aria-disabled', 'true');
        expect(here).toHaveTextContent('You are here');
        expect(here.querySelector('.arc-menu__mark')).not.toBeNull();

        expect(rows[1]).toHaveAttribute('href', '/neon_alley_pinball');
        expect(rows[2]).toHaveAttribute('href', '/flipper_cove');
        expect(rows[2]!.querySelector('img')).toHaveAttribute('src', '/logo-cove.png');
        expect(rows[4]).toHaveTextContent('TC');

        expect(within(menu).getByRole('menuitem', { name: /All game rooms/ })).toHaveAttribute('href', '/');
        expect(within(menu).getByRole('menuitem', { name: /Manage my rooms/ })).toHaveAttribute('href', '/my-rooms');
    });

    it('picking a room navigates in the app and closes the menu', async () => {
        renderSwitcher();
        const menu = await openMenu();
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Flipper Cove' }));
        expect(screen.getByTestId('where')).toHaveTextContent('/flipper_cove');
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('signed out: the current room, a line to sign in, and only "All game rooms"', async () => {
        renderSwitcher({ signedIn: false, rooms: [] });
        const menu = await openMenu();
        expect(within(menu).getByRole('group', { name: 'Game rooms' })).toBeInTheDocument();
        expect(menu.querySelector('.arc-menu__count')).toBeNull();
        expect(roomRows(menu)).toHaveLength(1);
        expect(within(menu).getByText('Sign in to see your rooms')).toBeInTheDocument();
        expect(within(menu).getByRole('menuitem', { name: /All game rooms/ })).toHaveAttribute('href', '/');
        expect(within(menu).queryByRole('menuitem', { name: /Manage my rooms/ })).toBeNull();
    });

    it('signed in with only this room: says so, offers more rooms and Manage my rooms', async () => {
        renderSwitcher({ rooms: [ROOMS[0]!] });
        const menu = await openMenu();
        expect(within(menu).getByText('1', { selector: '.arc-menu__count' })).toBeInTheDocument();
        expect(roomRows(menu)).toHaveLength(1);
        const note = within(menu).getByText('This is your only room so far.');
        const more = within(menu).getByRole('menuitem', { name: /Find more rooms/ });
        expect(more).toHaveAttribute('href', '/');
        expect(more).toHaveAttribute('aria-describedby', note.id);
        expect(within(menu).getByRole('menuitem', { name: /Manage my rooms/ })).toHaveAttribute('href', '/my-rooms');
    });

    it('a visitor (this room is not one of theirs) still sees it first, then their rooms', async () => {
        renderSwitcher({ rooms: [ROOMS[2]!, ROOMS[4]!] });
        const menu = await openMenu();
        expect(within(menu).getByText('2', { selector: '.arc-menu__count' })).toBeInTheDocument();
        const rows = roomRows(menu);
        expect(rows.map(r => r.querySelector('.arc-menu__name')!.textContent)).toEqual(['RTX Pinball', 'Neon Alley Pinball', 'Flipper Cove']);
        expect(rows[0]).toHaveAttribute('aria-current', 'page');
        expect(rows[0]).toHaveTextContent('You are here');
    });

    it('while the rooms load: the current room and one placeholder row', async () => {
        renderSwitcher({ loading: true, rooms: [] });
        const menu = await openMenu();
        expect(roomRows(menu)).toHaveLength(1);
        expect(within(menu).getByText('Loading your rooms')).toBeInTheDocument();
        expect(menu.querySelector('.arc-menu__count')).toBeNull();
        expect(within(menu).queryByText('This is your only room so far.')).toBeNull();
    });

    it('keyboard: opens on the first other room, arrows and typeahead move the highlight, the pinball rides with it, Escape returns focus', async () => {
        renderSwitcher();
        trigger().focus();
        fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
        const menu = await screen.findByRole('menu');
        const ball = menu.querySelector('.arc-menu__ball')!;
        const rows = roomRows(menu);

        // The room you are in is not a choice, so the highlight starts on the next row.
        await waitFor(() => expect(document.activeElement).toBe(rows[1]));
        expect(rows[1]).toHaveAttribute('data-highlighted');
        expect(ball).toHaveAttribute('data-on');

        // ...but it is still reachable, so a screen reader hears "You are here".
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
        await waitFor(() => expect(document.activeElement).toBe(rows[0]));
        expect(rows[0]).toHaveAttribute('data-highlighted');
        expect(rows[1]).not.toHaveAttribute('data-highlighted');
        expect(ball).toHaveAttribute('data-on');

        fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
        await waitFor(() => expect(document.activeElement).toBe(rows[1]));

        fireEvent.keyDown(document.activeElement!, { key: 't' });
        await waitFor(() => expect(document.activeElement).toBe(rows[4]));
        expect(rows[4]).toHaveTextContent('Tilt Club After Dark');

        fireEvent.keyDown(document.activeElement!, { key: 'End' });
        const manage = within(menu).getByRole('menuitem', { name: /Manage my rooms/ });
        await waitFor(() => expect(manage).toHaveAttribute('data-highlighted'));
        // A footer link is not on the rail: the pinball steps off.
        expect(ball).not.toHaveAttribute('data-on');

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
        await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });
});
