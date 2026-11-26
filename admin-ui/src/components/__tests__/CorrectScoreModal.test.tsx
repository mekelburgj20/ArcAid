import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CorrectScoreModal from '../CorrectScoreModal';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/**
 * G23c (v2.271.0) — the score correction on the Arcaid dialog. The caller owns
 * the request; this dialog only hands back the number, and refuses a no-op.
 */
function renderModal() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<CorrectScoreModal playerLabel="Ada" currentScore={4200000} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe('CorrectScoreModal', () => {
  it('is a dialog named for the player, with the old value under it and focus in the field', async () => {
    renderModal();
    await waitForRealDialog();
    const dialog = screen.getByRole('dialog', { name: 'Ada' });
    expect(dialog).toHaveAccessibleDescription('was 4,200,000 (4.2 million)');
    const input = screen.getByLabelText('Corrected score') as HTMLInputElement;
    expect(input.value).toBe('4,200,000');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('keeps Save disabled while the value is unchanged, enables it after typing, and hands back the number', async () => {
    const { onConfirm } = renderModal();
    await waitForRealDialog();
    const save = screen.getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    expect(screen.getByText('That is already the recorded score.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Corrected score'), { target: { value: '42000000' } });
    expect((screen.getByLabelText('Corrected score') as HTMLInputElement).value).toBe('42,000,000');
    // The magnitude echo is the field's hint.
    expect(screen.getByText('42 million')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeEnabled();
    expect(screen.queryByText('That is already the recorded score.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(42000000));
  });

  it('refuses a number too large to record exactly', async () => {
    renderModal();
    await waitForRealDialog();
    fireEvent.change(screen.getByLabelText('Corrected score'), { target: { value: '99999999999999999' } });
    expect(screen.getByText('That number is too large to record exactly.')).toBeInTheDocument();
    expect(screen.getByLabelText('Corrected score')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  });

  it('cancels with Cancel and with Escape', async () => {
    const { onCancel, onConfirm } = renderModal();
    await waitForRealDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('Corrected score'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
