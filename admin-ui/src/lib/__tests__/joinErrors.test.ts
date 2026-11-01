import { describe, it, expect } from 'vitest';
import { joinErrorMessage, isJoinErrorCode } from '../joinErrors';
import { parseRoleIdsValue, serializeRoleIds } from '../joinRoleIds';

describe('joinErrorMessage (v2.213.0)', () => {
  it('prefers the server message, falls back per code', () => {
    expect(joinErrorMessage('ROLE_REQUIRED', 'Only "VPX" can join.')).toBe('Only "VPX" can join.');
    expect(joinErrorMessage('JOIN_REQUIRED')).toMatch(/Join the room first/);
    expect(joinErrorMessage('DISCORD_LINK_REQUIRED')).toMatch(/Link your Discord/);
    expect(joinErrorMessage('SOMETHING_ELSE')).toMatch(/Could not join/);
    expect(isJoinErrorCode('ROLE_REQUIRED')).toBe(true);
    expect(isJoinErrorCode('nope')).toBe(false);
  });
});

describe('DISCORD_JOIN_ROLE_IDS value helpers', () => {
  it('round-trips and stores empty as blank', () => {
    expect(serializeRoleIds([])).toBe('');
    expect(serializeRoleIds(['123456789012345678', 'junk', '123456789012345678'])).toBe('["123456789012345678"]');
    expect(parseRoleIdsValue('["123456789012345678"]')).toEqual(['123456789012345678']);
    expect(parseRoleIdsValue('')).toEqual([]);
    expect(parseRoleIdsValue('bad')).toEqual([]);
  });
});
