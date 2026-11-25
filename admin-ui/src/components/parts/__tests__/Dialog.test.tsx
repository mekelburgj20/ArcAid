import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog, Dialog } from '../Dialog';
import ConfirmModal from '../../ConfirmModal';
import { setPartImporterForTests } from '../../../lib/lazyPart';

/**
 * G23 - the Arcaid dialog. base-ui lives in a chunk of its own (`DialogImpl`);
 * until it arrives, or when it cannot load, `Dialog` draws a stand-in that
 * must work the same: the right roles and names, Escape and a press outside
 * cancel, focus starts on Cancel. When the chunk comes the real dialog takes
 * over in place.
 */

type Deferred = { promise: Promise<unknown>; resolve: () => void; reject: (e: Error) => void };

function deferredImport(): Deferred {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
        resolve = () => { void import('../DialogImpl').then(res); };
        reject = rej;
    });
    return { promise, resolve, reject };
}

const never = () => new Promise<never>(() => {});
const realChunk = () => import('../DialogImpl');

function renderConfirm(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const utils = render(
        <ConfirmDialog
            open
            onCancel={onCancel}
            onConfirm={onConfirm}
            title="Leave RTX Pinball?"
            message="You can rejoin any time."
            confirmLabel="Leave room"
            tone="pink"
            {...over}
        />,
    );
    return { ...utils, onCancel, onConfirm };
}

/** A press outside the slab: on the viewport around it (the backdrop sits under it). */
function pressOutside() {
    const viewport = document.querySelector('.arc-dialog-vp') as HTMLElement;
    fireEvent.pointerDown(viewport);
    fireEvent.mouseDown(viewport);
    fireEvent.pointerUp(viewport);
    fireEvent.mouseUp(viewport);
    fireEvent.click(viewport);
}

const isReal = (dialog: HTMLElement) => !dialog.classList.contains('arc-dialog--stand-in');

afterEach(() => {
    setPartImporterForTests('dialog');
    document.documentElement.style.overflow = '';
});

