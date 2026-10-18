import { describe, it, expect } from 'vitest';
import { defaultSeasonState, getSeasonErrors, seasonPayload, seasonStateFromRow } from '../seasonForm';

/** A Season is the bound only as of v2.162.0 (ADR 0026) — the poll lives in pollForm. */

describe('getSeasonErrors', () => {
  const on = { ...defaultSeasonState, enabled: true };

  it('is empty for the defaults and for a season that is off', () => {
    expect(getSeasonErrors(on)).toEqual([]);
    expect(getSeasonErrors({ ...on, enabled: false, tableCount: 0 })).toEqual([]);
  });

  it('checks only the table count (1..200)', () => {
    expect(getSeasonErrors({ ...on, tableCount: 0 })).toHaveLength(1);
    expect(getSeasonErrors({ ...on, tableCount: 201 })).toHaveLength(1);
    expect(getSeasonErrors({ ...on, tableCount: 200 })).toEqual([]);
  });
});

describe('seasonPayload', () => {
  it('sends null to switch a season off', () => {
    expect(seasonPayload(defaultSeasonState)).toEqual({ season_table_count: null });
  });

  it('sends only the table count when on — no poll keys', () => {
    expect(seasonPayload({ enabled: true, tableCount: 8 })).toEqual({ season_table_count: 8 });
  });
});

describe('seasonStateFromRow', () => {
  it('reads the table count', () => {
    expect(seasonStateFromRow({ season_table_count: 8 })).toEqual({ enabled: true, tableCount: 8 });
    expect(seasonStateFromRow({})).toEqual(defaultSeasonState);
  });
});
