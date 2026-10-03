#!/usr/bin/env node
// auto/dashboard.mjs — zero-token job board built from the tracker + reports.
//
// Reads data/applications.md, reports/*.md (header fields + Machine Summary
// YAML + full text), data/scan-history.tsv (location, first seen),
// data/pipeline.md (pre-screen discards, queue size) and data/auto-scan.log
// (last run), and writes:
//   output/career-dashboard.html            self-contained page: open it in any
//                                           browser, copy it to any computer
//   output/career-dashboard.artifact.html   the same page as a fragment, for
//                                           publishing to claude.ai
// The heading comes from auto_scan.board in config/profile.yml.
// Usage: node auto/dashboard.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from 'js-yaml';
import { buildLocationFilter } from '../scan.mjs';
import { enterDataRoot, loadAutoConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
enterDataRoot();
const BOARD = loadAutoConfig().board;
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// scan-history: url → { location, first_seen }
const hist = new Map();
for (const l of read('data/scan-history.tsv').split('\n').slice(1)) {
  const c = l.split('\t');
  if (c[0] && !hist.has(c[0])) hist.set(c[0], { firstSeen: c[1], location: c[6] });
}

// tracker rows
const roles = [];
for (const l of read('data/applications.md').split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(l)) continue;
  const c = l.split('|').slice(1, -1).map((x) => x.trim());
  const [num, date, company, role, score, status, pdf, report, notes] = c;
  const rel = (report.match(/\(([^)]+)\)/) || [])[1] || '';
  const reportPath = rel ? path.normalize(path.join('data', rel)).replace(/\\/g, '/') : '';
  roles.push({ num: +num, date, company, role, score: parseFloat(score) || null, status, notes, reportPath });
}

const field = (md, name) => ((md.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm')) || [])[1] || '').trim();
for (const r of roles) {
  const md = r.reportPath ? read(r.reportPath) : '';
  r.markdown = md;
  r.url = field(md, 'URL');
  r.legitimacy = field(md, 'Legitimacy');
  r.archetype = field(md, 'Archetype');
  let ms = {};
  const y = md.match(/## Machine Summary[\s\S]*?```ya?ml\n([\s\S]*?)```/);
  if (y) { try { ms = load(y[1]) || {}; } catch { ms = {}; } }
  r.decision = ms.final_decision || '';
  r.next = ms.next_action || '';
  r.strengths = ms.top_strengths || [];
  r.gaps = ms.soft_gaps || [];
  r.hard = ms.hard_stops || [];
  r.risk = ms.risk_level || '';
  r.comp = ms.advertised_comp || '';
  if (ms.archetype && !r.archetype) r.archetype = ms.archetype;
  r.tldr = ((md.match(/^\|\s*TL;DR\s*\|\s*(.+?)\s*\|\s*$/m) || [])[1] || '').trim();
  r.posted = ((md.match(/## Job Description[^\n]*\n+Posted:\s*(\S+)/) || [])[1] || (r.notes.match(/posted:?\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || '').replace(/[;,.]$/, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.posted)) r.posted = '';
  r.closed = /posting closed/i.test(r.notes || '');
  const h = hist.get(r.url);
  // Workday site codes ("US-AZ-TUCSON-928 ~ 1151 E ...") -> "Tucson, AZ"
  r.location = (h?.location || '').replace(/^US-([A-Z]{2})-([A-Z .]+?)-[^|]*$/, (_, st, city) =>
    `${city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}, ${st}`).replace(/^USA - /, '');
}

// pre-screen discards + queue size from pipeline.md
const pipeline = read('data/pipeline.md');
const discards = [];
for (const l of pipeline.split('\n')) {
  const m = l.match(/^- \[x\] #--\s*\|\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/);
  if (m) discards.push({ url: m[1], company: m[2], title: m[3], reason: m[4].replace(/^skipped \(pre-screen mismatch:\s*/, '').replace(/\)$/, '') });
}
const pending = (pipeline.match(/^- \[ \] /gm) || []).length;

// Regions the candidate has ruled out (tracker note "<region> — candidate excluded"):
// drop them from the board entirely — reports stay on disk and in the tracker as Discarded.
const EXCLUDED_REGION = /— candidate excluded/i;
// Also hide any role whose location hits portals.yml location_filter.block_hard
// -- catches rows evaluated before the rule existed.
let locOk = () => true;
// block_hard ONLY: the allow list would also drop vague strings like "5 Locations".
try { const lf = load(read('portals.yml')).location_filter || {}; if (lf.block_hard) locOk = buildLocationFilter({ block_hard: lf.block_hard }); } catch {}
for (let i = roles.length - 1; i >= 0; i--) {
  const r = roles[i];
  if (EXCLUDED_REGION.test(r.notes || '') || (r.location && !locOk(r.location, r.url, r.role))) roles.splice(i, 1);
}
for (let i = discards.length - 1; i >= 0; i--) if (EXCLUDED_REGION.test(discards[i].reason || '')) discards.splice(i, 1);

// last finished scheduled run
let lastRun = '';
for (const l of read('data/auto-scan.log').split('\n')) {
  const m = l.match(/=== run (?:finished OK|FAILED)[^:]*: (\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) lastRun = `${m[1]} ${m[2]}`;
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const data = {
  generated: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  lastRun, pending, roles, discards,
};
const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fragment = read(path.join(HERE, 'dashboard.template.html'))
  .replaceAll('__BOARD_TITLE__', () => esc(BOARD.title))
  .replace('__BOARD_EYEBROW__', () => esc(BOARD.eyebrow))
  .replace('__DATA__', () => json);

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync('output/career-dashboard.artifact.html', fragment);
fs.writeFileSync('output/career-dashboard.html',
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
  `<style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`);
console.log(`dashboard: ${roles.length} roles, ${discards.length} discards, ${pending} pending → output/career-dashboard.html (${Math.round(fs.statSync('output/career-dashboard.html').size / 1024)} KB)`);
