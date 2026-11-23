import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../RoomSwitcher';
import type { MemberRoom } from '../../lib/landingRooms';

/**
 * G26 - the switcher's menu is a lazy chunk. Here the chunk is held back
 * until the test lets it through, to see the hand-drawn button that stands in
 * for it and a press that arrives first. (One release per file: the import
 * resolves once per module instance.)
 */

const gate = vi.hoisted(() => {
    let open = () => {};
    const ready = new Promise<void>(resolve => { open = resolve; });
    return { ready, open: () => open() };
});

vi.mock('../RoomSwitcherMenu', async importOriginal => {
    await gate.ready;
    return importOriginal<typeof import('../RoomSwitcherMenu')>();
});

const CURRENT: SwitcherCurrentRoom = { slug: 'rtx_pinball', name: 'RTX Pinball', title: 'RTX PINBALL', logoUrl: null, roomId: 'r1' };
const room = (roomId: string, name: string, slug: string, lastActivityAt: string | null): MemberRoom =>
    ({ roomId, name, slug, logoUrl: null, lastActivityAt, joinedAt: '2026-01-01 12:00:00', source: 'self_join' });
const ROOMS = [room('r1', 'RTX Pinball', 'rtx_pinball', null), room('r2', 'Flipper Cove', 'flipper_cove', '2026-11-20 10:00:00')];

function renderSwitcher() {
    return render(
        <MemoryRouter>
            <RoomSwitcher current={CURRENT} rooms={ROOMS} loading={false} signedIn variant="inline" />
        </MemoryRouter>,
    );
}

const trigger = () => screen.getByRole('button', { name: 'RTX PINBALL, switch game room' });

/** Lets pending promises and React work settle. */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

describe('RoomSwitcher before its menu chunk arrives', () => {
    it('is the same button by hand: name, title, classes and the ARIA of a closed menu trigger', async () => {
        const { unmount } = renderSwitcher();
        fireEvent.pointerEnter(trigger()); // starts the (held) download
        await settle();
        const button = trigger();
        expect(button.tagName).toBe('BUTTON');
        expect(button).toHaveAttribute('type', 'button');
        expect(button).toHaveAttribute('aria-haspopup', 'menu');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(button).toHaveAttribute('title', 'RTX PINBALL');
        expect(button.className).toBe('room-switch room-switch--inline');
        expect(button).toHaveTextContent('RTX PINBALL');
        expect(screen.queryByRole('menu')).toBeNull();
        unmount();
    });

    it('a press that comes first opens the menu once the chunk is in, once, as base-ui opens it', async () => {
        renderSwitcher();
        const early = trigger();
        early.focus();
        fireEvent.click(early); // Enter / Space reach a button as a click with detail 0
        await settle();
        expect(screen.queryByRole('menu')).toBeNull();

        gate.open();
        const menu = await screen.findByRole('menu');
        // base-ui's own trigger now, not the hand-drawn one.
        expect(trigger()).not.toBe(early);
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        // A keyboard press: the highlight starts on the first room you are not in.
        const rows = within(within(menu).getByRole('group')).getAllByRole('menuitem');
        await waitFor(() => expect(document.activeElement).toBe(rows[1]));
        // Replayed once: still open a moment later (a second replay would have closed it).
        await settle();
        expect(screen.getByRole('menu')).toBeInTheDocument();
    });
});
