import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * RA on-demand import §1 — console map, client transport, key scrubbing.
 *
 * The client cannot be exercised against the live API (no key in CI, and RA
 * fair-use forbids a test suite hammering it), so `fetch` is stubbed with
 * fixture bodies built from the field lists the contract documents. The
 * guards under test are the ones that matter when a real response deviates:
 * junk rows dropped, both leaderboard envelope shapes accepted, a non-JSON
 * 200 turned into an actionable message instead of a SyntaxError.
 */

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() };
});
import { logWarn, logInfo, logError } from '../utils/logger.js';

import { RAApiClient, scrubRaSecrets, RA_MEDIA_BASE } from '../services/RAApiClient.js';
import {
    RA_CONSOLE_ENGINE_MAP, raCatalogueType, CANONICAL_ENGINES, isCanonicalEngine,
} from '../utils/scoreProvenance.js';

const TEST_KEY = 'sUpErSeCrEtRaKeY123';

/** Fixture rows, field-for-field per the contract's documented shapes. */
const GAME_LIST_FIXTURE = [
    {
        ID: 1447, Title: 'Donkey Kong', ConsoleID: 7, ConsoleName: 'NES/Famicom',
        ImageIcon: '/Images/060003.png', NumAchievements: 20, NumLeaderboards: 4,
        DateModified: '2026-01-05 12:00:00',
    },
    {
        ID: 1448, Title: 'Super Mario Bros.', ConsoleID: 7, ConsoleName: 'NES/Famicom',
        ImageIcon: '/Images/060004.png', NumAchievements: 60, NumLeaderboards: 0,
        DateModified: '2026-02-05 12:00:00',
    },
];

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function textResponse(body: string, status = 200, retryAfter?: string) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
        text: async () => body,
    } as unknown as Response;
}

describe('RA console → engine map (contract §1)', () => {
    it('maps only consoles whose engine already exists in the taxonomy', () => {
        for (const [id, engine] of Object.entries(RA_CONSOLE_ENGINE_MAP)) {
            expect(isCanonicalEngine(engine), `console ${id} → "${engine}"`).toBe(true);
            expect(CANONICAL_ENGINES[engine], `console ${id}`).toBeDefined();
        }
    });

    it('covers the 20 consoles the contract lists, and no pseudo-consoles', () => {
        const ids = Object.keys(RA_CONSOLE_ENGINE_MAP).map(Number).sort((a, b) => a - b);
        expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 15, 17, 21, 25, 27, 39, 40, 43, 51]);
        // 100 Hubs / 101 Events / 102 Standalone are not hardware.
        for (const pseudo of [100, 101, 102]) {
            expect(RA_CONSOLE_ENGINE_MAP[pseudo], `pseudo console ${pseudo}`).toBeUndefined();
        }
    });

    it('maps each console to the engine the contract names', () => {
        expect(RA_CONSOLE_ENGINE_MAP[1]).toBe('genesis');
        expect(RA_CONSOLE_ENGINE_MAP[7]).toBe('nes');
        expect(RA_CONSOLE_ENGINE_MAP[12]).toBe('ps1');
        expect(RA_CONSOLE_ENGINE_MAP[27]).toBe('arcade');
        expect(RA_CONSOLE_ENGINE_MAP[43]).toBe('3do');
        expect(RA_CONSOLE_ENGINE_MAP[51]).toBe('atari_7800');
    });

    it('files arcade under type=arcade and every other console under video_game/console', () => {
        expect(raCatalogueType(27)).toEqual({ type: 'arcade', subtype: 'arcade' });
        for (const idStr of Object.keys(RA_CONSOLE_ENGINE_MAP)) {
            const id = Number(idStr);
            if (id === 27) continue;
            expect(raCatalogueType(id), `console ${id}`)
                .toEqual({ type: 'video_game', subtype: 'console' });
        }
    });

    it('refuses to type an unmapped console rather than defaulting one', () => {
        // A default here would file, say, a PSP game as a console game and
        // nothing downstream would ever question it.
        for (const unmapped of [13, 16, 18, 41, 44, 100, 999]) {
            expect(raCatalogueType(unmapped), `console ${unmapped}`).toBeNull();
        }
    });
});

