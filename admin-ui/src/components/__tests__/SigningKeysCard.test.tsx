import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../Toast';
import SigningKeysCard, { type SigningKey } from '../SigningKeysCard';

/**
 * W72 (v2.205.0) - the super-admin signing-key list on Global Settings: paste a
 * key to add it, retire an active one (after a confirm). Keys here are made up.
 */

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const ACTIVE: SigningKey = {
  id: 1, source: 'lu-scoreserver', algorithm: 'ed25519', publicKey: 'A'.repeat(43) + '=',
  validFrom: '2026-10-30 12:00:00', validUntil: null, note: 'from the dev channel', createdAt: '2026-10-30 12:00:00', active: true,
};
const RETIRED: SigningKey = {
  ...ACTIVE, id: 2, publicKey: 'B'.repeat(43) + '=', validUntil: '2026-10-30 13:00:00', note: null, active: false,
};

function renderCard() {
  return render(<ToastProvider><SigningKeysCard /></ToastProvider>);
}

describe('SigningKeysCard', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
  });

  it('lists keys with their state and offers Retire only on an active one', async () => {
    mockedGet.mockResolvedValue({ keys: [ACTIVE, RETIRED] });
    renderCard();
    expect(await screen.findByTestId('signing-key-state-1')).toHaveTextContent('Active');
    expect(screen.getByTestId('signing-key-state-2')).toHaveTextContent('Retired');
    expect(screen.getAllByText('Legends Unchained launcher')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Retire' })).toHaveLength(1);
  });

  it('adds a pasted key for the launcher source', async () => {
    mockedGet.mockResolvedValueOnce({ keys: [] }).mockResolvedValueOnce({ keys: [ACTIVE] });
    mockedPost.mockResolvedValue({ key: ACTIVE });
    renderCard();
    await screen.findByText(/No signing keys yet/);
    fireEvent.change(screen.getByLabelText('Public key'), { target: { value: `  ${ACTIVE.publicKey}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/admin/signing-keys', {
      source: 'lu-scoreserver', public_key: ACTIVE.publicKey, note: null,
    }));
    expect(await screen.findByTestId('signing-key-state-1')).toHaveTextContent('Active');
  });

  it('retires a key only after the confirm', async () => {
    mockedGet.mockResolvedValueOnce({ keys: [ACTIVE] }).mockResolvedValueOnce({ keys: [{ ...ACTIVE, active: false, validUntil: '2026-10-30 14:00:00' }] });
    mockedPost.mockResolvedValue({ key: { ...ACTIVE, active: false } });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    expect(mockedPost).not.toHaveBeenCalled();
    expect(screen.getByText('Retire this key?')).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole('button', { name: 'Retire' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/admin/signing-keys/1/retire', {}));
    await waitFor(() => expect(screen.getByTestId('signing-key-state-1')).toHaveTextContent('Retired'));
  });
});
