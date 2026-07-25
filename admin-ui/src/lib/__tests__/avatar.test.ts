import { describe, it, expect } from 'vitest';
import { resolveAvatarUrl } from '../avatar';

// v2.35.0 (Google login) — the BE/JWT `avatar` contract: Discord users carry
// a bare avatar hash (CDN template), Google users carry a full picture URL.
// This helper disambiguates by `startsWith('http')`.
describe('resolveAvatarUrl', () => {
  it('returns a full URL as-is (Google avatar)', () => {
    expect(resolveAvatarUrl('google:123', 'https://lh3.googleusercontent.com/pic.jpg')).toBe(
      'https://lh3.googleusercontent.com/pic.jpg',
    );
  });

  it('builds the Discord CDN template for a hash + discord id', () => {
    expect(resolveAvatarUrl('123456789012345678', 'abc123hash')).toBe(
      'https://cdn.discordapp.com/avatars/123456789012345678/abc123hash.png',
    );
  });

  it('returns null when avatar is null/undefined', () => {
    expect(resolveAvatarUrl('123456789012345678', null)).toBeNull();
    expect(resolveAvatarUrl('123456789012345678', undefined)).toBeNull();
    expect(resolveAvatarUrl(null, null)).toBeNull();
  });

  it('returns null for a hash with no userId to build the CDN URL from', () => {
    expect(resolveAvatarUrl(null, 'abc123hash')).toBeNull();
    expect(resolveAvatarUrl(undefined, 'abc123hash')).toBeNull();
  });

  it('returns null for an empty-string avatar', () => {
    expect(resolveAvatarUrl('123456789012345678', '')).toBeNull();
  });
});
