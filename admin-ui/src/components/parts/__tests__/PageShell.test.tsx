import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageShell from '../PageShell';
import { PAGE_WIDTH, RESULTS_PAGE } from '../../../lib/pageLayout';

/**
 * G21 - the content frame of a themed page: one of the two page widths, and
 * with a jump list the part (theme-skin) jump layout. It never loads the kit.
 */
describe('PageShell', () => {
    it('is the wide page width by default, children directly inside', () => {
        const { container } = render(<PageShell><p>content</p></PageShell>);
        const root = container.firstElementChild as HTMLElement;
        expect(PAGE_WIDTH.wide).toBe(RESULTS_PAGE);
        expect(root.className).toBe(RESULTS_PAGE);
        expect(root.firstElementChild!.tagName).toBe('P');
        expect(screen.queryByRole('navigation')).toBeNull();
        expect(document.head.querySelector('link[data-aw-theme]')).toBeNull();
    });

    it("'column' is the 52rem column, and extra classes are appended", () => {
        const { container } = render(<PageShell width="column" className="py-6">x</PageShell>);
        expect(container.firstElementChild!.className).toBe('w-full max-w-[52rem] mx-auto px-4 sm:px-6 py-6');
    });

    it('with a jump list: the part jump layout, chips in the theme skin', () => {
        const { container } = render(
            <PageShell jump={[{ id: 'g1', title: 'General', tone: 'violet' }]}>
                <section id="g1">group</section>
            </PageShell>,
        );
        const layout = container.firstElementChild!.firstElementChild as HTMLElement;
        expect(layout.className).toBe('part-jumplayout');
        expect(layout.children[0]).toBe(screen.getByRole('navigation', { name: 'Sections' }));
        expect(layout.children[0]!.className).toBe('part-jump');
        expect(screen.getByRole('button', { name: 'General' }).className).toBe('part-jump__item part-tone--violet');
        expect(layout.children[1]!.className).toBe('part-jumplayout__body');
        expect(layout.children[1]).toHaveTextContent('group');
    });
});
