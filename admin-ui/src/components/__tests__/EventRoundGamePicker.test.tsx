import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { defaultEventState, type EventFormState } from '../../lib/eventTime';

/**
 * A34 (v2.233.0) — an event round's game is picked from a VISIBLE list of
 * catalogue matches. The old `<datalist>` barely showed on a phone, so a host
 * saved "Arkanoid" where the catalogue (and AtGames) has "Arkanoid (Pinball)".
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

const { default: EventSettingsFields } = await import('../EventSettingsFields');

function Harness() {
    const [state, setState] = useState<EventFormState>({
        ...defaultEventState,
        rounds: [{ ...defaultEventState.rounds[0]!, roundNo: 1, gameName: '' }],
    });
    return (
        <>
            <EventSettingsFields state={state} onChange={setState} roomId="room-1" />
            <output data-testid="picked">{state.rounds[0]?.gameName}</output>
        </>
    );
}

beforeEach(() => {
    getMock.mockReset().mockImplementation((path: string) => {
        if (path.includes('/game_library/search')) {
            return Promise.resolve([
                { name: 'Arkanoid (Pinball)', mode: 'pinball', platforms: '["atgames_native"]' },
            ]);
        }
        return Promise.resolve([]);
    });
});

describe('event round game picker', () => {
    it('lists catalogue matches visibly, marks AtGames tables, and picks one', async () => {
        render(<Harness />);
        const input = screen.getByPlaceholderText('Search the catalogue');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Arkanoid' } });

        const listbox = await screen.findByRole('listbox', {}, { timeout: 2000 });
        const option = within(listbox).getByRole('option');
        expect(option.textContent).toContain('Arkanoid (Pinball)');
        expect(option.textContent).toContain('AtGames');
        // Typed text with no exact match is flagged before the save.
        expect(screen.getByText(/Not a catalogue game/)).toBeTruthy();

        fireEvent.click(option.querySelector('button')!);
        expect(screen.getByTestId('picked').textContent).toBe('Arkanoid (Pinball)');
        await waitFor(() => expect(screen.queryByText(/Not a catalogue game/)).toBeNull(), { timeout: 2000 });
    });
});
