#!/usr/bin/env node
// work-board: parse WORK.md (the single live tracker), check it, summarise it, render the board.
//
//   node tools/work-board.mjs                 render tmp/work-board.html (self-contained page)
//   node tools/work-board.mjs --check         validate; exit 1 on errors (CI runs this)
//   node tools/work-board.mjs --summary       terminal view for /work
//   node tools/work-board.mjs --json          the parsed model
//   options: --file WORK.md  --out tmp/work-board.html  --repo owner/name  --branch main
//
// Zero dependencies. The parser below is also embedded verbatim in the rendered page, which re-parses
// a fresh WORK.md from raw.githubusercontent.com when the repo is public, so the board is live.
// Grammar: .claude/commands/work.md.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------- parser (shared with the page)
const PARSER_SOURCE = String.raw`
const STATUSES = ['idea', 'ready', 'claimed', 'blocked', 'review', 'done', 'parked'];
const ITEM_RE = /^(\s*)- \*\*([A-Z]{1,2}\d+(?:\.\d+)*)\*\* \x60([a-z]+)(?: ([^\x60]+))?\x60 ?(.*)$/;
const SECTION_RE = /^## ([A-Z]{1,2})\. (.+)$/;
const NOW_RE = /^## Now\s*$/;
const BOARD_RE = /^Board:\s*(\S+)/m;

function parseWork(text) {
  const lines = text.split(/\r?\n/);
  const model = { title: '', board: null, now: [], sections: [], items: [], errors: [], warnings: [] };
  const m = text.match(BOARD_RE);
  if (m && /^https?:\/\//.test(m[1])) model.board = m[1];
  let section = null, inNow = false, last = null, stack = [];
  const seen = new Map();
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!model.title && line.startsWith('# ')) { model.title = line.slice(2).trim(); return; }
    if (NOW_RE.test(line)) { inNow = true; section = null; last = null; return; }
    const sm = line.match(SECTION_RE);
    if (sm) {
      inNow = false; last = null; stack = [];
      section = { letter: sm[1], title: sm[2].trim(), lane: '', items: [], line: n };
      if (model.sections.some(s => s.letter === sm[1])) model.errors.push(n + ': duplicate section letter ' + sm[1]);
      model.sections.push(section);
      return;
    }
    if (line.startsWith('## ')) { inNow = false; section = null; last = null; return; }
    if (inNow) { if (line.startsWith('- ')) model.now.push(line.slice(2).trim()); return; }
    if (!section) return;
    if (/^Lane:/.test(line)) { section.lane = line.replace(/^Lane:\s*/, '').trim(); return; }
    const im = line.match(ITEM_RE);
    if (im) {
      const [, indent, id, status, qualifier, rest] = im;
      const item = { id, status, qualifier: qualifier || '', title: '', detail: '', fields: {}, notes: [], children: [], line: n, section: section.letter, depth: indent.length / 2 };
      if (!id.startsWith(section.letter) || !/^\d/.test(id.slice(section.letter.length))) model.errors.push(n + ': item ' + id + ' is under section ' + section.letter);
      if (!STATUSES.includes(status)) model.errors.push(n + ': ' + id + ' has unknown status "' + status + '"');
      if (seen.has(id)) model.errors.push(n + ': duplicate id ' + id + ' (also line ' + seen.get(id) + ')');
      seen.set(id, n);
      const parts = rest.split(' · ');
      const head = parts.shift() || '';
      const dash = head.indexOf(' — ');
      if (dash >= 0) { item.title = head.slice(0, dash).trim(); item.detail = head.slice(dash + 3).trim(); } else item.title = head.trim();
      for (const p of parts) {
        const km = p.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/);
        if (km) item.fields[km[1]] = km[2].trim(); else model.warnings.push(n + ': ' + id + ' has a field without "key: " (' + p.trim() + ')');
      }
      if (!item.title) model.errors.push(n + ': ' + id + ' has no title');
      if (status === 'claimed' && !(item.fields.owner && item.fields.since)) model.errors.push(n + ': ' + id + ' is claimed without owner and since');
      // nesting by indentation
      while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        if (!id.startsWith(parent.id + '.')) model.errors.push(n + ': sub-item ' + id + ' is nested under ' + parent.id + ' but its id does not start with ' + parent.id + '.');
        parent.children.push(item);
      } else {
        if (item.depth !== 0) model.errors.push(n + ': ' + id + ' is indented but has no parent item');
        section.items.push(item);
      }
      stack.push(item);
      model.items.push(item);
      last = item;
      return;
    }
    if (/^\s*- /.test(line)) { model.errors.push(n + ': bullet is not an item line (grammar: - **ID** ' + String.fromCharCode(96) + 'status' + String.fromCharCode(96) + ' Title)'); return; }
    if (/^\s{2,}\S/.test(line) && last) { last.notes.push(line.trim()); return; }
  });
  for (const it of model.items) {
    if (it.fields.needs) for (const dep of it.fields.needs.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!seen.has(dep)) model.errors.push(it.line + ': ' + it.id + ' needs ' + dep + ', which does not exist');
    }
    if (it.status === 'blocked' && it.qualifier && /^[A-Z]{1,2}\d/.test(it.qualifier) && !seen.has(it.qualifier.split(/[ ,]/)[0])) model.warnings.push(it.line + ': ' + it.id + ' is blocked on ' + it.qualifier + ', which is not an item');
  }
  for (const s of model.sections) if (!s.lane) model.warnings.push(s.line + ': section ' + s.letter + ' has no Lane: line');
  if (!model.now.length) model.warnings.push('no ## Now block');
  if (model.now.length > 12) model.warnings.push('## Now has ' + model.now.length + ' bullets (keep it to 12)');
  return model;
}
function daysSince(iso, now) { const t = Date.parse(iso); return isNaN(t) ? null : Math.floor(((now || Date.now()) - t) / 86400000); }
function staleClaims(model, now) { return model.items.filter(i => i.status === 'claimed' && (daysSince(i.fields.since, now) ?? 0) > 7); }
`;
const { parseWork, staleClaims, daysSince } = new Function(PARSER_SOURCE + '\nreturn { parseWork, staleClaims, daysSince };')();

