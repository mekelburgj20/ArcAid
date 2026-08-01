import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReportProblemModal from '../ReportProblemModal';

/**
 * Contract §5 — the "not score-eligible" reason on the game report-a-problem
 * flow. What matters and is easy to regress:
 *   * the option exists and posts the enum value the server's zod accepts
 *   * it does NOT demand a suggestion/note (there is nothing to suggest), while
 *     every other reason still does — the FE guard and the server refine carry
 *     the same exemption and must not drift
 *   * the "suggested correction" field, meaningless here, gets out of the way
 */

function ok(status = 200, body: unknown = {}) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

function renderModal(playerToken: string | null = 'player-jwt') {
    const onClose = vi.fn();
    const utils = render(
        <ReportProblemModal
            globalGameId="gg-1"
            gameName="Puzzle Thing"
            playerToken={playerToken}
            onClose={onClose}
        />,
    );
    return { ...utils, onClose };
}

function selectReason(value: string) {
    fireEvent.change(screen.getByRole('combobox'), { target: { value } });
}

describe('ReportProblemModal — not-score-eligible reason (§5)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('offers the reason with the contract wording', () => {
        renderModal();
        expect(screen.getByRole('option', { name: "Not score-eligible (game isn't score-based)" }))
            .toBeInTheDocument();
    });

    it('submits with no note and posts the enum the server accepts', async () => {
        const fetchMock = vi.fn(() => ok(201, { id: 'fb-1' }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        renderModal();
        selectReason('not_score_eligible');
        fireEvent.click(screen.getByRole('button', { name: /Send report/ }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/api/global/games/gg-1/feedback');
        expect(JSON.parse(init.body as string)).toEqual({ field: 'not_score_eligible' });
        expect(await screen.findByText(/Thanks — your report is in/)).toBeInTheDocument();
    });

    it('hides the suggested-correction field, which means nothing for this reason', () => {
        renderModal();
        expect(screen.getByText(/Suggested correction/)).toBeInTheDocument();
        selectReason('not_score_eligible');
        expect(screen.queryByText(/Suggested correction/)).not.toBeInTheDocument();
        expect(screen.getByText(/nothing is removed\s+automatically/)).toBeInTheDocument();
    });

    it('still demands a correction or note for the metadata reasons', async () => {
        const fetchMock = vi.fn(() => ok(201, { id: 'fb-1' }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        renderModal();
        selectReason('manufacturer');
        fireEvent.click(screen.getByRole('button', { name: /Send report/ }));

        expect(await screen.findByText(/Add a suggested correction or a note/)).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('prompts a logged-out viewer to log in instead of showing the form', () => {
        renderModal(null);
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.getByText(/Log in with Discord/)).toBeInTheDocument();
    });
});
