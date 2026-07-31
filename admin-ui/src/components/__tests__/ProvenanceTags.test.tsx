import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProvenanceTags from '../ProvenanceTags';
import { describeProvenance, resolveProvenance } from '../../lib/provenanceDisplay';
import { UNKNOWN } from '../../lib/scoreProvenance';

/**
 * ADR 0016 P3 — per-score provenance rendering.
 *
 * The rules under test are the ones a call site could plausibly get wrong, and
 * each has a correctness reason rather than an aesthetic one:
 *
 *  - `unknown` engine must be VISIBLE as "Unspecified". It is the majority
 *    state on production (the AtGames ambiguity), and hiding it would make a
 *    real data state indistinguishable from a broken render.
 *  - `unknown` device must be INVISIBLE. "Unspecified · Unspecified" is noise.
 *  - Device is dropped when it adds nothing — an engine with one possible
 *    device tells the reader nothing they didn't already know.
 */
describe('ProvenanceTags', () => {
    it('renders engine prominently and device as a secondary tag', () => {
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'atgames' }} />);
        // The case ADR 0016 exists for: a VPX score that happens to be on an
        // AtGames cabinet — two facts, not one conflated "platform".
        expect(screen.getByText('VPX')).toBeInTheDocument();
        expect(screen.getByText('AtGames')).toBeInTheDocument();
    });

    it('renders an unknown engine as "Unspecified", never blank', () => {
        const { container } = render(<ProvenanceTags entry={{ engine: UNKNOWN, device: 'atgames' }} />);
        expect(screen.getByText('Unspecified')).toBeInTheDocument();
        expect(screen.getByText('AtGames')).toBeInTheDocument();
        expect(container.textContent).not.toBe('');
    });

    it('renders no secondary tag for an unknown device', () => {
        render(<ProvenanceTags entry={{ engine: 'vpx', device: UNKNOWN }} />);
        expect(screen.getByText('VPX')).toBeInTheDocument();
        // Exactly one "Unspecified" would be wrong here too — the engine is
        // known, so nothing should read as unspecified at all.
        expect(screen.queryByText('Unspecified')).not.toBeInTheDocument();
    });

    it('drops a device that carries no information', () => {
        render(<ProvenanceTags entry={{ engine: 'real', device: 'real_cabinet' }} />);
        expect(screen.getByText('Real')).toBeInTheDocument();
        // "Real · Cabinet" says nothing "Real" didn't.
        expect(screen.queryByText('Cabinet')).not.toBeInTheDocument();
    });

    it('renders nothing at all when the payload carries no provenance', () => {
        // A pre-P3 cached blob. Better to show nothing than to invent
        // "Unspecified" the server never claimed.
        const { container } = render(<ProvenanceTags entry={{}} />);
        expect(container.firstChild).toBeNull();
    });

    it('omitEngine keeps only the device, for use inside an engine tab', () => {
        render(<ProvenanceTags entry={{ engine: 'vpx', device: 'atgames' }} omitEngine />);
        expect(screen.queryByText('VPX')).not.toBeInTheDocument();
        expect(screen.getByText('AtGames')).toBeInTheDocument();
    });

    it('omitEngine renders nothing when the device is also uninformative', () => {
        const { container } = render(
            <ProvenanceTags entry={{ engine: 'vpx', device: UNKNOWN }} omitEngine />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('exposes the fidelity category in the tooltip, and omits it when there is none', () => {
        expect(describeProvenance('vpx', 'atgames')).toBe('Visual Pinball X on AtGames Cabinet (Simulation)');
        expect(describeProvenance('fx', 'pc')).toBe('Pinball FX on PC (Arcade-Style)');
        expect(describeProvenance('real', 'real_cabinet')).toBe('Real Machine (Real)');
        // No invented category for the unknown engine.
        expect(describeProvenance(UNKNOWN, 'atgames')).toBe('Unspecified on AtGames Cabinet');
    });
});

describe('resolveProvenance', () => {
    it('defaults a present-but-partial payload to unknown on the missing axis', () => {
        expect(resolveProvenance({ engine: 'vpx' })).toEqual({ engine: 'vpx', device: UNKNOWN });
        expect(resolveProvenance({ device: 'pc' })).toEqual({ engine: UNKNOWN, device: 'pc' });
    });

    it('returns null only when neither axis is present', () => {
        expect(resolveProvenance({})).toBeNull();
        expect(resolveProvenance({ engine: null, device: null })).toBeNull();
        // The deprecated legacy field alone is NOT enough — deriving provenance
        // from it client-side is exactly the guesswork ADR 0016 removes.
        expect(resolveProvenance({ platform: 'vpx' })).toBeNull();
    });
});
