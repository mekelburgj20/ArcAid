import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PendingSubmissionWatcher from '../PendingSubmissionWatcher';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { PENDING_SUBMISSION_STORAGE_KEY } from '../SubmissionSheet';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/** G23e: the "Login cancelled" notice is the Arcaid dialog. */

function renderWatcher() {
  sessionStorage.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify({
    stateParam: 'st1',
    target: { gameName: 'Attack from Mars' },
    createdAt: Date.now(),
  }));
  return render(
    <MemoryRouter initialEntries={['/room?submit-cancelled=st1']}>
      <ViewerAuthProvider>
        <PendingSubmissionWatcher roomSlug="room" />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('PendingSubmissionWatcher — login cancelled dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('opens as "Login cancelled"; Discard deletes the saved draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderWatcher();
    await waitForRealDialog();
    expect(screen.getByRole('dialog', { name: 'Login cancelled' })).toBeInTheDocument();
    expect(screen.getByText('Attack from Mars')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/submission-drafts/st1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });

  it('Escape puts it away without deleting anything', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderWatcher();
    await waitForRealDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/submission-drafts/st1', expect.objectContaining({ method: 'DELETE' }));
  });
});