describe('RA API key scrubbing', () => {
    it('redacts the key in leading and trailing query positions', () => {
        expect(scrubRaSecrets(`https://x/API/a.php?y=${TEST_KEY}`))
            .toBe('https://x/API/a.php?y=[REDACTED]');
        expect(scrubRaSecrets(`https://x/API/a.php?i=7&f=1&y=${TEST_KEY}`))
            .toBe('https://x/API/a.php?i=7&f=1&y=[REDACTED]');
    });

    it('keeps every other parameter readable — a scrubbed log is still a log', () => {
        const out = scrubRaSecrets(`https://x/API/API_GetGameList.php?i=27&f=1&y=${TEST_KEY}`);
        expect(out).toContain('API_GetGameList.php');
        expect(out).toContain('i=27');
        expect(out).not.toContain(TEST_KEY);
    });

    it('redacts every occurrence, case-insensitively, and tolerates junk', () => {
        expect(scrubRaSecrets(`a?y=${TEST_KEY} b&Y=${TEST_KEY}`)).not.toContain(TEST_KEY);
        expect(scrubRaSecrets('')).toBe('');
        expect(scrubRaSecrets(null as unknown as string)).toBe('');
    });
});

describe('RAApiClient', () => {
    const originalKey = process.env.RA_API_KEY;
    const originalUser = process.env.RA_USERNAME;

    beforeEach(() => {
        process.env.RA_API_KEY = TEST_KEY;
        process.env.RA_USERNAME = 'arcaid_bot';
        vi.mocked(logWarn).mockClear();
        vi.mocked(logInfo).mockClear();
        vi.mocked(logError).mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (originalKey === undefined) delete process.env.RA_API_KEY;
        else process.env.RA_API_KEY = originalKey;
        if (originalUser === undefined) delete process.env.RA_USERNAME;
        else process.env.RA_USERNAME = originalUser;
    });

    it('refuses to construct without a key, with a message naming the setting', () => {
        delete process.env.RA_API_KEY;
        expect(RAApiClient.isConfigured()).toBe(false);
        expect(() => new RAApiClient()).toThrow(/RA_API_KEY is not configured/);
    });

    it('sends the key as ?y= and identifies itself in the User-Agent', async () => {
        const fetchMock = vi.fn(async () => jsonResponse(GAME_LIST_FIXTURE));
        vi.stubGlobal('fetch', fetchMock);

        await new RAApiClient().getGameList(7);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('API_GetGameList.php');
        expect(url).toContain('i=7');
        expect(url).toContain('f=1');
        expect(url).toContain(`y=${TEST_KEY}`);
        expect((init.headers as Record<string, string>)['User-Agent']).toContain('arcaid_bot');
    });

    it('never lets the raw key reach the logger, on any path', async () => {
        // Retry warning, then a hard failure — the two paths that quote the
        // response and the error, i.e. the two most likely to carry the URL.
        vi.stubGlobal('fetch', vi.fn(async () => textResponse('slow down', 429)));

        await expect(new RAApiClient().getGameList(7)).rejects.toThrow();

        const logged = [
            ...vi.mocked(logWarn).mock.calls,
            ...vi.mocked(logInfo).mock.calls,
            ...vi.mocked(logError).mock.calls,
        ].flat().map(a => (typeof a === 'string' ? a : JSON.stringify(a ?? ''))).join(' | ');
        expect(logged.length).toBeGreaterThan(0);
        expect(logged).not.toContain(TEST_KEY);
    });

    it('keeps the key out of the thrown error too', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => textResponse('Invalid API Key', 200)));
        await expect(new RAApiClient().getGameExtended(1447)).rejects.toThrow(
            /non-JSON body .*API key is probably invalid/s,
        );
        await new RAApiClient().getGameExtended(1447).catch((err: Error) => {
            expect(err.message).not.toContain(TEST_KEY);
            expect(err.message).toContain('[REDACTED]');
        });
    });

    it('retries a 429 once and then succeeds', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            call++;
            return call === 1
                ? textResponse('rate limited', 429, '0')
                : jsonResponse(GAME_LIST_FIXTURE);
        }));

        const rows = await new RAApiClient().getGameList(7);
        expect(call).toBe(2);
        expect(rows).toHaveLength(2);
    });

    it('does not retry a 404 — a missing game is not transient', async () => {
        const fetchMock = vi.fn(async () => textResponse('not found', 404));
        vi.stubGlobal('fetch', fetchMock);
        await expect(new RAApiClient().getGameList(7)).rejects.toThrow(/returned 404/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('drops game-list rows with no id or no title rather than passing them on', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
            ...GAME_LIST_FIXTURE,
            { Title: 'No id here', ConsoleID: 7 },
            { ID: 99, ConsoleID: 7 },
            null,
            'garbage',
        ])));

        const rows = await new RAApiClient().getGameList(7);
        expect(rows.map(r => r.ID)).toEqual([1447, 1448]);
        expect(rows[0].NumLeaderboards).toBe(4);
        expect(rows[0].DateModified).toBe('2026-01-05 12:00:00');
    });

    it('defaults a row\'s ConsoleID to the console it was requested for', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ ID: 5, Title: 'X' }])));
        const rows = await new RAApiClient().getGameList(27);
        expect(rows[0].ConsoleID).toBe(27);
    });

    it('turns EMPTY metadata strings into null so the catalogue stores honest NULLs', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            ID: 1447, Title: 'Donkey Kong', ConsoleID: 7, ConsoleName: 'NES/Famicom',
            Publisher: '', Developer: '   ', Genre: 'Platformer', Released: '1986-06-01',
            ImageIcon: '/Images/060003.png', ImageBoxArt: '/Images/060005.png',
            ImageTitle: '', ImageIngame: null,
        })));

        const game = await new RAApiClient().getGameExtended(1447);
        expect(game).not.toBeNull();
        expect(game!.Publisher).toBeNull();
        expect(game!.Developer).toBeNull();
        expect(game!.Genre).toBe('Platformer');
        expect(game!.ImageBoxArt).toBe('/Images/060005.png');
    });

    it('treats RA\'s null-id answer for an unknown game as "no such game"', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ID: null, Title: null })));
        expect(await new RAApiClient().getGameExtended(999999)).toBeNull();
    });

    it('accepts both leaderboard envelope shapes', async () => {
        const boards = [
            { ID: 1, RankAsc: false, Title: 'High Score', Description: 'Best score', Format: 'SCORE' },
            { ID: 2, RankAsc: true, Title: 'Fastest', Description: 'Any%', Format: 'TIME' },
        ];

        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ Count: 2, Total: 2, Results: boards })));
        const wrapped = await new RAApiClient().getGameLeaderboards(1447);
        expect(wrapped).toHaveLength(2);
        expect(wrapped[1].RankAsc).toBe(true);

        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(boards)));
        const flat = await new RAApiClient().getGameLeaderboards(1447);
        expect(flat).toHaveLength(2);
        expect(flat[0].Format).toBe('SCORE');
    });

    it('coerces RA\'s three spellings of RankAsc', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
            { ID: 1, RankAsc: true, Format: 'SCORE' },
            { ID: 2, RankAsc: 1, Format: 'SCORE' },
            { ID: 3, RankAsc: 'true', Format: 'SCORE' },
            { ID: 4, RankAsc: 0, Format: 'SCORE' },
            { ID: 5, RankAsc: 'false', Format: 'SCORE' },
            { ID: 6, Format: 'SCORE' },
        ])));

        const boards = await new RAApiClient().getGameLeaderboards(1447);
        expect(boards.map(b => b.RankAsc)).toEqual([true, true, true, false, false, false]);
    });

    it('pages leaderboards until the results run out', async () => {
        const page = (n: number) => Array.from({ length: n }, (_, i) => ({
            ID: i + 1, RankAsc: false, Format: 'SCORE', Title: `B${i}`,
        }));
        let call = 0;
        const fetchMock = vi.fn(async () => {
            call++;
            return jsonResponse(call === 1
                ? { Total: 700, Results: page(500) }
                : { Total: 700, Results: page(200) });
        });
        vi.stubGlobal('fetch', fetchMock);

        const boards = await new RAApiClient().getGameLeaderboards(1447);
        expect(boards).toHaveLength(700);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('o=500');
    });

    it('resolves site-relative image paths against the MEDIA host, not the API host', () => {
        expect(RAApiClient.mediaUrl('/Images/060003.png')).toBe(`${RA_MEDIA_BASE}/Images/060003.png`);
        expect(RAApiClient.mediaUrl('Images/060003.png')).toBe(`${RA_MEDIA_BASE}/Images/060003.png`);
        expect(RAApiClient.mediaUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
        expect(RAApiClient.mediaUrl('')).toBeNull();
        expect(RAApiClient.mediaUrl(null)).toBeNull();
    });
});
