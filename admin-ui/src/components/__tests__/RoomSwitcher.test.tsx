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

async function openMenu(button: HTMLElement = trigger()) {
    // Have the menu's chunk in hand first: the switcher forgets a press whose chunk takes more than five
    // seconds to arrive, and a loaded build server can take that long to transform it.
    await import('../RoomSwitcherMenu');
    fireEvent.click(button);
    return screen.findByRole('menu');
}

/** The rows of the room list, in order (the current place is a disabled item, the rest are links). */
function roomRows(menu: HTMLElement) {
    return within(within(menu).getByRole('group')).getAllByRole('menuitem');
}

const rowNames = (menu: HTMLElement) => roomRows(menu).map(r => r.querySelector('.arc-menu__name')!.textContent);

/** The Global Scoreboard as the current place (its own header). */
const GLOBAL: SwitcherCurrentRoom = { kind: 'global', slug: '', name: 'Global Scoreboard', title: 'Global Scoreboard', logoUrl: null, roomId: null };

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

    it('lists the current room first, then the others by last activity (none last), then by name, then Global', async () => {
        renderSwitcher();
        const menu = await openMenu();
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        expect(within(menu).getByRole('group', { name: /Your game rooms/ })).toBeInTheDocument();
        // Five rooms: the Global row is a place, not one of your rooms.
        expect(within(menu).getByText('5', { selector: '.arc-menu__count' })).toBeInTheDocument();

        const rows = roomRows(menu);
        expect(rowNames(menu)).toEqual([
            'RTX Pinball', 'Neon Alley Pinball', 'Flipper Cove', 'Arcade Annex', 'Tilt Club After Dark', 'Global Scoreboard',
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

        // Global: a link to the Global Scoreboard, its tile the trophy (no initials, no logo).
        const global = rows[5]!;
        expect(global).toHaveAttribute('href', '/scoreboard');
        expect(global).not.toHaveAttribute('aria-current');
        expect(global.querySelector('.arc-menu__tile--icon svg')).not.toBeNull();
        expect(global.querySelector('.arc-menu__tile--init')).toBeNull();

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

    it('picking Global goes to the Global Scoreboard', async () => {
        renderSwitcher();
        const menu = await openMenu();
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Global Scoreboard' }));
        expect(screen.getByTestId('where')).toHaveTextContent('/scoreboard');
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('signed out: the current room and Global, a line to sign in, and only "All game rooms"', async () => {
        renderSwitcher({ signedIn: false, rooms: [] });
        const menu = await openMenu();
        expect(within(menu).getByRole('group', { name: 'Game rooms' })).toBeInTheDocument();
        expect(menu.querySelector('.arc-menu__count')).toBeNull();
        // The Global Scoreboard is public: its row is there for a signed-out viewer too.
        expect(rowNames(menu)).toEqual(['RTX Pinball', 'Global Scoreboard']);
        expect(within(menu).getByRole('menuitem', { name: 'Global Scoreboard' })).toHaveAttribute('href', '/scoreboard');
        expect(within(menu).getByText('Sign in to see your rooms')).toBeInTheDocument();
        expect(within(menu).getByRole('menuitem', { name: /All game rooms/ })).toHaveAttribute('href', '/');
        expect(within(menu).queryByRole('menuitem', { name: /Manage my rooms/ })).toBeNull();
    });

    it('signed in with only this room: says so, offers more rooms and Manage my rooms', async () => {
        renderSwitcher({ rooms: [ROOMS[0]!] });
        const menu = await openMenu();
        expect(within(menu).getByText('1', { selector: '.arc-menu__count' })).toBeInTheDocument();
        expect(rowNames(menu)).toEqual(['RTX Pinball', 'Global Scoreboard']);
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
        expect(rowNames(menu)).toEqual(['RTX Pinball', 'Neon Alley Pinball', 'Flipper Cove', 'Global Scoreboard']);
        expect(rows[0]).toHaveAttribute('aria-current', 'page');
        expect(rows[0]).toHaveTextContent('You are here');
    });

    it('while the rooms load: the current room, one placeholder row, and Global', async () => {
        renderSwitcher({ loading: true, rooms: [] });
        const menu = await openMenu();
        expect(rowNames(menu)).toEqual(['RTX Pinball', 'Global Scoreboard']);
        expect(within(menu).getByText('Loading your rooms')).toBeInTheDocument();
        expect(menu.querySelector('.arc-menu__count')).toBeNull();
        expect(within(menu).queryByText('This is your only room so far.')).toBeNull();
    });

    it('keyboard: opens on the first other room, arrows and typeahead move the highlight, the pinball rides with it, Escape returns focus', async () => {
        renderSwitcher();
        await import('../RoomSwitcherMenu'); // the chunk in hand before the press (see openMenu)
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

describe('RoomSwitcher with Global as the current place (the Global Scoreboard header)', () => {
    const globalTrigger = () => screen.getByRole('button', { name: 'Global Scoreboard, switch game room' });

    it('names Global on the button, with the trophy tile and its name never capped', () => {
        renderSwitcher({ current: GLOBAL });
        const button = globalTrigger();
        expect(button).toHaveTextContent('Global Scoreboard');
        expect(button).toHaveAttribute('title', 'Global Scoreboard');
        expect(button.className).toBe('room-switch room-switch--inline room-switch--global');
        expect(button.querySelector('.room-switch__tile--icon svg')).not.toBeNull();
        expect(button.querySelector('.room-switch__tile--init')).toBeNull();
    });

    it('lists Global first as "You are here", then every room (none taken for the current one), no second Global row', async () => {
        renderSwitcher({ current: GLOBAL });
        const menu = await openMenu(globalTrigger());
        // Every room is listed and counted: an empty slug and no room id never match a room.
        expect(within(menu).getByText('5', { selector: '.arc-menu__count' })).toBeInTheDocument();
        expect(rowNames(menu)).toEqual([
            'Global Scoreboard', 'Neon Alley Pinball', 'Flipper Cove', 'RTX Pinball', 'Arcade Annex', 'Tilt Club After Dark',
        ]);

        const here = roomRows(menu)[0]!;
        expect(here.tagName).not.toBe('A');
        expect(here).toHaveAttribute('aria-current', 'page');
        expect(here).toHaveAttribute('aria-disabled', 'true');
        expect(here).toHaveTextContent('You are here');
        expect(here.querySelector('.arc-menu__mark')).not.toBeNull();
        expect(here.querySelector('.arc-menu__tile--icon svg')).not.toBeNull();
        expect(within(menu).queryAllByRole('menuitem', { name: /Global Scoreboard/ })).toHaveLength(1);
        expect(menu.querySelector('a[href="/scoreboard"]')).toBeNull();

        expect(roomRows(menu)[3]).toHaveAttribute('href', '/rtx_pinball');
        expect(within(menu).getByRole('menuitem', { name: /All game rooms/ })).toHaveAttribute('href', '/');
        expect(within(menu).getByRole('menuitem', { name: /Manage my rooms/ })).toHaveAttribute('href', '/my-rooms');
    });

    it('with no rooms yet: says so, offers more rooms and Manage my rooms', async () => {
        renderSwitcher({ current: GLOBAL, rooms: [] });
        const menu = await openMenu(globalTrigger());
        expect(within(menu).getByText('0', { selector: '.arc-menu__count' })).toBeInTheDocument();
        expect(rowNames(menu)).toEqual(['Global Scoreboard']);
        const note = within(menu).getByText('You have not joined a game room yet.');
        expect(within(menu).getByRole('menuitem', { name: /Find more rooms/ })).toHaveAttribute('aria-describedby', note.id);
        expect(within(menu).getByRole('menuitem', { name: /Manage my rooms/ })).toHaveAttribute('href', '/my-rooms');
    });
});
