#!/usr/bin/env node
// Guards the size of the agent instruction files.
//
// CLAUDE.md loads into every Claude Code session, so every character costs attention on every
// task; the docs target is under 200 lines. Path-scoped rule files under .claude/rules/ load only
// when a matching file is touched, but Claude Code truncates a rule file above 40,000 characters
// (the model then sees only the start plus a note). This check fails the build before either
// limit is crossed. Rationale and the split map: CHANGELOG v2.217.2.
//
// Usage: node tools/docs-budget.mjs        (exit 1 on any violation)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const LIMITS = {
  claudeMd: { chars: 40_000, lines: 200 },
  rule: { chars: 40_000 },
  // A rule file must declare which files load it; an unscoped rule loads at launch like CLAUDE.md.
  requirePaths: true,
};

const failures = [];
const rows = [];

function chars(text) {
  return [...text].length; // code points, what `wc -m` counts
}

function check(file, text, { maxChars, maxLines, needPaths }) {
  const c = chars(text);
  const l = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  rows.push({ file: relative(root, file).replace(/\\/g, '/'), chars: c, lines: l });
  if (c > maxChars) failures.push(`${relative(root, file)}: ${c} chars (limit ${maxChars})`);
  if (maxLines && l > maxLines) failures.push(`${relative(root, file)}: ${l} lines (limit ${maxLines})`);
  if (needPaths && !/^---\n[\s\S]*?\bpaths:\s*[\s\S]*?\n---\n/.test(text)) {
    failures.push(`${relative(root, file)}: missing a \`paths:\` frontmatter block (an unscoped rule loads on every task)`);
  }
}

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const claudeMd = join(root, 'CLAUDE.md');
check(claudeMd, readFileSync(claudeMd, 'utf8'), {
  maxChars: LIMITS.claudeMd.chars,
  maxLines: LIMITS.claudeMd.lines,
});

const rulesDir = join(root, '.claude', 'rules');
let ruleFiles = [];
try {
  ruleFiles = walk(rulesDir);
} catch {
  /* no rules directory: nothing to check */
}
for (const f of ruleFiles) {
  check(f, readFileSync(f, 'utf8'), { maxChars: LIMITS.rule.chars, needPaths: LIMITS.requirePaths });
}

const width = Math.max(...rows.map((r) => r.file.length));
for (const r of rows) {
  console.log(`${r.file.padEnd(width)}  ${String(r.chars).padStart(6)} chars  ${String(r.lines).padStart(4)} lines`);
}

if (failures.length) {
  console.error('\ndocs budget exceeded:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nMove domain detail into the matching .claude/rules/<domain>.md (or split a rule file); CLAUDE.md keeps only cross-cutting invariants, the map and owner rulings.',
  );
  process.exit(1);
}
console.log('\ndocs budget OK');
