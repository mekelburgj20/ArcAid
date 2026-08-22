import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppearanceControl from '../AppearanceControl';
import { ThemeProvider, STORAGE_APPEARANCE_KEY } from '../ThemeProvider';

// v2.130.0 — the 3-way Dark/Light/Auto control mounted in Account settings and
// the public display-settings sheet. Both mounts render THIS component, so the
// coverage here is the contract for both.

function renderControl(initialPath = '/rooma') {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <ThemeProvider>
                <AppearanceControl />
            </ThemeProvider>
        </MemoryRouter>,
    );
}

const hasClass = (cls: string) => document.documentElement.classList.contains(cls);

describe('AppearanceControl', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })) as unknown as typeof fetch);
        localStorage.clear();
        document.documentElement.className = '';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('offers exactly Dark, Light and Auto', () => {
        renderControl();
        const radios = screen.getAllByRole('radio');
        expect(radios.map(r => r.textContent)).toEqual(['Dark', 'Light', 'Auto']);
    });

    it('defaults to Auto when nothing is stored', () => {
        renderControl();
        expect(screen.getByTestId('appearance-auto')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('appearance-light')).toHaveAttribute('aria-checked', 'false');
    });

    it('reflects the stored preference on mount', () => {
        localStorage.setItem(STORAGE_APPEARANCE_KEY, 'light');
        renderControl();
        expect(screen.getByTestId('appearance-light')).toHaveAttribute('aria-checked', 'true');
    });

    it('picking Light applies the light theme and persists the choice', async () => {
        localStorage.setItem('arcaid-theme-public-rooma', 'ocean');
        renderControl();
        await waitFor(() => expect(hasClass('theme-ocean')).toBe(true));

        fireEvent.click(screen.getByTestId('appearance-light'));

        await waitFor(() => expect(hasClass('theme-light')).toBe(true));
        expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('light');
        expect(screen.getByTestId('appearance-light')).toHaveAttribute('aria-checked', 'true');
    });

    it('picking Auto hands the page back to the room theme', async () => {
        // Coffee is the room's LIGHT theme, so appearance=dark genuinely
        // overrides it — with a dark room theme like ocean the override is a
        // no-op and this would assert nothing.
        localStorage.setItem('arcaid-theme-public-rooma', 'coffee');
        localStorage.setItem(STORAGE_APPEARANCE_KEY, 'dark');
        renderControl();
        await waitFor(() => expect(screen.getByTestId('appearance-dark')).toHaveAttribute('aria-checked', 'true'));
        expect(hasClass('theme-coffee')).toBe(false);

        fireEvent.click(screen.getByTestId('appearance-auto'));

        await waitFor(() => expect(hasClass('theme-coffee')).toBe(true));
        expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('auto');
    });

    it('posts the choice to /me/preferences for a signed-in player', async () => {
        localStorage.setItem('arcaid_player_token', 'player.jwt.token');
        const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ui_theme: null, appearance: null }) }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        renderControl();
        fireEvent.click(screen.getByTestId('appearance-dark'));

        await waitFor(() => {
            const post = fetchMock.mock.calls.find(
                ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
            );
            expect(post).toBeTruthy();
            expect(post![0]).toBe('/api/me/preferences');
            expect((post![1] as RequestInit).body).toBe(JSON.stringify({ appearance: 'dark' }));
        });
    });
});