// ---------------------------------------------------------------- cli
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes('--' + name);
const file = resolve(opt('file', 'WORK.md'));
const text = readFileSync(file, 'utf8');
const model = parseWork(text);

function guessRepo() {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}
const repo = opt('repo', guessRepo());
const branch = opt('branch', 'main');

if (has('json')) { console.log(JSON.stringify(model, null, 2)); process.exit(0); }

if (has('check')) {
  for (const w of model.warnings) console.warn('warning: ' + w);
  for (const e of model.errors) console.error('error: ' + e);
  const stale = staleClaims(model);
  for (const s of stale) console.warn('warning: ' + s.id + ' claimed by ' + s.fields.owner + ' since ' + s.fields.since + ' (' + daysSince(s.fields.since) + ' days; anyone may release it)');
  console.log((model.errors.length ? 'FAIL' : 'ok') + ': ' + model.items.length + ' items in ' + model.sections.length + ' sections, ' + model.errors.length + ' errors, ' + model.warnings.length + ' warnings');
  process.exit(model.errors.length ? 1 : 0);
}

if (has('summary')) {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(model.title + '\n');
  console.log('NOW'); for (const b of model.now) console.log('  - ' + b);
  const claimed = model.items.filter(i => i.status === 'claimed');
  console.log('\nCLAIMED (' + claimed.length + ')');
  for (const i of claimed) console.log('  ' + pad(i.id, 7) + pad(i.fields.owner || '?', 18) + 'since ' + (i.fields.since || '?') + (daysSince(i.fields.since) > 7 ? '  STALE' : '') + '  ' + i.title);
  const blocked = model.items.filter(i => i.status === 'blocked' || i.status === 'review');
  if (blocked.length) { console.log('\nBLOCKED / IN REVIEW'); for (const i of blocked) console.log('  ' + pad(i.id, 7) + pad(i.status + ' ' + i.qualifier, 18) + i.title); }
  console.log('\nREADY, by section');
  for (const s of model.sections) {
    const all = model.items.filter(i => i.section === s.letter);
    const ready = all.filter(i => i.status === 'ready');
    const counts = ['ready', 'claimed', 'blocked', 'review', 'idea', 'parked', 'done'].map(st => { const n = all.filter(i => i.status === st).length; return n ? n + ' ' + st : null; }).filter(Boolean).join(', ');
    console.log('  ' + s.letter + '. ' + s.title + '  (' + counts + ')');
    for (const i of ready) console.log('     ' + pad(i.id, 7) + (i.fields.tier ? 'T' + i.fields.tier + ' ' : '') + i.title + (i.fields.needs ? '  [needs ' + i.fields.needs + ']' : ''));
  }
  if (model.errors.length) { console.log('\nERRORS'); for (const e of model.errors) console.log('  ' + e); }
  process.exit(0);
}

