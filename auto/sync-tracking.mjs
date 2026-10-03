#!/usr/bin/env node
// auto/sync-tracking.mjs — copy job-board tracking into the tracker.
//
// The job board (claude.ai artifact) stores "Mark applied" / status changes in
// its shared db collection `tracking` (one doc per report number:
// {num, status, appliedOn, note, updatedAt}). Claude exports that collection
// to a JSON file (ArtifactData list), then this script applies each status to
// data/applications.md through set-status.mjs — the canonical, locked write
// path — only where the tracker differs. Notes stay on the board; the tracker
// Notes column is never touched.
//
// Usage: node auto/sync-tracking.mjs <export.json | export-dir | -> [--dry-run]   ('-' reads JSON from stdin)

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { enterDataRoot, engineScript } from './config.mjs';
import { isNestedCheckout } from '../lib/mjs-files.mjs';

// A relative export path is the caller's; resolve it before moving to the data root.
const CALLER_CWD = process.cwd();
enterDataRoot();
const [fileArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const file = fileArg && fileArg !== '-' ? path.resolve(CALLER_CWD, fileArg) : fileArg;
const DRY = process.argv.includes('--dry-run');
if (!file) { console.error('usage: node auto/sync-tracking.mjs <export.json> [--dry-run]'); process.exit(1); }

// Accept any export shape: collect every object carrying num + status.
const found = new Map();
(function walk(v) {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') {
    if (v.status && (v.num != null)) {
      const k = String(v.num).padStart(3, '0');
      const prev = found.get(k);
      if (!prev || String(v.updatedAt || '') > String(prev.updatedAt || '')) found.set(k, v);
    }
    Object.values(v).forEach(walk);
  }
})((() => {
  // '-' = JSON on stdin; else a file, or a directory of per-document JSON files.
  if (file === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!fs.statSync(file).isDirectory()) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  (function each(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!isNestedCheckout(f)) each(f); } else if (e.name.endsWith('.json')) out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
  } })(file);
  return out;
})());

const TO_STATE = { applied: 'Applied', interviewing: 'Interview', offer: 'Offer', rejected: 'Rejected', skipped: 'Discarded', none: 'Evaluated' };

// current tracker status by report number
const current = new Map();
for (const l of fs.readFileSync('data/applications.md', 'utf8').split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(l)) continue;
  const c = l.split('|').slice(1, -1).map((x) => x.trim());
  const rep = (c[7].match(/\[(\d+)\]/) || [])[1];
  if (rep) current.set(rep.padStart(3, '0'), c[5]);
}

let changed = 0;
for (const [k, t] of [...found].sort()) {
  const want = TO_STATE[t.status];
  const have = current.get(k);
  if (t.status === 'interested') continue; // shortlist only: no tracker state
  if (!want) { console.log(`#${k}: unknown board status "${t.status}" — skipped`); continue; }
  if (have == null) { console.log(`#${k}: no tracker row — skipped`); continue; }
  if (have === want) continue;
  if (want === 'Evaluated' && have === 'Evaluated') continue;
  const args = [engineScript('set-status.mjs'), '--report', String(+k), want];
  if (want === 'Evaluated' || want === 'Discarded') args.push('--force'); // backward / candidate-side moves
  if (DRY) { console.log(`#${k}: ${have} → ${want} (dry run)`); changed++; continue; }
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    console.log(`#${k}: ${have} → ${want}${t.appliedOn ? ` (applied ${t.appliedOn})` : ''}`);
    changed++;
  } catch (e) {
    console.log(`#${k}: set-status refused ${have} → ${want}: ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}
console.log(`sync-tracking: ${found.size} board records, ${changed} tracker change(s)${DRY ? ' (dry run)' : ''}`);
