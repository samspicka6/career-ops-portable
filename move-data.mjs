#!/usr/bin/env node
// move-data.mjs — move an existing setup's personal files out of the checkout
// and into a separate data folder.
//
// init-data.mjs starts a NEW data folder from templates. This is its companion
// for an install that has been running in the checkout for a while: it moves
// the user layer (DATA_CONTRACT.md) — CV, profile, portals, tracker, reports,
// JDs, interview prep — into the data folder, then points the checkout at it
// with the same .career-ops-data marker init-data.mjs writes. Afterwards every
// script, and any agent following AGENTS.md, reads and writes there.
//
// Usage:
//   node move-data.mjs [dir]            default dir: ../career-ops-data
//   node move-data.mjs [dir] --dry-run  list what would move, change nothing
//   node move-data.mjs [dir] --no-marker
//
// Safe to re-run: a file already in the data folder is never overwritten. An
// identical copy just has its checkout duplicate removed; a different one is
// left in place on both sides and reported, for you to reconcile by hand.
// System-owned scaffold (.gitkeep, the README.md files the updater ships) and
// scripts stay in the checkout.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isNestedCheckout } from './lib/mjs-files.mjs';

const ENGINE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('--')) || '../career-ops-data';
const DATA = path.resolve(ENGINE, dirArg);
const DRY = args.includes('--dry-run');
const writeMarker = !args.includes('--no-marker');

if (DATA === ENGINE) {
  console.error('move-data: the data folder must be different from the checkout itself.');
  process.exit(1);
}

// The user layer, as DATA_CONTRACT.md lists it. Directories end in "/".
// Plugin state (config/plugins.yml, plugins.local/, plugins.lock) is left out on
// purpose: plugins are discovered next to the code, so their config stays there.
const USER_LAYER = [
  'cv.md',
  'article-digest.md',
  'voice-dna.md',
  'portals.yml',
  'config/profile.yml',
  'config/cv-facts.json',
  'config/benchmarks.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'modes/_brief.md',
  'data/',
  'reports/',
  'jds/',
  'output/',
  'interview-prep/',
  'writing-samples/',
  'documents/',
  'batch/tracker-additions/',
  'batch/batch-state.tsv',
];

// Files inside those folders that belong to the engine, not the user.
function isScaffold(rel) {
  const base = path.posix.basename(rel);
  if (base === '.gitkeep') return true;
  if (['interview-prep/sessions/README.md', 'writing-samples/README.md', 'documents/README.md'].includes(rel)) return true;
  // Scripts that live under data/auto/ are engine code until they are moved out
  // of the data folder; only their working files and notes are personal.
  if (rel.startsWith('data/auto/') && /\.(mjs|ps1)$|\.template\.html$/.test(base)) return true;
  return false;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // A nested git checkout (e.g. a data folder that is its own repo) is not ours to move.
    if (entry.isDirectory() && !isNestedCheckout(full)) walk(full, out);
    else if (entry.isFile()) out.push(path.relative(ENGINE, full).split(path.sep).join('/'));
  }
  return out;
}

function listFiles(rel) {
  const abs = path.join(ENGINE, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel.replace(/\/$/, '')];
  return walk(abs, []);
}

// A data folder inside the checkout must not be swept into itself.
const dataRel = path.relative(ENGINE, DATA).replace(/\\/g, '/');
const insideData = (rel) => !dataRel.startsWith('..') && (rel === dataRel || rel.startsWith(dataRel + '/'));

const moved = [];
const deduped = [];
const conflicts = [];
for (const entry of USER_LAYER) {
  for (const rel of listFiles(entry)) {
    if (isScaffold(rel) || insideData(rel)) continue;
    const from = path.join(ENGINE, rel);
    const to = path.join(DATA, rel);
    if (fs.existsSync(to)) {
      if (fs.readFileSync(to).equals(fs.readFileSync(from))) {
        if (!DRY) fs.rmSync(from);
        deduped.push(rel);
      } else {
        conflicts.push(rel);
      }
      continue;
    }
    if (!DRY) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        fs.renameSync(from, to);
      } catch {
        // Different volume: copy, then remove the original.
        fs.copyFileSync(from, to);
        fs.rmSync(from);
      }
    }
    moved.push(rel);
  }
}

let markerNote = '';
if (writeMarker && !DRY) {
  const value = dataRel || '.';
  fs.writeFileSync(path.join(ENGINE, '.career-ops-data'), value + '\n');
  markerNote = `.career-ops-data points at ${value}`;
}

console.log(`career-ops data folder: ${DATA}${DRY ? '  (dry run, nothing changed)' : ''}`);
console.log(`  ${DRY ? 'would move' : 'moved'}: ${moved.length} file(s)`);
for (const rel of moved.slice(0, 15)) console.log(`    ${rel}`);
if (moved.length > 15) console.log(`    ... and ${moved.length - 15} more`);
if (deduped.length) console.log(`  already there (identical, ${DRY ? 'would remove' : 'removed'} checkout copy): ${deduped.length}`);
if (conflicts.length) {
  console.log(`  NOT moved, a different copy is already in the data folder (${conflicts.length}):`);
  for (const rel of conflicts) console.log(`    ${rel}`);
}
if (markerNote) console.log(`  ${markerNote} — every script in this checkout now reads and writes there.`);
else if (!writeMarker && !DRY) console.log(`  no marker written — set CAREER_OPS_DATA_DIR=${DATA} before running scripts.`);
if (conflicts.length) process.exitCode = 2;
