import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WitnessBadge, type WitnessVerdict } from '../WitnessBadge';

/**
 * A42 (v2.239.0, owner 2026-11-09) - no mark for an unwitnessed score. The grey
 * "unwitnessed" word sat on every AtGames-pulled score without a Witness
 * device and read as an accusation. Only the two marks that say something
 * stay: ✓ (the Witness vouched for the timing) and ⚠ (started before the
 * round opened).
 */

const verdict = (over: Partial<WitnessVerdict>): WitnessVerdict => ({
    status: 'unwitnessed', method: null, launchTs: null, exitTs: null, durationSec: null, table: null, ...over,
});

describe('WitnessBadge', () => {
    it('renders nothing for an unwitnessed score, a no-ROM exit sample included', () => {
        const { container, rerender } = render(<WitnessBadge witness={verdict({})} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<WitnessBadge witness={verdict({ sample: 'exit' })} />);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByText(/unwitnessed/)).toBeNull();
    });

    it('still marks a verified score and a flagged one', () => {
        render(
            <>
                <WitnessBadge witness={verdict({ status: 'verified', method: 'checkin' })} />
                <WitnessBadge witness={verdict({ status: 'verified', method: 'session', durationSec: 252 })} />
                <WitnessBadge witness={verdict({ status: 'flagged', method: 'session' })} />
            </>,
        );
        expect(screen.getByText('checked in')).toBeInTheDocument();
        expect(screen.getByTitle(/Witnessed: launched inside the round window · 4m 12s of play/)).toBeInTheDocument();
        expect(screen.getByText('⚠')).toBeInTheDocument();
    });
});
