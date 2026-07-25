import { describe, it, expect } from 'vitest';
import { requiresAnyLogin, requiresDiscordOnly } from '../loginPolicy';

// v2.35.0 (Google login) — REQUIRE_DISCORD_LOGIN 3-value domain helpers.
describe('requiresAnyLogin', () => {
  it('true for "true" and "discord"', () => {
    expect(requiresAnyLogin('true')).toBe(true);
    expect(requiresAnyLogin('discord')).toBe(true);
  });

  it('false for "false", undefined, null, or anything else', () => {
    expect(requiresAnyLogin('false')).toBe(false);
    expect(requiresAnyLogin(undefined)).toBe(false);
    expect(requiresAnyLogin(null)).toBe(false);
    expect(requiresAnyLogin('')).toBe(false);
  });
});

describe('requiresDiscordOnly', () => {
  it('true only for "discord"', () => {
    expect(requiresDiscordOnly('discord')).toBe(true);
  });

  it('false for "true", "false", undefined, null', () => {
    expect(requiresDiscordOnly('true')).toBe(false);
    expect(requiresDiscordOnly('false')).toBe(false);
    expect(requiresDiscordOnly(undefined)).toBe(false);
    expect(requiresDiscordOnly(null)).toBe(false);
  });
});
