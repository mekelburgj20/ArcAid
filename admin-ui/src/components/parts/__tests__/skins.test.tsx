import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import Panel, { PanelGroup } from '../Panel';
import JumpList from '../JumpList';
import PageTitle, { PageNavLinks } from '../PageTitle';
import { PartSkinContext } from '../skin';

/**
 * G21 - every shared part has two skins: the Witness kit's `.aw-*` classes
 * inside `ArcaidPage` (the Arcaid look, Account Settings), and the `part-*`
 * classes everywhere else (themed pages; src/index.css). The default is the
 * theme skin, so a part dropped on a room page never asks for the kit.
 */

function arcaid(ui: ReactNode) {
    return render(<PartSkinContext.Provider value="arcaid">{ui}</PartSkinContext.Provider>);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Panel', () => {
    it('is the kit panel and label under the arcaid skin', () => {
        arcaid(<Panel title="Profile" id="p1" testId="panel" wide className="extra">body</Panel>);
        const panel = screen.getByTestId('panel');
        expect(panel.tagName).toBe('SECTION');
        expect(panel.id).toBe('p1');
        expect(panel.className).toBe('aw-panel min-w-0 scroll-mt-4 lg:col-span-2 extra');
        expect(screen.getByRole('heading', { level: 3, name: 'Profile' }).className).toBe('aw-label flex items-center gap-2');
        expect(panel).toHaveTextContent('body');
    });

    it('is the part panel and label under the default (theme) skin', () => {
        render(<Panel title="Profile" testId="panel">body</Panel>);
        const panel = screen.getByTestId('panel');
        expect(panel.className).toBe('part-panel min-w-0 scroll-mt-4');
        expect(panel.className).not.toContain('aw-');
        expect(screen.getByRole('heading', { level: 3, name: 'Profile' }).className).toBe('part-label flex items-center gap-2');
    });

    it('spans the row only when wide, and forwards its ref', () => {
        const ref = { current: null as HTMLElement | null };
        render(<><Panel title="A" testId="a" panelRef={ref}>x</Panel><Panel title="B" testId="b" wide>y</Panel></>);
        expect(screen.getByTestId('a').className).not.toContain('lg:col-span-2');
        expect(screen.getByTestId('b').className).toContain('lg:col-span-2');
        expect(ref.current).toBe(screen.getByTestId('a'));
    });
});

describe('PanelGroup', () => {
    it('is the kit group in its tone under the arcaid skin', () => {
        arcaid(<PanelGroup id="g1" tone="violet" title="Devices" sub="The machines.">kids</PanelGroup>);
        const group = screen.getByRole('region', { name: 'Devices' });
        expect(group.id).toBe('g1');
        expect(group.className).toBe('aw-group aw-group--violet scroll-mt-6');
        expect(screen.getByRole('heading', { level: 2, name: 'Devices' }).className).toBe('aw-group__title');
        expect(screen.getByText('The machines.').className).toBe('aw-group__sub');
        expect(group.querySelector(':scope > div')!.className).toBe('grid gap-5 lg:grid-cols-2');
    });

    it('is the part group in its tone under the default skin', () => {
        render(<PanelGroup id="g2" tone="pink" title="Scores" sub="Where they go.">kids</PanelGroup>);
        const group = screen.getByRole('region', { name: 'Scores' });
        expect(group.className).toBe('part-group part-tone--pink scroll-mt-6');
        expect(screen.getByRole('heading', { level: 2, name: 'Scores' }).className).toBe('part-group__title');
        expect(screen.getByText('Where they go.').className).toBe('part-group__sub');
    });

    it('draws no sub line when there is none', () => {
        render(<PanelGroup id="g3" tone="red" title="Danger zone">kids</PanelGroup>);
        const group = screen.getByRole('region', { name: 'Danger zone' });
        expect(group.className).toContain('part-tone--red');
        expect(group.querySelector('p')).toBeNull();
    });
});

describe('JumpList', () => {
    const items = [
        { id: 'group-a', title: 'Personal', tone: 'cyan' as const },
        { id: 'group-b', title: 'Danger zone', tone: 'red' as const },
    ];

    it('is the kit chip list under the arcaid skin', () => {
        arcaid(<JumpList items={items} />);
        const nav = screen.getByRole('navigation', { name: 'Sections' });
        expect(nav.className).toBe('aw-jump');
        expect(screen.getByRole('button', { name: 'Danger zone' }).className).toBe('aw-jump__item aw-group--red');
    });

    it('is the part chip list under the default skin, with its own label', () => {
        render(<JumpList items={items} label="On this page" />);
        expect(screen.getByRole('navigation', { name: 'On this page' }).className).toBe('part-jump');
        const chip = screen.getByRole('button', { name: 'Personal' });
        expect(chip.className).toBe('part-jump__item part-tone--cyan');
        expect(chip.getAttribute('type')).toBe('button');
    });

    it('scrolls the group into view, smoothly unless motion is reduced', () => {
        render(<><JumpList items={items} /><section id="group-b">target</section></>);
        const target = document.getElementById('group-b')!;
        const scroll = vi.fn();
        target.scrollIntoView = scroll;

        fireEvent.click(screen.getByRole('button', { name: 'Danger zone' }));
        expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });

        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
        fireEvent.click(screen.getByRole('button', { name: 'Danger zone' }));
        expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'auto' });
    });
});

describe('PageTitle', () => {
    it('is the Arcaid header under the arcaid skin (the page name in capitals, no sub line)', () => {
        const { container } = arcaid(<PageTitle title="Account Settings" sub="Not shown" actions={<a href="/x">X</a>} />);
        const header = container.querySelector('header')!;
        expect(header.className).toBe('aw-header flex-wrap');
        const logo = header.querySelector('img')!;
        expect(logo.className).toBe('aw-header__logo');
        expect(logo.getAttribute('src')).toBe('/arcaid-logo-v2.png');
        const h1 = screen.getByRole('heading', { level: 1 });
        expect(h1.className).toBe('aw-brand m-0');
        expect(h1.querySelector('.aw-brand__sub')).toHaveTextContent('ACCOUNT SETTINGS');
        expect(screen.queryByText('Not shown')).toBeNull();
        expect(screen.getByRole('navigation', { name: 'Page' }).className).toBe('ml-auto flex items-center gap-5');
    });

    it('is the part title under the default skin', () => {
        const { container } = render(<PageTitle title="Room settings" sub="Who can join." actions={<a href="/x">X</a>} />);
        expect(container.querySelector('header')!.className).toBe('part-title');
        expect(screen.getByRole('heading', { level: 1, name: 'Room settings' }).className).toBe('part-title__h');
        expect(screen.getByText('Who can join.').className).toBe('part-title__sub');
        expect(screen.getByRole('link', { name: 'X' }).parentElement!.className).toBe('part-title__actions');
    });

    it('draws no actions slot when there are none', () => {
        arcaid(<PageTitle title="A" />);
        expect(screen.queryByRole('navigation')).toBeNull();
    });

    it('PageNavLinks: Back steps the history, Home goes to /', () => {
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
        render(<MemoryRouter><PageNavLinks /></MemoryRouter>);
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(back).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    });
});
