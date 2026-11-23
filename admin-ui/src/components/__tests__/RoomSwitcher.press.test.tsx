import { StrictMode, useEffect, type ComponentType } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { MemberRoom } from '../../lib/landingRooms';

/**
 * G26 - a press on the hand-drawn button before the menu chunk arrives. It is
 * replayed only while it still means "open the menu"; a second press, focus
 * moving elsewhere, a press elsewhere, a route change, unmounting or 5 seconds
 * forget it. A failed load is retried. Each test gets a fresh RoomSwitcher
 * module and a chunk held back until the test releases it (or fails it).
 */

type Props = {
    current: { slug: string; name: string; title: string; logoUrl: string | null; roomId: string | null };
    rooms: MemberRoom[];
    loading: boolean;
    signedIn: boolean;
    variant: 'inline' | 'brandrow';
};

let release: () => void = () => {};
let failsLeft = 0;
let RoomSwitcher: ComponentType<Props>;

beforeEach(async () => {
    vi.resetModules();
    failsLeft = 0;
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('../RoomSwitcherMenu', async (importOriginal: () => Promise<unknown>) => {
        await ready;
        if (failsLeft > 0) {
            failsLeft -= 1;
            // Safari's wording: no URL, so the retry asks for the same module again.
            throw new Error('Importing a module script failed.');
        }
        return importOriginal();
    });
    RoomSwitcher = (await import('../RoomSwitcher')).default as ComponentType<Props>;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const room = (roomId: string, name: string, slug: string, lastActivityAt: string | null): MemberRoom =>
    ({ roomId, name, slug, logoUrl: null, lastActivityAt, joinedAt: '2026-01-01 12:00:00', source: 'self_join' });
const PROPS: Props = {
    current: { slug: 'rtx_pinball', name: 'RTX Pinball', title: 'RTX PINBALL', logoUrl: null, roomId: 'r1' },
    rooms: [room('r1', 'RTX Pinball', 'rtx_pinball', null), room('r2', 'Flipper Cove', 'flipper_cove', '2026-11-20 10:00:00')],
    loading: false,
    signedIn: true,
    variant: 'inline',
};

/** Navigates the way Back or a link elsewhere would: no press on the page. */
let go: (to: string) => void = () => {};
function Router({ expose }: { expose: (navigate: (to: string) => void) => void }) {
    const navigate = useNavigate();
    useEffect(() => { expose(to => navigate(to)); }, [expose, navigate]);
    return <span data-testid="where">{useLocation().pathname}</span>;
}
const exposeNavigate = (navigate: (to: string) => void) => { go = navigate; };

function page(props: Partial<Props> = {}) {
    return (
        <MemoryRouter initialEntries={['/rtx_pinball']}>
            <RoomSwitcher {...PROPS} {...props} />
            <input aria-label="Elsewhere" />
            <Router expose={exposeNavigate} />
        </MemoryRouter>
    );
}

const trigger = () => screen.getByRole('button', { name: 'RTX PINBALL, switch game room' });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

/** Lets the chunk in and waits until base-ui's trigger (it carries base-ui's id) has replaced the hand-drawn one. */
async function arrive() {
    release();
    await waitFor(() => expect(trigger()).toHaveAttribute('id'));
    await settle();
}

describe('an early press is replayed', () => {
    it('a pointer press opens the menu once the chunk is in, with nothing highlighted (as after a tap)', async () => {
        render(page());
        fireEvent.click(trigger(), { detail: 1 });
        await settle();
        expect(screen.queryByRole('menu')).toBeNull();
        await arrive();
        const menu = await screen.findByRole('menu');
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        expect(menu.querySelector('[data-highlighted]')).toBeNull();
    });

    it('under StrictMode a keyboard press opens it once, on the first room you are not in', async () => {
        render(<StrictMode>{page()}</StrictMode>);
        trigger().focus();
        fireEvent.click(trigger()); // Enter / Space: a click with detail 0
        await arrive();
        const menu = await screen.findByRole('menu');
        const rows = within(within(menu).getByRole('group')).getAllByRole('menuitem');
        await waitFor(() => expect(document.activeElement).toBe(rows[1]));
        await settle();
        expect(screen.getByRole('menu')).toBeInTheDocument();
    });
});

describe('a press that no longer means "open" is dropped', () => {
    it('a second press: nothing opens, focus stays on the button', async () => {
        render(page());
        trigger().focus();
        fireEvent.click(trigger());
        fireEvent.click(trigger());
        await arrive();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger());
    });

    it('focus moving to something else: nothing opens, focus stays there', async () => {
        render(page());
        trigger().focus();
        fireEvent.click(trigger());
        const input = screen.getByLabelText('Elsewhere');
        input.focus();
        await arrive();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(input);
    });

    it('a press anywhere else: nothing opens, focus is not moved', async () => {
        render(page());
        fireEvent.click(trigger(), { detail: 1 });
        fireEvent.pointerDown(screen.getByTestId('where'));
        await arrive();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });

    it('a route change: nothing opens over the new page', async () => {
        render(page());
        trigger().focus();
        fireEvent.click(trigger());
        act(() => go('/rtx_pinball/lobby'));
        await arrive();
        expect(screen.getByTestId('where')).toHaveTextContent('/rtx_pinball/lobby');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('5 seconds passing: nothing opens', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        render(page());
        fireEvent.click(trigger(), { detail: 1 });
        act(() => { vi.advanceTimersByTime(5001); });
        vi.useRealTimers();
        await arrive();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });

    it('unmounting: the chunk arriving later does nothing (and navigates nowhere)', async () => {
        const { unmount } = render(page());
        fireEvent.click(trigger());
        unmount();
        release();
        await settle();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });
});

describe('a failed load', () => {
    it('after the viewer has gone elsewhere, the failure navigates nowhere', async () => {
        failsLeft = 99;
        render(page());
        fireEvent.click(trigger());
        act(() => go('/rtx_pinball/stats'));
        release();
        await settle();
        expect(screen.getByTestId('where')).toHaveTextContent('/rtx_pinball/stats');
    });

    it('is retried on the next hover, and the menu then works', async () => {
        failsLeft = 1;
        render(page());
        fireEvent.pointerEnter(trigger());
        release();
        await waitFor(() => expect(trigger()).not.toHaveAttribute('aria-haspopup'));

        fireEvent.pointerEnter(trigger()); // the retry
        await waitFor(() => expect(trigger()).toHaveAttribute('id'));
        expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
        fireEvent.click(trigger());
        expect(await screen.findByRole('menu')).toBeInTheDocument();
        expect(screen.getByTestId('where')).toHaveTextContent('/rtx_pinball');
    });

    it('is retried on a route change', async () => {
        failsLeft = 1;
        render(page());
        fireEvent.pointerEnter(trigger());
        release();
        await waitFor(() => expect(trigger()).not.toHaveAttribute('aria-haspopup'));

        act(() => go('/rtx_pinball/lobby'));
        await waitFor(() => expect(trigger()).toHaveAttribute('id'));
    });
});

describe('the open menu', () => {
    it('closes on a route change it did not cause (Back, a link elsewhere)', async () => {
        render(page());
        fireEvent.pointerEnter(trigger());
        await arrive();
        fireEvent.click(trigger());
        await screen.findByRole('menu');
        act(() => go('/rtx_pinball/lobby'));
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('closes when the screen crosses the sm breakpoint (its trigger is hidden there)', async () => {
        const listeners = new Set<() => void>();
        vi.stubGlobal('matchMedia', () => ({
            matches: true,
            addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
            removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
        }));
        render(page());
        fireEvent.pointerEnter(trigger());
        await arrive();
        fireEvent.click(trigger());
        await screen.findByRole('menu');
        expect(listeners.size).toBeGreaterThan(0);
        act(() => listeners.forEach(fn => fn()));
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });
});
