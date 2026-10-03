#!/usr/bin/env node
// auto/recheck.mjs — re-verify that evaluated-but-not-applied roles are
// still open, so the job board never sends the candidate to a dead posting.
//
// Reads data/applications.md (URL column), runs check-liveness.mjs on every
// row still at Evaluated, and moves rows whose posting is conclusively
// expired to Discarded with a "posting closed" note via set-status.mjs (the
// canonical, locked write path; --note appends). Uncertain results are left
// alone. Zero tokens.
//
// Usage: node auto/recheck.mjs [--dry-run]

import fs from 'fs';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { enterDataRoot, engineScript } from './config.mjs';

enterDataRoot();
const DRY = process.argv.includes('--dry-run');
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const rows = [];
let urlCol = -1;
for (const l of fs.readFileSync('data/applications.md', 'utf8').split('\n')) {
  const c = l.split('|').slice(1, -1).map((x) => x.trim());
  if (l.startsWith('| #')) { urlCol = c.findIndex((h) => /^url$/i.test(h)); continue; }
  if (!/^\|\s*\d+\s*\|/.test(l) || urlCol < 0) continue;
  const rep = (c[7].match(/\[(\d+)\]/) || [])[1];
  if (c[5] === 'Evaluated' && rep && /^https?:\/\//.test(c[urlCol] || '')) rows.push({ rep: +rep, company: c[2], role: c[3], url: c[urlCol] });
}
if (!rows.length) { console.log('recheck: no Evaluated rows with a URL'); process.exit(0); }

fs.mkdirSync('data/auto', { recursive: true });
const list = 'data/auto/recheck-urls.txt';
fs.writeFileSync(list, rows.map((r) => r.url).join('\n') + '\n');
const live = spawnSync(process.execPath, [engineScript('check-liveness.mjs'), '--throttle=2000', '--file', list], { encoding: 'utf8', maxBuffer: 32 << 20 });
const status = new Map();
for (const l of `${live.stdout}\n${live.stderr}`.split('\n')) {
  const m = l.match(/\b(active|expired|uncertain)\b.*?(https?:\/\/\S+)/);
  if (m) status.set(m[2], m[1]);
}

// Confirm every "expired" with a second, slower pass: under ATS rate limiting a
// single check can misread (2026-09-27: a live Ducommun posting and 429-limited
// Workday pages read as closed once). Only a repeat "expired" closes a row.
const first = rows.filter((r) => status.get(r.url) === 'expired');
if (first.length) {
  const again = 'data/auto/recheck-confirm.txt';
  fs.writeFileSync(again, first.map((r) => r.url).join('\n') + '\n');
  const second = spawnSync(process.execPath, [engineScript('check-liveness.mjs'), '--throttle=5000', '--file', again], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const confirmed = new Set();
  for (const l of `${second.stdout}\n${second.stderr}`.split('\n')) {
    const m = l.match(/\bexpired\b.*?(https?:\/\/\S+)/);
    if (m) confirmed.add(m[1]);
  }
  for (const r of first) if (!confirmed.has(r.url)) status.set(r.url, 'uncertain');
}

const tally = { active: 0, expired: 0, uncertain: 0, unchecked: 0 };
for (const r of rows) {
  const s = status.get(r.url) || 'unchecked';
  tally[s]++;
  if (s !== 'expired') continue;
  const args = [engineScript('set-status.mjs'), '--report', String(r.rep), 'Discarded', '--force', '--note', `posting closed (liveness recheck ${TODAY}, confirmed twice)`];
  if (DRY) { console.log(`#${String(r.rep).padStart(3, '0')} ${r.company} — ${r.role}: CLOSED (dry run)`); continue; }
  try { execFileSync(process.execPath, args, { stdio: 'pipe' }); console.log(`#${String(r.rep).padStart(3, '0')} ${r.company} — ${r.role}: CLOSED → Discarded`); }
  catch (e) { console.log(`#${r.rep}: set-status refused: ${String(e.stderr || e.message).split('\n')[0]}`); }
}
console.log(`recheck: ${rows.length} open roles checked — ${tally.active} active, ${tally.expired} closed, ${tally.uncertain} uncertain, ${tally.unchecked} unchecked${DRY ? ' (dry run)' : ''}`);
