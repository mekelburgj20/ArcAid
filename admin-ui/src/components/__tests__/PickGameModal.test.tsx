import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PickGameModal from '../PickGameModal';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/** G23e: the pick dialog is the Arcaid dialog (`parts/Dialog`). */

function renderModal(over: Partial<React.ComponentProps<typeof PickGameModal>> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <PickGameModal
      gameName="Attack from Mars"
      tournaments={[
        { id: 't1', name: 'Weekly', type: 'weekly', mode: 'rotation' },
        { id: 't2', name: 'Monthly', type: 'monthly', mode: 'rotation' },
      ]}
      pendingPicks={[]}
      selectedTournamentId={null}
      onConfirm={onConfirm}
      onClose={onClose}
      {...over}
    />,
  );
  return { onClose, onConfirm };
}

describe('PickGameModal', () => {
  it('opens as "Pick a game" and Escape calls onClose', async () => {
    const { onClose } = renderModal();
    await waitForRealDialog();
    expect(screen.getByRole('dialog', { name: 'Pick a game' })).toBeInTheDocument();
    expect(screen.getByText('Attack from Mars')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Queue Game confirms with the chosen tournament', async () => {
    const { onConfirm } = renderModal();
    await waitForRealDialog();
    fireEvent.change(screen.getByLabelText('Tournament'), { target: { value: 't2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Game' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('t2'));
  });

  it('says Pick & Activate when the player holds a win pick', async () => {
    renderModal({
      pendingPicks: [{ tournament_id: 't1', tournament_name: 'Weekly', picker_type: 'win', picker_designated_at: '2026-11-01' }],
    });
    await waitForRealDialog();
    expect(screen.getByRole('button', { name: 'Pick & Activate' })).toBeInTheDocument();
  });
});
