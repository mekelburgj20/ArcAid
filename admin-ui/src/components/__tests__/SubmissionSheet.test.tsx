import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmissionSheet, { type SubmissionTarget } from '../SubmissionSheet';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import * as photoNormalize from '../../lib/photoNormalize';

/**
 * SubmissionSheet — engine/device derivation + remembered-device restore.
 *
 * Covers only the picker-derivation surface (engine/device option lists,
 * auto-lock, and the `arcaid_last_device` restore). Submit flows, drafts and
 * photo upload are deliberately out of scope for this pass — the picker
 * derivation is where the v2.95.1 regression lived and is the part most
 * likely to silently drift again (see `lib/allowedProvenance.ts`'s own doc
 * comment on why the derivation must never fork).
 *
 * Harness notes:
 *   - SubmissionSheet reads `useViewerAuth()`, so it needs `ViewerAuthProvider`
 *     mounted above it; `signIn()` seeds the same localStorage keys
 *     ViewerAuthContext reads on mount (`arcaid_player_token`/`_user`) —
 *     mirrors the idiom in `pages/__tests__/PicksAlertStates.test.tsx`. A
 *     signed-in viewer is required or the sheet renders the `loginRequired`
 *     phase instead of the form.
 *   - It also renders inside a `role="dialog"`/`<Link>`, hence `MemoryRouter`.
 *   - The only network call the derivation surface makes is
 *     `GET /api/submit/platforms?...`; `renderSheet` stubs it with a
 *     configurable response built by `platformsPayload()`, which mirrors the
 *     exact shape `parseSubmitPlatformsResponse` (lib/allowedProvenance.ts)
 *     expects: `{ platforms, submittable, features, tournamentRules }`.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '111111111111111111', username = 'Tester') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

interface PlatformsPayloadOpts {
    /** Full game platform set before tournament rules; defaults to `submittable`. */
    platforms?: string[];
    submittable?: string[];
    features?: string[];
    excludedEngines?: string[];
    excludedDevices?: string[];
}

/** Builds a `GET /api/submit/platforms` response body. */
function platformsPayload(opts: PlatformsPayloadOpts) {
    const { platforms, submittable = [], features = [], excludedEngines = [], excludedDevices = [] } = opts;
    return {
        platforms: platforms ?? submittable,
        submittable,
        features,
        tournamentRules: {
            engines: { required: [], excluded: excludedEngines },
            devices: { required: [], excluded: excludedDevices },
        },
    };
}

interface RenderOpts {
    target?: Partial<SubmissionTarget>;
    /** Response body for `/api/submit/platforms`. Omit `fail` to succeed with this body. */
    platformsResponse?: object;
    /** When true, the platforms fetch rejects (simulates a network failure). */
    fail?: boolean;
    /** Body for the score POST (`/submit-score/...`) — identity P2's `claimOffer` lives here. */
    submitResponse?: object;
    /** Body + status for the identity-claim POST (`/identity/claims`). */
    claimResponse?: { ok?: boolean; body?: object };
}

