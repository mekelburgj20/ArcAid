import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StyleGuide from '../StyleGuide';
import { THEME_IDS } from '../../lib/themeIds';
import { THEMES } from '../../components/ThemeProvider';

function renderPage() {
    return render(
        <MemoryRouter>
            <StyleGuide />
        </MemoryRouter>,
    );
}

describe('StyleGuide', () => {
    it('renders its five groups', () => {
        renderPage();
        for (const title of ['The two looks', 'Arcaid look', "Room's theme", 'Page widths', 'Rules']) {
            expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
        }
    });

    it('shows one tile per theme, each in its own theme scope', () => {
        renderPage();
        const tiles = screen.getAllByTestId('theme-tile');
        expect(tiles).toHaveLength(THEME_IDS.length);
        tiles.forEach((tile, i) => {
            const id = THEME_IDS[i]!;
            expect(tile.getAttribute('data-theme')).toBe(id);
            expect(tile.classList.contains('sb-theme-scope')).toBe(true);
            if (id !== 'dark') expect(tile.classList.contains(`theme-${id}`)).toBe(true);
        });
    });

    it('switches the themed preview when a theme button is pressed', () => {
        renderPage();
        const preview = screen.getByTestId('theme-preview');
        expect(preview.getAttribute('data-theme')).toBe(THEME_IDS[0]);
        const target = THEME_IDS[3]!;
        const button = screen.getByRole('button', { name: THEMES[target].label, pressed: false });
        fireEvent.click(button);
        expect(screen.getByTestId('theme-preview').getAttribute('data-theme')).toBe(target);
        expect(screen.getByTestId('theme-preview').classList.contains(`theme-${target}`)).toBe(true);
        expect(screen.getByRole('button', { name: THEMES[target].label })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: THEMES[THEME_IDS[0]!].label })).toHaveAttribute('aria-pressed', 'false');
    });

    it('draws the Arcaid preview in the kit skin and the themed preview in the theme skin', () => {
        renderPage();
        const arcaid = screen.getByTestId('arcaid-preview');
        expect(arcaid.querySelectorAll('.aw-panel').length).toBeGreaterThan(0);
        expect(arcaid.querySelectorAll('.part-panel')).toHaveLength(0);
        const themed = screen.getByTestId('theme-preview');
        expect(themed.querySelectorAll('.part-panel').length).toBeGreaterThan(0);
        expect(themed.querySelectorAll('.aw-panel')).toHaveLength(0);
        expect(within(themed).getByRole('heading', { level: 1, name: 'Weekly Rotation' })).toBeInTheDocument();
    });

    it('loads the kit stylesheets while mounted and removes them on unmount', () => {
        const { unmount } = renderPage();
        expect(document.head.querySelectorAll('link[data-aw-theme]').length).toBeGreaterThan(0);
        unmount();
        expect(document.head.querySelectorAll('link[data-aw-theme]')).toHaveLength(0);
    });
});
