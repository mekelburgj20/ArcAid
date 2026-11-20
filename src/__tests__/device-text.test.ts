import { describe, it, expect } from 'vitest';
import { decodeJsonEscapes, deviceNameParam, optionalDeviceNameParam } from '../utils/deviceText.js';

/** W113 — names a device read out of a launcher's JSON arrive with \uXXXX escapes still in them. */
describe('decodeJsonEscapes', () => {
    it('decodes the escapes Go writes for & < >', () => {
        expect(decodeJsonEscapes('Attack \\u0026 Revenge from Mars (Original 2015)'))
            .toBe('Attack & Revenge from Mars (Original 2015)');
        expect(decodeJsonEscapes('\\u003cbeta\\u003e')).toBe('<beta>');
    });

    it('decodes either case of hex digit', () => {
        expect(decodeJsonEscapes('Caf\\u00e9 / Caf\\u00E9')).toBe('Café / Café');
    });

    it('turns a surrogate pair into its one character', () => {
        expect(decodeJsonEscapes('Pinball \\ud83c\\udfb1')).toBe('Pinball 🎱');
    });

    it('leaves a name with no escape untouched', () => {
        const name = 'Addams Family, JP\'s (Bally 1992)';
        expect(decodeJsonEscapes(name)).toBe(name);
    });

    it('leaves a backslash that is not a full \\uXXXX escape alone', () => {
        expect(decodeJsonEscapes('C:\\tables\\u12')).toBe('C:\\tables\\u12');
        expect(decodeJsonEscapes('a\\uZZZZb')).toBe('a\\uZZZZb');
    });
});

describe('device name params', () => {
    it('decodes a string and treats anything else as absent', () => {
        expect(deviceNameParam('A \\u0026 B')).toBe('A & B');
        expect(deviceNameParam(undefined)).toBe('');
        expect(deviceNameParam(['A', 'B'])).toBe('');
        expect(optionalDeviceNameParam('x \\u0026 y')).toBe('x & y');
        expect(optionalDeviceNameParam(undefined)).toBeNull();
    });
});
