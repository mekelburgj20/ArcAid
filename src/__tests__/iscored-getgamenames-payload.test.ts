import { describe, it, expect, vi, beforeEach } from 'vitest';

const warns: string[] = [];
vi.mock('../utils/logger.js', () => ({
    logInfo: () => {},
    logDebug: () => {},
    logError: () => {},
    logWarn: (msg: string) => { warns.push(msg); },
}));

import { parseGetGameNamesPayload } from '../utils/iscoredGameNames.js';

/**
 * Regression for the v2.117.1 hotfix. Exact body captured from prod on
 * 2026-08-20 via `settingsCommands.php?c=getGameNames` — capitalised
 * `GameID`/`GameName`, `tags` as a JSON-encoded string, `Hidden` null. The
 * original mapper read `gameID`/`gameName` and so returned [] for every row for
 * two months, silently "confirming" every delete and blanking Reconcile.
 */
const PROD_PAYLOAD = JSON.stringify([
    { GameID: 103966, GameName: 'Mask, The', GameLogo: null, ScoreType: null, tags: '["DG"]', Hidden: null, Locked: 'TRUE' },
    { GameID: 104039, GameName: 'Exoplanets', GameLogo: null, ScoreType: null, tags: '["DG"]', Hidden: null, Locked: 'TRUE' },
    { GameID: 105336, GameName: 'Bad Cats', GameLogo: null, ScoreType: null, tags: '["WG-VPXS","weekly"]', Hidden: 'TRUE', Locked: null },
]);

beforeEach(() => { warns.length = 0; });

describe('parseGetGameNamesPayload', () => {
    it('maps the live prod payload (capitalised fields, JSON-string tags)', () => {
        const rows = parseGetGameNamesPayload(PROD_PAYLOAD);
        expect(rows).toEqual([
            { id: '103966', name: 'Mask, The', hidden: false, locked: true, tags: ['DG'] },
            { id: '104039', name: 'Exoplanets', hidden: false, locked: true, tags: ['DG'] },
            { id: '105336', name: 'Bad Cats', hidden: true, locked: false, tags: ['WG-VPXS', 'weekly'] },
        ]);
        expect(warns).toEqual([]);
    });

    it('still accepts the lower-camel shape the original mapper assumed, with array tags', () => {
        const rows = parseGetGameNamesPayload(JSON.stringify([
            { gameID: '1', gameName: 'Old Shape', Hidden: 'FALSE', Locked: 'TRUE', tags: ['a', 'b'] },
        ]));
        expect(rows).toEqual([{ id: '1', name: 'Old Shape', hidden: false, locked: true, tags: ['a', 'b'] }]);
    });

    it('WARNs loudly when rows arrive but none carry a recognisable id (shape drift)', () => {
        const rows = parseGetGameNamesPayload(JSON.stringify([{ Identifier: 7, Title: 'Mystery' }]));
        expect(rows).toEqual([]);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatch(/1 row\(s\) but none carried a recognisable game id/);
        expect(warns[0]).toMatch(/Identifier, Title/);
    });

    it('returns [] quietly for an empty body and loudly for non-JSON / non-array bodies', () => {
        expect(parseGetGameNamesPayload('')).toEqual([]);
        expect(warns).toEqual([]);
        expect(parseGetGameNamesPayload('<html>login</html>')).toEqual([]);
        expect(parseGetGameNamesPayload('{"error":"nope"}')).toEqual([]);
        expect(warns).toHaveLength(2);
    });

    it('tolerates malformed or comma-separated tag strings', () => {
        const rows = parseGetGameNamesPayload(JSON.stringify([
            { GameID: 1, GameName: 'A', tags: 'DG, weekly' },
            { GameID: 2, GameName: 'B', tags: '[not json' },
            { GameID: 3, GameName: 'C', tags: '' },
            { GameID: 4, GameName: 'D' },
        ]));
        expect(rows.map((r) => r.tags)).toEqual([['DG', 'weekly'], ['[not json'], [], []]);
    });
});