function renderSheet(opts: RenderOpts = {}) {
    const target: SubmissionTarget = {
        kind: 'tournament',
        roomId: 'room-1',
        gameName: 'Attack from Mars',
        ...opts.target,
    } as SubmissionTarget;

    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
        if (url.startsWith('/api/submit/platforms')) {
            if (opts.fail) return Promise.reject(new Error('network failure'));
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(opts.platformsResponse ?? {}),
            });
        }
        if (url.includes('/identity/claims')) {
            const claim = opts.claimResponse ?? {};
            return Promise.resolve({
                ok: claim.ok ?? true,
                status: claim.ok === false ? 409 : 200,
                json: () => Promise.resolve(claim.body ?? {}),
            });
        }
        if (url.includes('/submit-score/')) {
            return Promise.resolve({
                ok: true,
                status: 201,
                json: () => Promise.resolve(opts.submitResponse ?? {}),
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const rendered = render(
        <MemoryRouter>
            <ViewerAuthProvider>
                <SubmissionSheet target={target} onClose={() => {}} roomSlug="room-1" />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
    return { ...rendered, fetchMock };
}

describe('SubmissionSheet — engine/device derivation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('v2.95.1 regression: a remembered device the tournament EXCLUDES is not shown or held', async () => {
        signIn();
        localStorage.setItem('arcaid_last_device', 'atgames');
        renderSheet({
            platformsResponse: platformsPayload({
                submittable: ['vpx'],
                excludedDevices: ['atgames'],
            }),
        });

        // Engine auto-locks (single engine 'vpx') — the device <select> is the
        // only combobox left once that settles.
        await screen.findByText('Visual Pinball X');
        const select = await screen.findByRole('combobox') as HTMLSelectElement;

        // The remembered value must NOT be selected — pre-fix this held
        // 'atgames' even though the option list (rightly) excludes it.
        await waitFor(() => expect(select.value).not.toBe('atgames'));
        expect(select.value).toBe('');
        expect(screen.queryByRole('option', { name: 'AtGames Cabinet' })).not.toBeInTheDocument();
        // The other, non-excluded devices are still offered.
        expect(screen.getByRole('option', { name: 'PC' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'VR Headset' })).toBeInTheDocument();
    });

    it('restores a remembered device that IS allowed', async () => {
        signIn();
        localStorage.setItem('arcaid_last_device', 'pc');
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx'] }),
        });

        await screen.findByText('Visual Pinball X');
        const select = await screen.findByRole('combobox') as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('pc'));
    });

    /**
     * Engine memory (owner request 2026-08-30). Device has been remembered
     * globally since v2.53.0; engine was never remembered at all, so a player
     * on a multi-engine table re-answered "what produced this score" every
     * time. Same exclusion-filtered option list as the device rule — the
     * v2.95.1 regression above is exactly what a raw membership test
     * reintroduces.
     */
    it('restores a remembered ENGINE when the game offers more than one', async () => {
        signIn();
        localStorage.setItem('arcaid_last_engine', 'fx');
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx', 'fx'] }),
        });

        // Two engines → an engine <select> renders; it is the first combobox.
        const selects = await screen.findAllByRole('combobox');
        await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('fx'));
    });

    it('does NOT restore a remembered engine the tournament excludes', async () => {
        signIn();
        localStorage.setItem('arcaid_last_engine', 'fx');
        renderSheet({
            platformsResponse: platformsPayload({
                platforms: ['vpx', 'fx', 'fp'],
                submittable: ['vpx', 'fp'],
                excludedEngines: ['fx'],
            }),
        });

        const selects = await screen.findAllByRole('combobox');
        await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe(''));
        expect(screen.queryByRole('option', { name: 'Pinball FX' })).not.toBeInTheDocument();
    });

    it('a per-game choice outranks the global one', async () => {
        signIn();
        localStorage.setItem('arcaid_last_engine', 'fx');
        localStorage.setItem('arcaid_last_device', 'pc');
        localStorage.setItem(
            'arcaid_last_provenance:room-1:attack from mars',
            JSON.stringify({ engine: 'vpx', device: 'atgames' }),
        );
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx', 'fx'] }),
        });

        const selects = await screen.findAllByRole('combobox');
        await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('vpx'));
        await waitFor(() => expect((selects[1] as HTMLSelectElement).value).toBe('atgames'));
    });

    it('falls back to the global memory for a game with no per-game record', async () => {
        signIn();
        localStorage.setItem('arcaid_last_engine', 'fx');
        localStorage.setItem(
            'arcaid_last_provenance:room-1:some other table',
            JSON.stringify({ engine: 'vpx' }),
        );
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx', 'fx'] }),
        });

        const selects = await screen.findAllByRole('combobox');
        await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('fx'));
    });

    it('ignores a corrupt per-game record instead of throwing', async () => {
        signIn();
        localStorage.setItem('arcaid_last_engine', 'fx');
        localStorage.setItem('arcaid_last_provenance:room-1:attack from mars', 'not json');
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx', 'fx'] }),
        });

        const selects = await screen.findAllByRole('combobox');
        await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('fx'));
    });

    it('single-engine payload auto-locks the engine to a read-only chip', async () => {
        signIn();
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['vpx'] }),
        });

        expect(await screen.findByText('Visual Pinball X')).toBeInTheDocument();
        expect(screen.getByText('(the only one for this game)')).toBeInTheDocument();
        // No engine dropdown — the chip replaces it.
        expect(screen.queryByText('Choose what you played…')).not.toBeInTheDocument();
    });

    it('single allowed device auto-selects (no dropdown needed)', async () => {
        signIn();
        // engine 'real' → ENGINE_DEVICE_COMPAT.real === ['real_cabinet'] only.
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });

        expect(await screen.findByText('Real Cabinet')).toBeInTheDocument();
        expect(screen.getByText('(the only device that runs it)')).toBeInTheDocument();
        expect(screen.queryByText('Choose the device you played on…')).not.toBeInTheDocument();
    });

    it('survives a platforms-fetch failure without crashing — empty-safe engine/device lists', async () => {
        signIn();
        renderSheet({ fail: true });

        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(await screen.findByText(/Nothing is configured for this game yet/)).toBeInTheDocument();
        // Device section never renders when there are no engine options.
        expect(screen.queryByText('Device')).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
});

