import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * v2.124.0 (C3) — `StylePicker` is gone, and stays gone.
 *
 * It was the last card-art editor that previewed art in a 128px strip instead
 * of on a card, and the arc's whole point was that there is now exactly ONE
 * editor (`CardStyleEditor`) with two hosts: the admin Leaderboard's rail and
 * `CardStyleEditorSheet`. A resurrected StylePicker — or a new import of it
 * from a branch that still has the file — would silently re-open the divergence
 * this arc closed, so both facts are asserted rather than assumed:
 *
 *   1. the module does not resolve;
 *   2. nothing under `src/` imports it.
 *
 * `StyleUploadForm` deliberately outlives it: the editor uses that form.
 */

/** Vitest's cwd is the Vite project root (admin-ui); the second candidate
 *  covers a run launched from the repo root. */
const SRC = [
  resolve(process.cwd(), 'src'),
  resolve(process.cwd(), 'admin-ui/src'),
].find(existsSync)!;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('StylePicker retirement (C3)', () => {
  it('the module no longer resolves', async () => {
    // Built at runtime: a literal specifier would be a BUILD error (Vite
    // resolves imports statically), which is a louder but less useful failure
    // than the assertion below.
    const spec = ['..', 'components', 'StylePicker'].join('/');
    await expect(import(/* @vite-ignore */ spec)).rejects.toThrow();
    expect(existsSync(join(SRC, 'components/StylePicker.tsx'))).toBe(false);
  });

  it('nothing under src/ imports it', () => {
    const offenders = walk(SRC).filter(f =>
      /(?:from|import)\s*\(?\s*['"][^'"]*\/StylePicker['"]/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('StyleUploadForm survives — the editor uses it', () => {
    expect(existsSync(join(SRC, 'components/StyleUploadForm.tsx'))).toBe(true);
  });
});
