import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const put = vi.fn();
vi.mock('../../lib/api', () => ({
    api: { put: (...a: unknown[]) => put(...a) },
}));

import RenameCatalogueGameModal from '../RenameCatalogueGameModal';

const GAME = { id: 'g1', name: 'TRON Neon', manufacturer: 'Original', year: 2024 };

function setup() {
    const onClose = vi.fn();
    const onRenamed = vi.fn();
    render(<RenameCatalogueGameModal game={GAME} onClose={onClose} onRenamed={onRenamed} />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    const rename = screen.getByRole('button', { name: 'Rename' });
    return { onClose, onRenamed, input, rename };
}

beforeEach(() => {
    put.mockReset();
});

describe('RenameCatalogueGameModal', () => {
    it('opens on the current name and will not save it unchanged or blank', () => {
        const { input, rename } = setup();
        expect(input.value).toBe('TRON Neon');
        expect(rename).toBeDisabled();

        fireEvent.change(input, { target: { value: '   ' } });
        expect(rename).toBeDisabled();

        fireEvent.change(input, { target: { value: '  TRON Neon  ' } });
        expect(rename).toBeDisabled();
        expect(put).not.toHaveBeenCalled();
    });

    it('sends the trimmed name and reports the rename', async () => {
        put.mockResolvedValue({ success: true });
        const { input, rename, onRenamed } = setup();

        fireEvent.change(input, { target: { value: '  TRON Classic Neon ' } });
        fireEvent.click(rename);

        await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
        expect(put).toHaveBeenCalledWith('/admin/catalogue/games/g1', { name: 'TRON Classic Neon' });
    });

    it('shows the server refusal and stays open', async () => {
        put.mockRejectedValue(new Error('Another catalogue game already has that name, type, manufacturer and year. Use Merge instead.'));
        const { input, rename, onRenamed, onClose } = setup();

        fireEvent.change(input, { target: { value: 'TRON Classic' } });
        fireEvent.click(rename);

        expect(await screen.findByRole('alert')).toHaveTextContent('Use Merge instead');
        expect(onRenamed).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Rename' })).not.toBeDisabled();
    });

    it('closes on Cancel and on Escape without saving', () => {
        const { onClose } = setup();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(put).not.toHaveBeenCalled();
    });
});