/**
 * Identity P2 — the success card offers an unclaimed iScored name when the
 * submit response says the recorded name already carries synced scores in the
 * room. Accepting files a claim; "Not me" is remembered per room + name so the
 * prompt never nags on later submissions.
 */
describe('SubmissionSheet — identity claim offer (P2)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    const OFFER = { iscoredUsername: 'ChalataLove', syncScoreCount: 4 };

    /** Fills the form and submits — engine/device auto-lock on a `real` payload. */
    async function submitScore() {
        await screen.findByText('Real Cabinet');
        fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '4200' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));
    }

    function renderWithOffer(opts: Omit<RenderOpts, 'platformsResponse' | 'submitResponse'> = {}) {
        return renderSheet({
            ...opts,
            platformsResponse: platformsPayload({ submittable: ['real'] }),
            submitResponse: { displayName: 'ChalataLove', claimOffer: OFFER },
        });
    }

    it('prompts with the synced name when the submit response carries an offer', async () => {
        signIn();
        renderWithOffer();
        await submitScore();

        expect(await screen.findByText(/There are already scores here under/)).toBeInTheDocument();
        expect(screen.getByText('ChalataLove')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Yes — link it to my account/ })).toBeInTheDocument();
    });

    it('no prompt when the response carries no offer', async () => {
        signIn();
        renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
            submitResponse: { displayName: 'Tester', claimOffer: null },
        });
        await submitScore();

        expect(await screen.findByText('Score submitted!')).toBeInTheDocument();
        expect(screen.queryByText(/There are already scores here under/)).not.toBeInTheDocument();
    });

    it('"Yes" posts the claim and reports the auto-approval', async () => {
        signIn();
        const { fetchMock } = renderWithOffer({
            claimResponse: { body: { result: 'auto_approved', matchedOn: 'your account username' } },
        });
        await submitScore();

        fireEvent.click(await screen.findByRole('button', { name: /Yes — link it to my account/ }));

        expect(await screen.findByText('Linked — that matched your account username.')).toBeInTheDocument();
        const claimCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/identity/claims'));
        expect(claimCall).toBeTruthy();
        expect(String(claimCall![0])).toBe('/api/rooms/room-1/identity/claims');
        const init = claimCall![1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ iscoredUsername: 'ChalataLove' });
    });

    it('a refused claim shows the server message', async () => {
        signIn();
        renderWithOffer({ claimResponse: { ok: false, body: { error: 'That name is already linked to another account.' } } });
        await submitScore();

        fireEvent.click(await screen.findByRole('button', { name: /Yes — link it to my account/ }));

        expect(await screen.findByText('That name is already linked to another account.')).toBeInTheDocument();
    });

    it('"Not me" hides the prompt and remembers the refusal', async () => {
        signIn();
        renderWithOffer();
        await submitScore();

        fireEvent.click(await screen.findByRole('button', { name: 'Not me' }));

        await waitFor(() =>
            expect(screen.queryByText(/There are already scores here under/)).not.toBeInTheDocument());
        expect(localStorage.getItem('arcaid_claim_offer_dismissed:room-1:chalatalove')).toBeTruthy();
    });

    it('a previously dismissed name never prompts again', async () => {
        signIn();
        localStorage.setItem('arcaid_claim_offer_dismissed:room-1:chalatalove', new Date().toISOString());
        renderWithOffer();
        await submitScore();

        expect(await screen.findByText('Score submitted!')).toBeInTheDocument();
        expect(screen.queryByText(/There are already scores here under/)).not.toBeInTheDocument();
    });
});

