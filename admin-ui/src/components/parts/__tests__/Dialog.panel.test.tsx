import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Dialog } from '../Dialog';
import { setPartImporterForTests } from '../../../lib/lazyPart';
import { waitForRealDialog } from '../../../test/dialogTestUtils';

/**
 * G34a - the dialog's `panel` mode (Display settings): not a modal. The page
 * beside it stays clickable and readable (no backdrop, nothing `inert` or
 * `aria-hidden`, no scroll lock); Escape closes it only with focus inside it,
 * and a press on the page never does. The stand-in behaves the same.
 */

const never = () => new Promise<never>(() => {});
const realChunk = () => import('../DialogImpl');

function renderPanel() {
    const onOpenChange = vi.fn();
    const onPage = vi.fn();
    const utils = render(
        <div>
            <button type="button" onClick={onPage}>Page button</button>
            <input aria-label="Page search" />
            <Dialog
                open
                onOpenChange={onOpenChange}
                panel
                label="Display"
                title="Display settings"
                description="Only you see these."
                footer={<button type="button">Undo changes</button>}
            >
                <button type="button">Inside</button>
            </Dialog>
        </div>,
    );
    return { ...utils, onOpenChange, onPage };
}

/** The page button is not shut away from a pointer or a screen reader. */
function expectPageOpen(el: HTMLElement) {
    expect(el.closest('[inert]')).toBeNull();
    expect(el.closest('[aria-hidden="true"]')).toBeNull();
}

afterEach(() => {
    setPartImporterForTests('dialog');
    document.documentElement.style.overflow = '';
});

describe('Dialog panel - the real one (base-ui Drawer, modal off)', () => {
    it('is a non-modal dialog named by its title, with no backdrop, and the page stays usable', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onPage, onOpenChange } = renderPanel();
        await waitForRealDialog();
        const dialog = screen.getByRole('dialog', { name: 'Display settings' });
        expect(dialog.className).toContain('arc-dialog--panel');
        expect(dialog).toHaveAttribute('aria-modal', 'false');
        expect(document.querySelector('.arc-dialog-backdrop')).toBeNull();
        expect(document.querySelector('.arc-dialog-vp--panel')).not.toBeNull();
        expect(document.documentElement.style.overflow).not.toBe('hidden');

        const pageButton = screen.getByRole('button', { name: 'Page button' });
        expectPageOpen(pageButton);
        expectPageOpen(screen.getByRole('textbox', { name: 'Page search' }));
        fireEvent.click(pageButton);
        expect(onPage).toHaveBeenCalledTimes(1);
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('starts focus on its title', async () => {
        setPartImporterForTests('dialog', realChunk);
        renderPanel();
        await waitForRealDialog();
        await waitFor(() => expect(document.activeElement).toHaveClass('arc-dialog__title'));
    });

    it('a press on the page does not close it', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onOpenChange } = renderPanel();
        await waitForRealDialog();
        const pageButton = screen.getByRole('button', { name: 'Page button' });
        fireEvent.pointerDown(pageButton);
        fireEvent.mouseDown(pageButton);
        fireEvent.pointerUp(pageButton);
        fireEvent.mouseUp(pageButton);
        fireEvent.click(pageButton);
        pageButton.focus();
        await new Promise(r => setTimeout(r, 50));
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Display settings' })).toBeInTheDocument();
    });

    it('Escape with focus inside closes it; Escape on the page does not, and the page still hears it', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onOpenChange } = renderPanel();
        await waitForRealDialog();
        const search = screen.getByRole('textbox', { name: 'Page search' });
        // A page-wide key handler sits on the window, past the document where base-ui listens.
        const pageKeys = vi.fn();
        window.addEventListener('keydown', pageKeys);
        try {
            search.focus();
            fireEvent.keyDown(search, { key: 'Escape' });
            expect(onOpenChange).not.toHaveBeenCalled();
            expect(pageKeys).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('keydown', pageKeys);
        }

        const inside = within(screen.getByRole('dialog')).getByRole('button', { name: 'Inside' });
        inside.focus();
        fireEvent.keyDown(inside, { key: 'Escape' });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('the x closes it', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onOpenChange } = renderPanel();
        await waitForRealDialog();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

describe('Dialog panel - the stand-in, before the chunk arrives', () => {
    it('is non-modal: no backdrop, no scroll lock on the page, no Tab trap', () => {
        setPartImporterForTests('dialog', never);
        const { onPage } = renderPanel();
        const dialog = screen.getByRole('dialog', { name: 'Display settings' });
        expect(dialog.className).toContain('arc-dialog--stand-in');
        expect(dialog.className).toContain('arc-dialog--panel');
        expect(dialog).toHaveAttribute('aria-modal', 'false');
        expect(document.querySelector('.arc-dialog-backdrop')).toBeNull();
        expect(document.documentElement.style.overflow).not.toBe('hidden');
        // Focus starts on the title.
        expect(document.activeElement).toHaveClass('arc-dialog__title');

        // Tab from the last control inside is not pulled back to the first.
        const last = within(dialog).getByRole('button', { name: 'Undo changes' });
        last.focus();
        const tab = fireEvent.keyDown(last, { key: 'Tab' });
        expect(tab).toBe(true);

        const pageButton = screen.getByRole('button', { name: 'Page button' });
        expectPageOpen(pageButton);
        fireEvent.click(pageButton);
        expect(onPage).toHaveBeenCalledTimes(1);
    });

    it('Escape closes it only with focus inside; a press on the page does not', () => {
        setPartImporterForTests('dialog', never);
        const { onOpenChange } = renderPanel();
        const search = screen.getByRole('textbox', { name: 'Page search' });
        search.focus();
        fireEvent.keyDown(search, { key: 'Escape' });
        fireEvent.click(screen.getByRole('button', { name: 'Page button' }));
        fireEvent.click(document.querySelector('.arc-dialog-vp--panel') as HTMLElement);
        expect(onOpenChange).not.toHaveBeenCalled();

        const inside = screen.getByRole('button', { name: 'Inside' });
        inside.focus();
        fireEvent.keyDown(inside, { key: 'Escape' });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});
