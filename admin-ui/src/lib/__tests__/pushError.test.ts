import { describe, it, expect } from 'vitest';
import { buildPushErrorMessage, isPushServiceAbortError } from '../pushError';

describe('isPushServiceAbortError', () => {
  it('true for a DOMException-like AbortError', () => {
    const err = new Error('Registration failed - push service error');
    err.name = 'AbortError';
    expect(isPushServiceAbortError(err)).toBe(true);
  });

  it('true for a message mentioning "push service" regardless of name', () => {
    expect(isPushServiceAbortError(new Error('the push service rejected the request'))).toBe(true);
  });

  it('false for unrelated errors', () => {
    expect(isPushServiceAbortError(new Error('The server rejected the subscription.'))).toBe(false);
    expect(isPushServiceAbortError(new Error('Browser returned an incomplete subscription.'))).toBe(false);
  });
});

describe('buildPushErrorMessage', () => {
  it('appends the Brave hint when permission is granted and it is a push-service-abort error', () => {
    const err = new Error('Registration failed - push service error');
    err.name = 'AbortError';
    const msg = buildPushErrorMessage(err, 'granted');
    expect(msg).toContain('Registration failed - push service error');
    expect(msg).toContain('brave://settings/privacy');
    expect(msg).toContain('Use Google services for push messaging');
  });

  it('does not append the hint when permission is not granted', () => {
    const err = new Error('Registration failed - push service error');
    err.name = 'AbortError';
    const msg = buildPushErrorMessage(err, 'denied');
    expect(msg).not.toContain('brave://');
  });

  it('does not append the hint for unrelated errors even when granted', () => {
    const msg = buildPushErrorMessage(new Error('The server rejected the subscription.'), 'granted');
    expect(msg).toBe('The server rejected the subscription.');
    expect(msg).not.toContain('brave://');
  });

  it('falls back to a generic message for non-Error throws', () => {
    expect(buildPushErrorMessage('some string throw', 'granted')).toBe('Something went wrong enabling push.');
  });
});