describe('Dialog - the stand-in, before the chunk arrives', () => {
    it('renders at once with the dialog role, its name, description and the buttons', () => {
        setPartImporterForTests('dialog', never);
        renderConfirm();
        const dialog = screen.getByRole('dialog', { name: 'Leave RTX Pinball?' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription('You can rejoin any time.');
        expect(dialog.className).toContain('arc-dialog--stand-in');
        expect(dialog.className).toContain('arc-dialog--pink');
        // Fixed dark on every theme: the slab carries the dark tokens.
        expect(dialog.className).toContain('sb-theme-scope');
        expect(within(dialog).getByText('Leave room', { selector: '.arc-dialog__label' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Leave room' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
        // Portalled to <body>, like the real one.
        expect(dialog.closest('.arc-dialog-vp')?.parentElement).toBe(document.body);
    });

    it('starts focus on Cancel', () => {
        setPartImporterForTests('dialog', never);
        renderConfirm();
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    it('confirms with the action, and cancels with Cancel and with the x', () => {
        setPartImporterForTests('dialog', never);
        const { onCancel, onConfirm } = renderConfirm();
        fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it('cancels on Escape, and the Escape is not also a page handler\'s (a modal under it)', () => {
        setPartImporterForTests('dialog', never);
        const pageEscape = vi.fn();
        window.addEventListener('keydown', pageEscape);
        try {
            const { onCancel } = renderConfirm();
            fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
            expect(onCancel).toHaveBeenCalledTimes(1);
            expect(pageEscape).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', pageEscape);
        }
    });

    it('cancels on a press outside the slab, not on one inside it', () => {
        setPartImporterForTests('dialog', never);
        const { onCancel } = renderConfirm();
        fireEvent.click(screen.getByText('You can rejoin any time.'));
        expect(onCancel).not.toHaveBeenCalled();
        pressOutside();
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('keeps Tab inside, locks the page scroll while open and gives focus back on close', () => {
        setPartImporterForTests('dialog', never);
        function Host() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>Open it</button>
                    <ConfirmDialog open={open} onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)} title="Delete score?" message="Gone for good." confirmLabel="Delete" />
                </>
            );
        }
        render(<Host />);
        const opener = screen.getByRole('button', { name: 'Open it' });
        opener.focus();
        fireEvent.click(opener);
        expect(document.documentElement.style.overflow).toBe('hidden');
        const action = screen.getByRole('button', { name: 'Delete' });
        action.focus();
        fireEvent.keyDown(action, { key: 'Tab' });
        // The x is the first focusable in the slab, so Tab from the last goes there.
        expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.documentElement.style.overflow).toBe('');
        expect(opener).toHaveFocus();
    });

    it('draws nothing while closed', () => {
        setPartImporterForTests('dialog', never);
        renderConfirm({ open: false });
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('Dialog - the real dialog (base-ui)', () => {
    it('replaces the stand-in when the chunk arrives, with the same name, buttons and focus', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onCancel, onConfirm } = renderConfirm({ tone: 'red', title: 'Delete score?', confirmLabel: 'Delete score' });
        await waitFor(() => expect(isReal(screen.getByRole('dialog', { name: 'Delete score?' }))).toBe(true));
        const dialog = screen.getByRole('dialog', { name: 'Delete score?' });
        expect(dialog.className).toContain('arc-dialog--red');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription('You can rejoin any time.');
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete score' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('cancels on Escape and on the x (base-ui)', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onCancel } = renderConfirm();
        await waitFor(() => expect(isReal(screen.getByRole('dialog'))).toBe(true));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
        fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it('cancels on a press outside the slab (base-ui)', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onCancel } = renderConfirm();
        await waitFor(() => expect(isReal(screen.getByRole('dialog'))).toBe(true));
        pressOutside();
        await waitFor(() => expect(onCancel).toHaveBeenCalled());
    });

    it('a press on a toast (they sit above dialogs) does not close it: base-ui closes on its own backdrop only', async () => {
        setPartImporterForTests('dialog', realChunk);
        const toaster = document.createElement('section');
        toaster.setAttribute('data-sonner-toaster', '');
        const toast = document.createElement('button');
        toast.textContent = 'Dismiss';
        toaster.appendChild(toast);
        document.body.appendChild(toaster);
        try {
            const { onCancel } = renderConfirm();
            await waitFor(() => expect(isReal(screen.getByRole('dialog'))).toBe(true));
            fireEvent.pointerDown(toast);
            fireEvent.mouseDown(toast);
            fireEvent.pointerUp(toast);
            fireEvent.mouseUp(toast);
            fireEvent.click(toast);
            await act(async () => { await Promise.resolve(); });
            expect(onCancel).not.toHaveBeenCalled();
            pressOutside();
            await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
        } finally {
            toaster.remove();
        }
    });

    it('takes over in place: no second entrance, focus stays where it was', async () => {
        const chunk = deferredImport();
        setPartImporterForTests('dialog', () => chunk.promise);
        renderConfirm();
        const standIn = screen.getByRole('dialog');
        expect(standIn.className).toContain('arc-dialog--stand-in');
        screen.getByRole('button', { name: 'Leave room' }).focus();
        await act(async () => { chunk.resolve(); await chunk.promise; });
        await waitFor(() => expect(isReal(screen.getByRole('dialog'))).toBe(true));
        const real = screen.getByRole('dialog');
        expect(real.className).toContain('arc-dialog--handoff');
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        await waitFor(() => expect(within(real).getByRole('button', { name: 'Leave room' })).toHaveFocus());
    });

    it('a chunk that cannot load leaves a working stand-in, and the next open tries again', async () => {
        const importer = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
        setPartImporterForTests('dialog', importer);
        const onCancel = vi.fn();
        const onConfirm = vi.fn();
        const { rerender } = render(
            <ConfirmDialog open onCancel={onCancel} onConfirm={onConfirm} title="Delete score?" message="Gone." confirmLabel="Delete" />,
        );
        await waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
        await act(async () => { await Promise.resolve(); });
        const dialog = screen.getByRole('dialog', { name: 'Delete score?' });
        expect(dialog.className).toContain('arc-dialog--stand-in');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);

        rerender(<ConfirmDialog open={false} onCancel={onCancel} onConfirm={onConfirm} title="Delete score?" message="Gone." confirmLabel="Delete" />);
        rerender(<ConfirmDialog open onCancel={onCancel} onConfirm={onConfirm} title="Delete score?" message="Gone." confirmLabel="Delete" />);
        await waitFor(() => expect(importer).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('dialog', { name: 'Delete score?' })).toBeInTheDocument();
    });

    it('a form sheet keeps its body and actions, with the grab handle hidden from screen readers', async () => {
        setPartImporterForTests('dialog', realChunk);
        const onOpenChange = vi.fn();
        render(
            <Dialog open onOpenChange={onOpenChange} sheet size="md" label="Submit a score" title="Attack from Mars" footer={<button type="button">Submit score</button>}>
                <label htmlFor="sg-score">Score</label>
                <input id="sg-score" />
            </Dialog>,
        );
        await waitFor(() => expect(isReal(screen.getByRole('dialog', { name: 'Attack from Mars' }))).toBe(true));
        const dialog = screen.getByRole('dialog', { name: 'Attack from Mars' });
        expect(dialog.className).toContain('arc-dialog--sheet');
        expect(dialog.className).toContain('arc-dialog--form');
        expect(dialog.className).toContain('arc-dialog--md');
        expect(within(dialog).getByLabelText('Score')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Submit score' })).toBeInTheDocument();
        expect(dialog.querySelector('.arc-dialog__grab')).toHaveAttribute('aria-hidden', 'true');
        // No phone here (jsdom has no matchMedia): a centred dialog, which does not swipe.
        expect(dialog).toHaveAttribute('data-base-ui-swipe-ignore');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('fetches the chunk once, when the browser is idle after the first dialog mounts (open or not)', () => {
        vi.useFakeTimers();
        try {
            const importer = vi.fn(never);
            setPartImporterForTests('dialog', importer);
            render(<><Dialog open={false} onOpenChange={() => {}} label="A" title="A" /><Dialog open={false} onOpenChange={() => {}} label="B" title="B" /></>);
            expect(importer).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(2000); });
            expect(importer).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('ConfirmModal on the Arcaid confirm', () => {
    it('is red by default and pink when asked, with its words on the action', () => {
        setPartImporterForTests('dialog', never);
        const { unmount } = render(<ConfirmModal title="Delete score" message="Sure?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />);
        expect(screen.getByRole('dialog', { name: 'Delete score' }).className).toContain('arc-dialog--red');
        expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('ink-danger');
        unmount();
        render(<ConfirmModal title="Leave RTX Pinball?" message="Sure?" confirmLabel="Leave room" tone="pink" onConfirm={() => {}} onCancel={() => {}} />);
        expect(screen.getByRole('dialog', { name: 'Leave RTX Pinball?' }).className).toContain('arc-dialog--pink');
        // The dialog's lead is the kit's pink, so the pink action is the primary button.
        expect(screen.getByRole('button', { name: 'Leave room' }).className).toContain('ink-lead');
    });
});
