import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Run recap types, BE/FE parity (B31, plan section 1). Everything after the
 * marker line must be identical on both sides (line endings normalised).
 */
const MARKER = '// ==== BODY (mirrored, keep identical) ====';

function body(path: string): string {
    const text = readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
    const at = text.indexOf(MARKER);
    expect(at, `${path}: marker missing`).toBeGreaterThan(-1);
    return text.slice(at);
}

describe('runRecap types parity', () => {
    it('has a byte-identical body on both sides', () => {
        expect(body('../types/runRecap.ts')).toEqual(body('../../admin-ui/src/lib/runRecapTypes.ts'));
    });

    it('is types only: no imports or runtime exports', () => {
        const text = body('../types/runRecap.ts');
        expect(text).not.toMatch(/^import /m);
        expect(text).not.toMatch(/^export (const|function|class|enum)/m);
    });
});
