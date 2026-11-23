import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import ArcaidPage from '../ArcaidPage';
import Panel, { PanelGroup } from '../Panel';

/**
 * G21 - the page shell of the fixed dark Arcaid look (Account Settings, G20).
 * Its normal render is the G20 page's shell class for class, so a page moved
 * onto it renders exactly as before; the kit loads only while it is mounted.
 */

const JUMP = [
    { id: 'group-one', title: 'One', tone: 'cyan' as const },
    { id: 'group-two', title: 'Two', tone: 'red' as const },
];

function renderPage(props: Partial<ComponentProps<typeof ArcaidPage>> = {}) {
    return render(
        <MemoryRouter>
            <ArcaidPage title="Account Settings" {...props}>
                {props.children ?? (
                    <PanelGroup id="group-one" tone="cyan" title="One">
                        <Panel title="A panel" testId="panel">x</Panel>
                    </PanelGroup>
                )}
            </ArcaidPage>
        </MemoryRouter>,
    );
}

const themeLinks = () => Array.from(document.head.querySelectorAll('link[data-aw-theme]')).map(l => l.getAttribute('href'));

describe('ArcaidPage', () => {
    it('renders the G20 shell with a jump list, and loads the kit only while mounted', () => {
        const { container, unmount } = renderPage({ jump: JUMP, overlays: <div data-testid="dialog">dialog</div> });

        const root = container.firstElementChild as HTMLElement;
        expect(root.className).toBe('aw-screen aw-screen--arcaid sb-theme-scope aw-island min-h-screen bg-deep text-primary');
        const layout = root.firstElementChild as HTMLElement;
        expect(layout.className).toBe('aw-layout aw-web aw-web--wide px-4 sm:px-6');
        // (Its safe-area `paddingTop` uses `env()`, which jsdom drops; not testable here.)
        expect(layout.style.minHeight).toBe('');

        // Header, main, footer, in that order, inside the layout.
        const [header, main, footer] = Array.from(layout.children) as HTMLElement[];
        expect(header.className).toBe('aw-header flex-wrap');
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ARCAIDACCOUNT SETTINGS');
        expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
        expect(main).toBe(screen.getByRole('main'));
        expect(main.className).toBe('aw-settings');
        expect(main.firstElementChild!.className).toBe('aw-jump');
        expect(screen.getAllByRole('button', { name: /^(One|Two)$/ }).map(b => b.className))
            .toEqual(['aw-jump__item aw-group--cyan', 'aw-jump__item aw-group--red']);
        const groups = main.children[1] as HTMLElement;
        expect(groups.className).toBe('aw-settings__groups');
        expect(footer.className).toBe('aw-footer');
        expect(screen.getByRole('link', { name: 'ARCAID.APP' }).getAttribute('href')).toBe('/');

        // Parts inside take the Arcaid skin.
        expect(screen.getByTestId('panel').className).toContain('aw-panel');
        expect(groups.firstElementChild!.className).toBe('aw-group aw-group--cyan scroll-mt-6');

        // Overlays come after the layout, still inside the root (the island's tokens).
        expect(root.lastElementChild).toBe(screen.getByTestId('dialog'));

        expect(themeLinks()).toEqual([
            '/aw-theme/aw-theme.css?v=4', '/aw-theme/aw-theme-ext.css?v=4', '/aw-theme/aw-web.css?v=4',
        ]);
        unmount();
        expect(themeLinks()).toEqual([]);
    });

    it('without a jump list the children sit in the kit main column', () => {
        renderPage({ children: <p>content</p> });
        const main = screen.getByRole('main');
        expect(main.className).toBe('aw-web__main');
        expect(main).toHaveTextContent('content');
        expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    });

    it("'column' is the kit's 52rem column (no aw-web--wide)", () => {
        const { container } = renderPage({ width: 'column' });
        expect(container.firstElementChild!.firstElementChild!.className).toBe('aw-layout aw-web px-4 sm:px-6');
    });

    it('takes its own header actions and footer', () => {
        renderPage({ actions: null, footer: <span>custom footer</span> });
        expect(screen.queryByRole('navigation', { name: 'Page' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'ARCAID.APP' })).toBeNull();
        expect(screen.getByText('custom footer').parentElement!.className).toBe('aw-footer');
    });

    it('bare: the carpet, the children centred above it, no header or main', () => {
        const { container } = renderPage({ bare: true, children: <p>Log in</p> });
        const root = container.firstElementChild as HTMLElement;
        // aw-screen--arcaid: Account Settings never shows the Witness picture.
        expect(root.className).toBe('aw-screen aw-screen--arcaid sb-theme-scope aw-island min-h-screen bg-deep text-primary flex items-center justify-center');
        expect(root.children).toHaveLength(1);
        expect(root.firstElementChild!.className).toBe('relative z-[1]');
        expect(root.firstElementChild).toHaveTextContent('Log in');
        expect(screen.queryByRole('main')).toBeNull();
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
        expect(themeLinks()).toHaveLength(3);
    });

    it('embedded: fills its box, keeps the carpet inside it, and adds no second main landmark', () => {
        const { container } = renderPage({ embedded: true, jump: JUMP });
        const root = container.firstElementChild as HTMLElement;
        expect(root.className).toBe('aw-screen aw-screen--arcaid sb-theme-scope aw-island bg-deep text-primary');
        expect(['0', '0px']).toContain(root.style.minHeight);
        expect(root.style.transform).toBe('translateZ(0)');
        expect(root.style.overflow).toBe('hidden');
        const layout = root.firstElementChild as HTMLElement;
        expect(['0', '0px']).toContain(layout.style.minHeight);
        expect(screen.queryByRole('main')).toBeNull();
        expect(layout.querySelector(':scope > div.aw-settings')).toBeTruthy();
    });
});