// ---------------------------------------------------------------- html
const out = resolve(opt('out', 'tmp/work-board.html'));
const generatedAt = new Date().toISOString();
const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rawUrl = repo ? `https://raw.githubusercontent.com/${repo}/${branch}/WORK.md` : null;
const blobBase = repo ? `https://github.com/${repo}/blob/${branch}/` : null;

const html = `<title>${esc(model.title.replace(/ — Work$/, ''))} Work Board</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a flat operations board. One column of section ledgers; a sticky filter bar; IDs in mono as the
   primary handle because the owner addresses work by ID ("let's do B13.4"). */
:root {
  --bg: #f6f5f1; --panel: #ffffff; --fg: #1d1c19; --muted: #6b6861; --rule: #dedbd3;
  --accent: #b5491c; --accent-ink: #ffffff;
  --idea: #8a8477; --ready: #1f6f8b; --claimed: #b5491c; --blocked: #a1242b; --review: #7b4fa6; --done: #3a7d44; --parked: #9c8a5a;
  --chip-bg: #eeece6;
  --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #15161a; --panel: #1e2026; --fg: #ebe8e1; --muted: #9a978f; --rule: #2f323a;
  --accent: #e8794a; --accent-ink: #15161a;
  --idea: #8e8a82; --ready: #5fb3d0; --claimed: #e8794a; --blocked: #e06570; --review: #b58ee6; --done: #6fc27c; --parked: #c8b37a;
  --chip-bg: #2a2d35; color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #15161a; --panel: #1e2026; --fg: #ebe8e1; --muted: #9a978f; --rule: #2f323a;
  --accent: #e8794a; --accent-ink: #15161a;
  --idea: #8e8a82; --ready: #5fb3d0; --claimed: #e8794a; --blocked: #e06570; --review: #b58ee6; --done: #6fc27c; --parked: #c8b37a;
  --chip-bg: #2a2d35; color-scheme: dark;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 15px; line-height: 1.45;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 48px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
.wrap { max-width: 1080px; margin: 0 auto; min-width: 0; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px; padding-block: 24px 12px; }
h1 { font-size: 26px; font-weight: 600; margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
.src { font-size: 13px; color: var(--muted); }
.src a { color: inherit; }
.now { background: var(--panel); border: 1px solid var(--rule); border-left: 4px solid var(--accent); padding: 12px 16px; margin: 8px 0 20px; }
.now h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
.now ul { margin: 0; padding-left: 18px; }
.now li { margin: 2px 0; }
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--bg); padding-block: 8px; border-bottom: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.bar input { font: inherit; font-size: 14px; padding: 6px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); color: var(--fg); min-width: 0; flex: 1 1 180px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--rule); background: var(--chip-bg); color: var(--fg); cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.chip .n { color: inherit; opacity: 0.7; margin-left: 4px; font-variant-numeric: tabular-nums; }
section.sec { margin-top: 26px; }
section.sec > h2 { font-size: 18px; margin: 0 0 2px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
section.sec > h2 .letter { font-family: var(--mono); color: var(--accent); font-weight: 500; }
section.sec > h2 .counts { font-size: 12px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.lane { font-size: 13px; color: var(--muted); margin: 0 0 10px; overflow-wrap: anywhere; }
.lane code { font-family: var(--mono); font-size: 12px; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.items .items { margin: 6px 0 0 28px; }
.item { background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 8px 12px; display: grid; grid-template-columns: auto auto 1fr; gap: 4px 12px; align-items: start; min-width: 0; }
.item.s-done { opacity: 0.72; }
.id { font-family: var(--mono); font-size: 13px; font-weight: 500; cursor: pointer; border: none; background: none; color: var(--fg); padding: 2px 4px; border-radius: 4px; }
.id:hover, .id:focus-visible { background: var(--chip-bg); outline: 2px solid var(--accent); outline-offset: 0; }
.st { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 3px 7px; border-radius: 4px; color: var(--accent-ink); white-space: nowrap; align-self: center; }
.s-idea .st { background: var(--idea); } .s-ready .st { background: var(--ready); } .s-claimed .st { background: var(--claimed); }
.s-blocked .st { background: var(--blocked); } .s-review .st { background: var(--review); } .s-done .st { background: var(--done); } .s-parked .st { background: var(--parked); }
.body { min-width: 0; }
.title { font-weight: 500; overflow-wrap: anywhere; }
.detail { color: var(--muted); overflow-wrap: anywhere; }
.fields { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: 12px; color: var(--muted); }
.fields span b { font-weight: 500; color: var(--fg); }
.fields .k-owner b, .fields .k-since b { color: var(--claimed); }
.fields a { color: var(--ready); }
.fields code { font-family: var(--mono); font-size: 12px; }
.notes { font-size: 13px; color: var(--muted); margin: 4px 0 0; padding-left: 16px; }
.status-msg { font-size: 12px; color: var(--muted); }
.ok { color: var(--done); } .err { color: var(--blocked); }
.problems { background: var(--panel); border: 1px solid var(--blocked); padding: 10px 14px; margin: 12px 0; font-size: 13px; }
.toast { position: fixed; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 6px; font-size: 13px; }
.hidden { display: none !important; }
@media (max-width: 520px) { .item { grid-template-columns: auto 1fr; } .item .body { grid-column: 1 / -1; } }
@media (prefers-reduced-motion: no-preference) { .item { transition: opacity 120ms; } }
</style>
<div class="wrap">
  <header>
    <h1 id="h1">${esc(model.title)}</h1>
    <div class="src" id="src">snapshot generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC${rawUrl ? ` · <a href="${esc(blobBase + 'WORK.md')}" target="_blank" rel="noopener">WORK.md on GitHub</a>` : ''} · <span id="live" class="status-msg">checking GitHub for a newer copy…</span></div>
  </header>
  <div id="problems" class="problems hidden"></div>
  <div class="now" id="now"><h2>Now</h2><ul id="nowlist"></ul></div>
  <div class="bar">
    <input id="q" type="search" placeholder="Search id, title, owner, spec…" aria-label="Search items">
    <div class="chips" id="chips"></div>
  </div>
  <div id="sections"></div>
</div>
<script>
${PARSER_SOURCE}
const SNAPSHOT = ${JSON.stringify(text)};
const RAW_URL = ${JSON.stringify(rawUrl)};
const BLOB_BASE = ${JSON.stringify(blobBase)};
const ORDER = ['claimed', 'review', 'blocked', 'ready', 'idea', 'parked', 'done'];
let model = parseWork(SNAPSHOT);
let active = new Set(ORDER.filter(s => s !== 'done'));
let query = '';
try { const s = JSON.parse(localStorage.getItem('wb.filters') || 'null'); if (Array.isArray(s)) active = new Set(s); } catch {}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) { return esc(s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>'); }
function specLink(v) {
  const m = v.match(/^([\\w./-]+\\.md)(.*)$/);
  if (m && BLOB_BASE && !/^https?:/.test(v)) return '<a href="' + esc(BLOB_BASE + m[1]) + '" target="_blank" rel="noopener">' + esc(m[1]) + '</a>' + esc(m[2]);
  if (/^https?:/.test(v)) return '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>';
  return inline(v);
}
function renderItem(it) {
  const f = Object.entries(it.fields).map(([k, v]) => '<span class="k-' + esc(k) + '">' + esc(k) + ': <b>' + (k === 'spec' ? specLink(v) : (k === 'needs' ? v.split(',').map(x => '<button class="id" data-id="' + esc(x.trim()) + '">' + esc(x.trim()) + '</button>').join(', ') : inline(v))) + '</b></span>').join('');
  const kids = it.children.length ? '<ul class="items">' + it.children.map(renderItem).join('') + '</ul>' : '';
  return '<li class="item s-' + it.status + '" data-id="' + esc(it.id) + '" data-status="' + it.status + '" data-text="' + esc((it.id + ' ' + it.title + ' ' + it.detail + ' ' + Object.values(it.fields).join(' ') + ' ' + it.notes.join(' ')).toLowerCase()) + '">'
    + '<button class="id" data-id="' + esc(it.id) + '" title="Copy id">' + esc(it.id) + '</button>'
    + '<span class="st">' + esc(it.status) + (it.qualifier ? ' ' + esc(it.qualifier) : '') + '</span>'
    + '<div class="body"><div class="title">' + inline(it.title) + '</div>' + (it.detail ? '<div class="detail">' + inline(it.detail) + '</div>' : '')
    + (f ? '<div class="fields">' + f + '</div>' : '') + (it.notes.length ? '<ul class="notes">' + it.notes.map(n => '<li>' + inline(n) + '</li>').join('') + '</ul>' : '') + kids + '</div></li>';
}
function render() {
  document.getElementById('h1').textContent = model.title;
  document.getElementById('nowlist').innerHTML = model.now.map(b => '<li>' + inline(b) + '</li>').join('');
  const prob = document.getElementById('problems');
  const stale = staleClaims(model).map(i => i.id + ' claimed by ' + i.fields.owner + ' since ' + i.fields.since + ' (stale)');
  const msgs = model.errors.map(e => 'error: ' + e).concat(stale);
  prob.classList.toggle('hidden', !msgs.length);
  prob.innerHTML = msgs.map(esc).join('<br>');
  const counts = {}; for (const it of model.items) counts[it.status] = (counts[it.status] || 0) + 1;
  document.getElementById('chips').innerHTML = ORDER.map(s => '<button class="chip" data-s="' + s + '" aria-pressed="' + active.has(s) + '">' + s + '<span class="n">' + (counts[s] || 0) + '</span></button>').join('');
  document.getElementById('sections').innerHTML = model.sections.map(s => {
    const all = model.items.filter(i => i.section === s.letter);
    const c = ORDER.map(st => { const n = all.filter(i => i.status === st).length; return n ? n + ' ' + st : null; }).filter(Boolean).join(' · ');
    return '<section class="sec" id="' + s.letter + '"><h2><span class="letter">' + s.letter + '</span>' + esc(s.title) + '<span class="counts">' + c + '</span></h2>'
      + (s.lane ? '<p class="lane">Lane: ' + inline(s.lane) + '</p>' : '') + '<ul class="items">' + s.items.map(renderItem).join('') + '</ul></section>';
  }).join('');
  applyFilter();
}
function applyFilter() {
  const q = query.trim().toLowerCase();
  for (const li of document.querySelectorAll('.item')) {
    const own = active.has(li.dataset.status) && (!q || li.dataset.text.includes(q));
    li.dataset.show = own ? '1' : '0';
  }
  // a parent shows when any child shows; a child shows when it or its parent matches
  for (const li of document.querySelectorAll('.item')) {
    const anyChild = [...li.querySelectorAll('.item')].some(c => c.dataset.show === '1');
    li.classList.toggle('hidden', li.dataset.show !== '1' && !anyChild);
  }
  for (const sec of document.querySelectorAll('section.sec')) sec.classList.toggle('hidden', ![...sec.querySelectorAll('.item')].some(li => !li.classList.contains('hidden')));
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 1400); }
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { const s = chip.dataset.s; if (active.has(s)) active.delete(s); else active.add(s); chip.setAttribute('aria-pressed', active.has(s)); try { localStorage.setItem('wb.filters', JSON.stringify([...active])); } catch {} applyFilter(); return; }
  const idb = e.target.closest('.id');
  if (idb) {
    const id = idb.dataset.id;
    const target = document.querySelector('.item[data-id="' + id + '"]');
    if (target && idb.closest('.fields')) { active.add(target.dataset.status); render(); target.scrollIntoView({ block: 'center' }); return; }
    const text = 'Let\\'s work on item ' + id;
    const done = () => toast('Copied "' + text + '"');
    try { navigator.clipboard.writeText(text).then(done, () => { toast(id); }); } catch { toast(id); }
  }
});
document.getElementById('q').addEventListener('input', (e) => { query = e.target.value; applyFilter(); });
render();
if (location.hash && /^#[A-Z]{1,2}\\d/.test(location.hash)) { const t = document.querySelector('.item[data-id="' + location.hash.slice(1) + '"]'); if (t) { active.add(t.dataset.status); render(); t.scrollIntoView({ block: 'center' }); } }
(async () => {
  const live = document.getElementById('live');
  if (!RAW_URL) { live.textContent = 'no GitHub remote known; showing the snapshot'; return; }
  try {
    const r = await fetch(RAW_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const fresh = await r.text();
    if (fresh !== SNAPSHOT) { model = parseWork(fresh); render(); live.innerHTML = '<span class="ok">live from GitHub</span> (fetched ' + new Date().toISOString().slice(11, 16) + ' UTC; GitHub caches raw files for up to 5 min)'; }
    else live.innerHTML = '<span class="ok">matches GitHub</span> (checked ' + new Date().toISOString().slice(11, 16) + ' UTC)';
  } catch (err) { live.innerHTML = '<span class="err">could not reach GitHub</span>; showing the snapshot'; }
})();
</script>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log('wrote ' + out + ' (' + model.items.length + ' items, ' + model.errors.length + ' errors' + (rawUrl ? ', live source ' + rawUrl : '') + ')');
if (model.errors.length) { for (const e of model.errors) console.error('error: ' + e); process.exit(1); }
