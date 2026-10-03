#!/usr/bin/env node
// init-data.mjs — start a fresh, personal data folder for career-ops.
//
// The checkout holds the engine (scripts, templates, modes). Everything that is
// about one person — CV, profile, portals, tracker, reports — lives in a data
// folder that every script finds through path-resolver.mjs. This script creates
// that folder from the shipped templates and points the checkout at it, so a new
// user never edits (or inherits) someone else's files.
//
// Usage:
//   node init-data.mjs [dir]       default dir: ../career-ops-data
//   node init-data.mjs [dir] --no-marker
//                                  create the folder but don't write
//                                  .career-ops-data (use CAREER_OPS_DATA_DIR)
//
// Existing files are never overwritten, so re-running it only fills gaps.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ENGINE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('--')) || '../career-ops-data';
const DATA = path.resolve(ENGINE, dirArg);
const writeMarker = !args.includes('--no-marker');

if (DATA === ENGINE) {
  console.error('init-data: the data folder must be different from the checkout itself.');
  process.exit(1);
}

const created = [];
const kept = [];
const rel = (p) => path.relative(DATA, p).replace(/\\/g, '/');

function put(target, content) {
  const abs = path.join(DATA, target);
  if (fs.existsSync(abs)) { kept.push(target); return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  created.push(target);
}
const fromTemplate = (target, template) => put(target, fs.readFileSync(path.join(ENGINE, template), 'utf8'));

const CV_STUB = `# Your Name

your.email@example.com · City, ST · linkedin.com/in/you

## Summary

One or two sentences on who you are and what you're looking for.

## Experience

### Job Title — Company (Start – End)

- What you did, with a number when you have one.

## Projects

## Education

### Degree — School (Year)

## Skills
`;

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

const PIPELINE = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\`, or let \`npm run scan\` fill this in.

## Pending

## Processed
`;

const SCAN_HISTORY = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n';

fs.mkdirSync(DATA, { recursive: true });

// Profile layer (what doctor.mjs checks for).
put('cv.md', CV_STUB);
fromTemplate('config/profile.yml', 'config/profile.example.yml');
fromTemplate('portals.yml', 'templates/portals.example.yml');
fromTemplate('modes/_profile.md', 'modes/_profile.template.md');
fromTemplate('modes/_custom.md', 'modes/_custom.template.md');

// Working data.
put('data/applications.md', TRACKER);
put('data/pipeline.md', PIPELINE);
put('data/scan-history.tsv', SCAN_HISTORY);
put('data/auto/library.json', '{\n "stories": {}\n}\n');
for (const d of ['reports', 'jds', 'output']) put(`${d}/.gitkeep`, '');

const markerPath = path.join(ENGINE, '.career-ops-data');
let markerNote = '';
if (writeMarker) {
  const value = path.relative(ENGINE, DATA).replace(/\\/g, '/') || '.';
  const previous = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
  fs.writeFileSync(markerPath, value + '\n');
  markerNote = previous && previous !== value
    ? `.career-ops-data now points at ${value} (was ${previous})`
    : `.career-ops-data points at ${value}`;
}

console.log(`career-ops data folder: ${DATA}`);
if (created.length) console.log(`  created: ${created.map((p) => rel(path.join(DATA, p))).join(', ')}`);
if (kept.length) console.log(`  kept existing: ${kept.join(', ')}`);
console.log(writeMarker
  ? `  ${markerNote} — every script in this checkout now reads and writes there.`
  : `  no marker written — set CAREER_OPS_DATA_DIR=${DATA} before running scripts.`);
console.log(`
Next:
  1. Replace cv.md with your CV (markdown), and fill in config/profile.yml.
  2. Edit portals.yml: the companies to scan and the title/location filters.
  3. npm run doctor        check the setup
  4. npm run scan          find postings (no AI needed)
  5. npm run board         build output/career-dashboard.html`);
