import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProvenanceTags from '../ProvenanceTags';
import { isWitnessedScore } from '../../lib/provenanceDisplay';

/**
 * v2.155.0 — the WITNESSED badge.
 *
 * A cabinet-reported score has no photo, because nobody submitted it. On a
 * board where every other row is either typed or photo-backed, that made the
 * best-evidenced score on the page look like the least-evidenced one. The badge
 * is the only thing that says otherwise.
 *
 * What these tests pin:
 *
 *   1. **It renders for the two sources that actually mean a cabinet reported
 *      it**, and for nothing else — `'tournament'` is a person typing inside a
 *      tournament window, which is not the same claim.
 *   2. **An unknown source renders NO badge, not a negative one.** Absence must
 *      read as "we cannot say", never as an accusation, and older rows have no
 *      source at all.
 *   3. **It survives on its own**, without engine or device — a witnessed score
 *      with unrecorded provenance still has something true to show.
 */

describe('isWitnessedScore', () => {
    it('accepts only the sources that mean a paired cabinet reported it', () => {
        expect(isWitnessedScore({ source: 'vpx' })).toBe(true);
        expect(isWitnessedScore({ source: 'atgames' })).toBe(true);
    });

    it('rejects everything a human could have typed', () => {
        // 'tournament' says WHEN a score was submitted, not HOW — a person
        // typed it, inside a window. Badging it would make the badge meaningless.
        expect(isWitnessedScore({ source: 'tournament' })).toBe(false);
        expect(isWitnessedScore({ source: 'community' })).toBe(false);
        expect(isWitnessedScore({ source: 'sync' })).toBe(false);
        expect(isWitnessedScore({ source: null })).toBe(false);
        expect(isWitnessedScore({})).toBe(false);
    });
});

describe('ProvenanceTags — witnessed badge', () => {
    it('shows the badge beside the platform chips for a cabinet-reported score', () => {
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'atgames', source: 'vpx' }} />);
        expect(screen.getByTestId('witnessed-badge')).toBeInTheDocument();
        // And it does not replace the provenance chips — the two answer
        // different questions and both still render.
        expect(screen.getByText('VPX')).toBeInTheDocument();
    });

    it('shows nothing for a typed score', () => {
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'pc', source: 'tournament' }} />);
        expect(screen.queryByTestId('witnessed-badge')).not.toBeInTheDocument();
    });

    it('shows nothing when the payload has no source at all', () => {
        // Pre-v2.155.0 rows. Silence, not a negative badge.
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'pc' }} />);
        expect(screen.queryByTestId('witnessed-badge')).not.toBeInTheDocument();
    });

    it('renders on its own when the score has no recorded provenance', () => {
        // resolveProvenance returns null here, which previously meant "render
        // nothing at all" — but a witnessed score still has something to say.
        render(<ProvenanceTags entry={{ source: 'atgames' }} />);
        expect(screen.getByTestId('witnessed-badge')).toBeInTheDocument();
    });

    it('survives the engine-filtered view, where the engine chip is suppressed', () => {
        // Inside an engine tab the engine is redundant and omitted; the badge is
        // not redundant and must not be dropped with it.
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'atgames', source: 'vpx' }} omitEngine />);
        expect(screen.getByTestId('witnessed-badge')).toBeInTheDocument();
    });
});