/**
 * Owner field report (2026-08-11) — unsupported photo formats (e.g. an
 * iPhone's `image/heic` camera default) attempt a client-side JPEG re-encode
 * via `lib/photoNormalize.ts`'s `normalizePhotoFile`. jsdom has no real
 * `<canvas>`, so these tests mock `normalizePhotoFile` itself rather than
 * exercising the real conversion — the module's own test file
 * (`lib/__tests__/photoNormalize.test.ts`) covers the decision logic, and this
 * covers the component wiring: success sets the preview, failure shows the
 * inline error and leaves no file selected.
 */
describe('SubmissionSheet — photo format handling', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    function selectPhoto(container: HTMLElement, file: File) {
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [file] } });
        return input;
    }

    it('a successfully-normalized photo sets the preview (no error shown)', async () => {
        signIn();
        const jpeg = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
        vi.spyOn(photoNormalize, 'normalizePhotoFile').mockResolvedValue(jpeg);
        const { container } = renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });
        await screen.findByText('Real Cabinet');

        selectPhoto(container, new File(['x'], 'IMG_0001.heic', { type: 'image/heic' }));

        await screen.findByAltText('Score photo');
        expect(screen.queryByText(/format isn't supported/i)).not.toBeInTheDocument();
    });

    it('a photo that fails normalization shows the inline unsupported-format error, not a preview', async () => {
        signIn();
        vi.spyOn(photoNormalize, 'normalizePhotoFile').mockResolvedValue(null);
        const { container } = renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
        });
        await screen.findByText('Real Cabinet');

        selectPhoto(container, new File(['x'], 'IMG_0002.heic', { type: 'image/heic' }));

        expect(await screen.findByText("That photo format isn't supported — please use a PNG or JPEG.")).toBeInTheDocument();
        expect(screen.queryByAltText('Score photo')).not.toBeInTheDocument();
    });
});

/**
 * v2.155.1 — a `tournament` target carrying `gameId` (the card the player is
 * actually looking at) threads it onto the POST, so the server's
 * `SubmissionGameResolver` can skip the name lookup entirely instead of
 * risking a room's ambiguous-active-games case. A target with no `gameId`
 * (older callers) must NOT send the field at all.
 */
describe('SubmissionSheet — gameId threading (v2.155.1)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    async function submitScore() {
        await screen.findByText('Real Cabinet');
        fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '4200' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));
    }

    it('sends gameId in the FormData when the target carries one', async () => {
        signIn();
        const { fetchMock } = renderSheet({
            target: { gameId: 'game-123' },
            platformsResponse: platformsPayload({ submittable: ['real'] }),
            submitResponse: { displayName: 'Tester', claimOffer: null },
        });
        await submitScore();

        await screen.findByText('Score submitted!');
        const submitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/submit-score/'));
        expect(submitCall).toBeTruthy();
        const body = submitCall![1]!.body as FormData;
        expect(body.get('gameId')).toBe('game-123');
    });

    it('omits gameId entirely when the target has none', async () => {
        signIn();
        const { fetchMock } = renderSheet({
            platformsResponse: platformsPayload({ submittable: ['real'] }),
            submitResponse: { displayName: 'Tester', claimOffer: null },
        });
        await submitScore();

        await screen.findByText('Score submitted!');
        const submitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/submit-score/'));
        expect(submitCall).toBeTruthy();
        const body = submitCall![1]!.body as FormData;
        expect(body.get('gameId')).toBeNull();
    });
});
