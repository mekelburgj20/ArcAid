import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../App';

/**
 * G35c - the My Game Rooms page retired (owner 2026-11-26): your rooms and
 * Leave room are on the landing page. `/my-rooms` stays as a redirect, so old
 * links, bookmarks and installed shortcuts land there instead of on a room
 * called "my-rooms" (`lib/routeClass.ts` keeps the slug reserved).
 */

function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
}

describe('/my-rooms (retired in G35c)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve([]) })));
    });

    it('redirects to the landing page, replacing the history entry', async () => {
        render(
            <MemoryRouter initialEntries={['/my-rooms']}>
                <App />
                <Where />
            </MemoryRouter>,
        );
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
        // The landing page is what shows.
        expect(await screen.findByRole('heading', { name: 'Global Scoreboard' })).toBeInTheDocument();
    });

    it('the page itself is gone', () => {
        const src = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'admin-ui/src')].find(existsSync)!;
        expect(existsSync(resolve(src, 'pages/MyRooms.tsx'))).toBe(false);
    });
});
