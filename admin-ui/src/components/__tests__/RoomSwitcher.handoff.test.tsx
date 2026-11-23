import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../RoomSwitcher';
import type { MemberRoom } from '../../lib/landingRooms';

/**
 * G26 - when the menu chunk arrives while the hand-drawn button has focus,
 * focus moves to base-ui's trigger with it, and nothing opens; after that the
 * trigger is not remounted by later renders. (The chunk is held back until the
 * test lets it through; one release per file.)
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
const room = (roomId: string, name: string, slug: string): MemberRoom =>
    ({ roomId, name, slug, logoUrl: null, lastActivityAt: null, joinedAt: '2026-01-01 12:00:00', source: 'self_join' });

function ui(rooms: MemberRoom[]) {
    return (
        <MemoryRouter>
            <RoomSwitcher current={CURRENT} rooms={rooms} loading={false} signedIn variant="inline" />
        </MemoryRouter>
    );
}

const trigger = () => screen.getByRole('button', { name: 'RTX PINBALL, switch game room' });

describe('RoomSwitcher hand-off from the hand-drawn button', () => {
    it('keeps focus on the button when the chunk arrives, opens nothing, and does not remount it later', async () => {
        const { rerender } = render(ui([room('r1', 'RTX Pinball', 'rtx_pinball')]));
        const early = trigger();
        early.focus();
        fireEvent.focus(early); // starts the (held) download
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(document.activeElement).toBe(early);

        gate.open();
        // Swapped for base-ui's trigger (it carries base-ui's id), with focus moved across.
        await waitFor(() => expect(trigger()).not.toBe(early));
        const real = trigger();
        expect(real).toHaveAttribute('id');
        expect(document.activeElement).toBe(real);
        expect(real).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menu')).toBeNull();

        // New rooms, same trigger element: the lazy menu is not remounted by a render.
        rerender(ui([room('r1', 'RTX Pinball', 'rtx_pinball'), room('r2', 'Flipper Cove', 'flipper_cove')]));
        expect(trigger()).toBe(real);
        expect(document.activeElement).toBe(real);
    });
});
