import { describe, it, expect } from 'vitest';
import {
  applyFetchedVersion,
  initialUpdateNudgeState,
  shouldShowUpdateNudge,
} from '../updateNudge';

describe('applyFetchedVersion', () => {
  it('captures the first fetch as both baseline and latest', () => {
    const state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    expect(state).toEqual({ baseline: 'v2.90.0', latest: 'v2.90.0' });
  });

  it('moves latest on a later fetch without touching baseline', () => {
    const first = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    const second = applyFetchedVersion(first, 'v2.91.0');
    expect(second).toEqual({ baseline: 'v2.90.0', latest: 'v2.91.0' });
  });

  it('baseline stays pinned across repeated later fetches', () => {
    let state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    state = applyFetchedVersion(state, 'v2.91.0');
    state = applyFetchedVersion(state, 'v2.92.0');
    expect(state.baseline).toBe('v2.90.0');
    expect(state.latest).toBe('v2.92.0');
  });
});

describe('shouldShowUpdateNudge', () => {
  it('never fires before the first fetch resolves (both null)', () => {
    expect(shouldShowUpdateNudge(initialUpdateNudgeState, null)).toBe(false);
  });

  it('never fires on the very first load — baseline and latest match by construction', () => {
    const state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    expect(shouldShowUpdateNudge(state, null)).toBe(false);
  });

  it('fires once a later fetch reports a different version', () => {
    let state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    state = applyFetchedVersion(state, 'v2.91.0');
    expect(shouldShowUpdateNudge(state, null)).toBe(true);
  });

  it('stays hidden once the exact latest version has been dismissed', () => {
    let state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    state = applyFetchedVersion(state, 'v2.91.0');
    expect(shouldShowUpdateNudge(state, 'v2.91.0')).toBe(false);
  });

  it('re-fires when a newer version lands after a dismissal of an older one', () => {
    let state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    state = applyFetchedVersion(state, 'v2.91.0');
    // Dismissed 2.91.0...
    expect(shouldShowUpdateNudge(state, 'v2.91.0')).toBe(false);
    // ...but 2.92.0 ships before the tab reloads.
    state = applyFetchedVersion(state, 'v2.92.0');
    expect(shouldShowUpdateNudge(state, 'v2.91.0')).toBe(true);
  });

  it('a dismissal of a stale version does not suppress the current one', () => {
    let state = applyFetchedVersion(initialUpdateNudgeState, 'v2.90.0');
    state = applyFetchedVersion(state, 'v2.91.0');
    expect(shouldShowUpdateNudge(state, 'v2.80.0')).toBe(true);
  });
});
