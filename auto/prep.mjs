#!/usr/bin/env node
// auto/prep.mjs — zero-token preparation for the scheduled pipeline run.
//
// Runs from the repo root BEFORE Claude, so everything mechanical costs no
// tokens and Claude's context only ever holds compact digests:
//   1. rank the Pending queue in data/pipeline.md and select the top N
//   2. liveness-check the selection (check-liveness.mjs) and move expired
//      postings to Processed
//   3. fetch each live JD to data/auto/jd/NN.txt (ATS API first, then the
//      bundled-Chromium extractor)
//   4. write data/auto/digest.md: one short block per posting with the JD's
//      requirements excerpt and zero-token risk flags, plus data/auto/batch.json
//
//   0. (before ranking) browser-list employers no provider covers
//      (data/auto/listings.json) and queue new matches in data/pipeline.md
//
// Ranking uses the auto_scan block of config/profile.yml (auto/config.mjs):
// entry-level and discipline title words, and the big employers to rank last.
//
// Usage: node auto/prep.mjs [--n 75] [--throttle 3000] [--no-listings] [--only <company regex>]

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { decodeEntities } from '../providers/_html-entities.mjs';
import { buildTitleFilter } from '../title-keywords.mjs';
import { buildLocationFilter } from '../scan.mjs';
import { load as loadYaml } from 'js-yaml';
import { enterDataRoot, engineScript, loadAutoConfig, wordListRegex } from './config.mjs';

enterDataRoot();
const CFG = loadAutoConfig();
// Degree-restriction hint: a degree line naming a major, with none of the
// candidate's fields (auto_scan.candidate.degree_fields) or "related" wording.
const DEGREE_OK = (CFG.candidate.degree_fields || []).length
  ? new RegExp(`${(CFG.candidate.degree_fields).map((x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|related|relative|relevant|equivalent|similar|engineering discipline|other engineering|stem`, 'i')
  : null;
// Start-timing hint around the graduation year (auto_scan.candidate.graduation_year).
const GRAD_YEAR = Number(CFG.candidate.graduation_year) || 0;
const START_RE = GRAD_YEAR
  ? new RegExp(`\\b(january|february|march|april|may|june|summer)\\s+(of\\s+)?${GRAD_YEAR}\\b|\\bstart(ing)?\\s+(date|in|by)\\b[^.\\n]{0,40}\\b(${GRAD_YEAR - 1}|${GRAD_YEAR}|january|february|march|april|may|june|july|august)\\b`, 'i')
  : null;

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const N = Number(argVal('--n', 75));
const THROTTLE = Number(argVal('--throttle', 3000));
const OUT = 'data/auto';
const JD_DIR = path.join(OUT, 'jd');
const PIPELINE = 'data/pipeline.md';
const COMPANY_LOG = 'data/auto-scan-companies.log';

// Start at the strongest requirements heading present; stop at employer
// boilerplate (benefits, "about us", EEO) so the excerpt is all signal.
const REQ_HEADINGS = [
  /basic qualifications/i, /minimum qualifications/i, /required qualifications/i,
  /requirements?\s*(?:&|and)\s*qualifications/i, /what you('|’)?ll need|what you need|what you will need/i,
  /you (?:will )?bring|who you are|about you/i, /qualifications/i, /requirements/i,
];
const BOILERPLATE = /why (build your career|join|work)|about (textron|us|the company|the team at)|our benefits|benefits (include|may include|overview)|equal (employment )?opportunity|\bEEO\b|pay (range|transparency)|salary range|compensation (range|package)/i;

fs.mkdirSync(JD_DIR, { recursive: true });
for (const f of fs.readdirSync(JD_DIR)) fs.unlinkSync(path.join(JD_DIR, f));

// ── 0. browser listings for uncovered employers ─────────────────────────────
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const listingReceipt = [];
if (!args.includes('--no-listings') && fs.existsSync(`${OUT}/listings.json`)) {
  const portals = loadYaml(fs.readFileSync('portals.yml', 'utf8'));
  const titleOk = buildTitleFilter(portals.title_filter);
  const locOk = buildLocationFilter(portals.location_filter);
  const seenText = fs.readFileSync('data/scan-history.tsv', 'utf8') + fs.readFileSync(PIPELINE, 'utf8');
  const fresh = new Map();
  for (const src of JSON.parse(fs.readFileSync(`${OUT}/listings.json`, 'utf8')).sources || []) {
    for (const url of src.urls || []) {
      const r = spawnSync(process.execPath, [engineScript('browser-extract.mjs'), url, '--mode', 'listing', '--max', '100'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
      let jobs = [];
      try { jobs = JSON.parse(r.stdout).jobs || []; } catch { listingReceipt.push(`listing failed: ${url}`); continue; }
      for (const j of jobs) {
        if (!j.url.includes(src.jobPath) || seenText.includes(j.url) || fresh.has(j.url)) continue;
        const raw = j.title.replace(/\s+/g, ' ').trim();
        // "Associate, Materials Process Engineer ENGINEERING|NEW, GRADS CANOGA PARK, CA"
        const cut = raw.search(/\s(?=[A-Z]{5,}[\s,|])/);
        let title = (cut > 0 ? raw.slice(0, cut) : raw).trim();
        // Tail after the title is "CATEGORY[, WORD][|NEW, GRADS] CITY, ST" — drop the
        // category/tag tokens; what is left is the location.
        let rest = cut > 0 ? raw.slice(cut).trim() : '';
        if (/\bGRADS\s/.test(rest)) rest = rest.slice(rest.lastIndexOf('GRADS ') + 6);
        else rest = rest.replace(/^[A-Z&]+(?:,\s[A-Z&]+)?(?:\|[A-Z&]+(?:,\s[A-Z&]+)?)*\s+/, '');
        const location = rest.trim();
        if (/NEW,?\s*GRADS/.test(raw)) title += ' [new grad]';
        if (!titleOk(title.replace(' [new grad]', '')) || !locOk(location || 'United States')) continue;
        fresh.set(j.url, { url: j.url, company: src.company, normalized: src.normalized || src.company.toLowerCase(), title, location });
      }
    }
  }
  if (fresh.size) {
    const add = [...fresh.values()];
    const text = fs.readFileSync(PIPELINE, 'utf8');
    const at = text.indexOf('## Pending');
    const nl = text.indexOf('\n', at) + 1;
    const block = '\n' + add.map((a) => `- [ ] ${a.url} | ${a.company} | ${a.title} | ${a.location}`).join('\n');
    fs.writeFileSync(PIPELINE, text.slice(0, nl) + block + text.slice(nl));
    fs.appendFileSync('data/scan-history.tsv', add.map((a) => [a.url, today, 'Level 1 — listing (prep)', a.title, a.company, 'added', a.location, '', '', '', '', a.normalized].join('\t')).join('\n') + '\n');
  }
  listingReceipt.push(`browser listings queued ${fresh.size} new posting(s)`);
}

// ── 1. rank + select ────────────────────────────────────────────────────────
const pipeline = fs.readFileSync(PIPELINE, 'utf8');
const lines = pipeline.split('\n');
const pendingIdx = lines.findIndex((l) => l.trim() === '## Pending');
const processedIdx = lines.findIndex((l) => l.trim() === '## Processed');
if (pendingIdx < 0 || processedIdx < 0) throw new Error('pipeline.md: missing ## Pending or ## Processed header');

const skippedEmployers = new Set();
if (fs.existsSync(COMPANY_LOG)) {
  for (const l of fs.readFileSync(COMPANY_LOG, 'utf8').split('\n')) {
    const c = l.split('\t');
    if (c[1] && c[1].trim().toLowerCase() === 'skipped' && c[2]) skippedEmployers.add(c[2].trim().toLowerCase());
  }
}

// Tier words come from the profile (auto_scan.ranking). With no discipline list
// every title counts as in-discipline, so ranking falls back to entry-level first.
const ENTRY = wordListRegex(CFG.ranking.entry_level_titles) || /$^/;
const DISCIPLINE = wordListRegex(CFG.ranking.discipline_titles);
const ARCH = DISCIPLINE || /^/;

const pending = [];
for (let i = pendingIdx + 1; i < processedIdx; i++) {
  const l = lines[i];
  if (!l.startsWith('- [ ] ')) continue;
  const parts = l.slice(6).split(' | ');
  const url = (parts[0] || '').trim();
  const company = (parts[1] || '').trim();
  const title = (parts[2] || '').trim();
  const location = (parts[3] || '').trim().replace(/^posted:.*$/, '');
  const posted = (l.match(/posted: (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  let tier = ENTRY.test(title) && ARCH.test(title) ? 1 : ARCH.test(title) ? 2 : 3;
  if (skippedEmployers.has(company.toLowerCase())) tier = 4;
  pending.push({ lineIdx: i, line: l, url, company, title, location, posted, tier });
}
// Discovery candidates: employers in Pending that are neither tracked in
// portals.yml nor already decided in the company log (so the model never has
// to read pipeline.md to find them).
const trackedText = fs.readFileSync('portals.yml', 'utf8').toLowerCase();
const loggedCompanies = new Set();
if (fs.existsSync(COMPANY_LOG)) for (const l of fs.readFileSync(COMPANY_LOG, 'utf8').split('\n')) { const c = l.split('\t'); if (c[2]) loggedCompanies.add(c[2].trim().toLowerCase()); }
const discovery = new Map();
for (const p of pending) {
  const key = p.company.toLowerCase();
  if (!key || loggedCompanies.has(key)) continue;
  let host = '';
  try { host = new URL(p.url).host; } catch { /* keep blank */ }
  const slug = (p.url.match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/([^/?#]+)/) || [])[1] || '';
  if (trackedText.includes(`name: ${key}`) || (slug && trackedText.includes(`/${slug.toLowerCase()}`)) || (host && !/greenhouse|lever|ashby|myworkdayjobs|icims/.test(host) && trackedText.includes(host))) continue;
  const d = discovery.get(key) || { company: p.company, host, slug, count: 0, titles: [] };
  d.count++;
  if (d.titles.length < 2) d.titles.push(p.title);
  discovery.set(key, d);
}

// --only <regex>: restrict this run to matching employers (e.g. one company family).
const ONLY = argVal('--only', '');
if (ONLY) { const re = new RegExp(ONLY, 'i'); for (let k = pending.length - 1; k >= 0; k--) if (!re.test(pending[k].company)) pending.splice(k, 1); }
// Within a tier, smaller employers first: auto_scan.ranking.big_employers lists
// the large employers whose applicant pools are least realistic for this
// candidate (name prefixes, case-insensitive).
const BIG_EMPLOYERS = wordListRegex(CFG.ranking.big_employers, { anchored: true }) || /$^/;
for (const p of pending) p.big = BIG_EMPLOYERS.test(p.company) ? 1 : 0;
// Paused employers (portals.yml entries carrying a `paused:` line, 2026-09-30): the candidate
// stopped targeting them. Their postings stay in Pending (reversible) but are never
// selected, regardless of tier.
const pausedEmployers = new Set();
{
  let name = null;
  for (const l of trackedText.split('\n')) {
    const m = l.match(/^\s*- name:\s*"?(.+?)"?\s*$/);
    if (m) name = m[1];
    else if (name && /^\s*paused:/.test(l)) pausedEmployers.add(name);
  }
}
const pausedCount = pending.filter((p) => pausedEmployers.has(p.company.toLowerCase())).length;
for (let k = pending.length - 1; k >= 0; k--) if (pausedEmployers.has(pending[k].company.toLowerCase())) pending.splice(k, 1);
pending.sort((a, b) => a.tier - b.tier || a.big - b.big || b.posted.localeCompare(a.posted) || a.lineIdx - b.lineIdx);
const tierCounts = pending.reduce((m, p) => ((m[p.tier] = (m[p.tier] || 0) + 1), m), {});
const selected = pending.slice(0, N).map((p, k) => ({ ...p, n: String(k + 1).padStart(2, '0') }));

// ── 2. liveness ─────────────────────────────────────────────────────────────
const urlFile = path.join(OUT, 'urls.txt');
fs.writeFileSync(urlFile, selected.map((s) => s.url).join('\n') + '\n');
const live = spawnSync(process.execPath, [engineScript('check-liveness.mjs'), `--throttle=${THROTTLE}`, '--file', urlFile], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const status = new Map();
for (const l of `${live.stdout}\n${live.stderr}`.split('\n')) {
  const m = l.match(/\b(active|expired|uncertain)\b.*?(https?:\/\/\S+)/);
  if (m) status.set(m[2], m[1]);
}
for (const s of selected) s.liveness = status.get(s.url) || 'unchecked';

// Move expired postings to Processed (modes/pipeline.md step 3 wording).
const expired = selected.filter((s) => s.liveness === 'expired');
if (expired.length) {
  const expiredIdx = new Set(expired.map((s) => s.lineIdx));
  const moved = expired.map((s) => `- [x] ~~${s.url} | ${s.company} | ${s.title}~~ — posting expired (liveness sweep)`);
  const out = [];
  lines.forEach((l, i) => {
    if (expiredIdx.has(i)) return;
    out.push(l);
    if (i === processedIdx) out.push('', ...moved);
  });
  fs.writeFileSync(PIPELINE, out.join('\n'));
}

// Eightfold job pages render only a summary tab, so browser extraction misses
// the description. The PCSX details API has it; the domain comes from the
// tenant's portals.yml entry (default <tenant>.com).
const efDomains = {};
for (const m of fs.readFileSync('portals.yml', 'utf8').matchAll(/careers_url:\s*https:\/\/([a-z0-9-]+)\.eightfold\.ai[^\r\n]*\r?\n\s*domain:\s*(\S+)/g)) efDomains[m[1]] = m[2];
// Keeps line structure (providers/_html-to-text.mjs flattens and caps at 4K).
function htmlToLines(html) {
  const t = String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(t).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
// iCIMS renders the JD inside an iframe; the ?in_iframe=1 view is the full page
// server-side, so browser extraction is not needed (and returns only chrome).
async function fetchIcims(url) {
  if (!/^https:\/\/[a-z0-9-]+\.icims\.com\/jobs\/\d+/.test(url)) return null;
  const res = await fetch(url.split('?')[0] + '?in_iframe=1', { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const html = await res.text();
  const at = html.indexOf('iCIMS_JobContent');
  const text = htmlToLines((at > 0 ? html.slice(at) : html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')).replace(/^[^>]*>\s*/, '').slice(0, 12000);
  return /Qualifications|Responsibilities/i.test(text) && text.length > 800 ? { text, ats: 'icims' } : null;
}

async function fetchEightfold(url) {
  const m = url.match(/^https:\/\/([a-z0-9-]+)\.eightfold\.ai\/careers\/job\/(\d+)/);
  if (!m) return null;
  const domain = efDomains[m[1]] || `${m[1]}.com`;
  const res = await fetch(`https://${m[1]}.eightfold.ai/api/pcsx/position_details?position_id=${m[2]}&domain=${encodeURIComponent(domain)}&hl=en`,
    { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const d = (await res.json())?.data;
  if (!d?.jobDescription) return null;
  const meta = [d.efcustomTextClearanceLevel && `Clearance: ${d.efcustomTextClearanceLevel}`].filter(Boolean).join('\n');
  return { text: `${meta ? meta + '\n' : ''}${htmlToLines(d.jobDescription)}`.slice(0, 12000), ats: 'eightfold' };
}

// ── 3. JD fetch ─────────────────────────────────────────────────────────────
const toFetch = selected.filter((s) => s.liveness !== 'expired');
for (const s of toFetch) {
  let text = '';
  let via = '';
  try {
    const r = (await fetchEightfold(s.url)) || (await fetchIcims(s.url)) || (await fetchJdViaKnownApi(s.url));
    if (r && r.text && r.text.length > 400) { text = r.text; via = `${r.ats}-api`; }
  } catch { /* fall through to the browser extractor */ }
  if (!text) {
    const r = spawnSync(process.execPath, [engineScript('browser-extract.mjs'), s.url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90_000 });
    try {
      const j = JSON.parse(r.stdout);
      if (j.text && j.text.length > 400) { text = j.text; via = 'browser-extract'; }
    } catch { /* no JD */ }
  }
  s.jdVia = via || 'none';
  s.jdChars = text.length;
  s.jdFile = text ? path.join(JD_DIR, `${s.n}.txt`) : null;
  if (text) {
    fs.writeFileSync(s.jdFile, `URL: ${s.url}\nCompany: ${s.company}\nTitle: ${s.title}\nLocation: ${s.location}\nPosted: ${s.posted || 'not visible in source'}\nSource: ${via}\n\n${text}\n`);
  }
  s.flags = flags(text);
  s.excerpt = excerpt(text);
}

// ── 4. digest ───────────────────────────────────────────────────────────────
// JD text often lacks spaces after periods ("software.Effective"), so hints
// are fixed windows around each match rather than sentences.
function windows(text, re, max = 2, span = 110) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of text.matchAll(g)) {
    const a = Math.max(0, m.index - span);
    const w = text.slice(a, m.index + m[0].length + span).replace(/\s+/g, ' ').trim();
    if (!out.some((o) => o.includes(m[0]) && Math.abs(text.indexOf(o) - a) < span)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
function flags(text) {
  if (!text) return ['NO JD TEXT — needs manual extraction'];
  const f = [];
  const yrs = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:or more\s+)?(?:years?|yrs?)(?:\s+of)?[^.\n]{0,50}?experience/gi)].map((m) => Number(m[1]));
  if (yrs.length) f.push(`experience asks: ${[...new Set(yrs)].sort((a, b) => a - b).map((y) => `${y}y`).join(', ')}`);
  if (DEGREE_OK) {
    for (const w of windows(text, /\b(bachelor'?s?|b\.?s\.?|degree)\b[^.\n]{0,120}\b(mechanical|industrial|electrical|chemical|materials|manufacturing|civil|computer|aerospace|aeronautical)\b/i, 2, 60)) {
      if (!DEGREE_OK.test(w)) f.push(`degree restriction?: "${w.slice(0, 240)}"`);
    }
  }
  if (START_RE) for (const w of windows(text, START_RE, 2, 80)) f.push(`start timing: "${w}"`);
  for (const w of windows(text, /\b(security clearance|clearance|ts\/sci|top secret)\b/i, 1, 90)) f.push(`clearance: "${w}"`);
  for (const w of windows(text, /\bgpa\b/i, 1, 70)) f.push(`gpa: "${w}"`);
  if (/\b(2nd|second|3rd|third|night|weekend) shift\b/i.test(text)) f.push('non-day shift mentioned');
  if (/\b(internship|co-?op)\b/i.test(text.slice(0, 600))) f.push('internship/co-op wording near top');
  return f;
}
function excerpt(text) {
  if (!text) return '';
  let start = 0;
  // A heading, not a mention: capitalised ("Basic Qualifications", not the
  // pay-transparency "requirements and qualifications"), and followed within a
  // few words by ':' / newline / a capital run straight on — flattened text
  // glues headings to their first line ("QualificationsBachelor's").
  const isHeading = (i, len) => /^[A-Z]/.test(text[i]) &&
    /^[^.\n]{0,25}?(:|\n|[a-z][A-Z])/.test(text.slice(i + len - 1, i + len + 26));
  outer: for (const re of REQ_HEADINGS) {
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
      if (isHeading(m.index, m[0].length)) { start = m.index; break outer; }
    }
  }
  let body = text.slice(start, start + 1600);
  const cut = body.slice(120).search(BOILERPLATE);
  if (cut >= 0) body = body.slice(0, 120 + cut);
  return body.slice(0, 1200).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const batch = selected.map(({ line, lineIdx, excerpt: _e, ...rest }) => rest);
fs.writeFileSync(path.join(OUT, 'batch.json'), JSON.stringify(batch, null, 1));

const md = [
  `# Pipeline digest — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Pending ranked: tier1 (entry-level + target discipline) ${tierCounts[1] || 0} · tier2 (target discipline) ${tierCounts[2] || 0} · tier3 ${tierCounts[3] || 0} · tier4 (logged off-industry employers) ${tierCounts[4] || 0} · paused employers skipped ${pausedCount}.`,
  `Selected ${selected.length}; expired ${expired.length} (already moved to Processed); JD text captured for ${toFetch.filter((s) => s.jdChars).length}.`,
  ...listingReceipt,
  'Flags are zero-token regex hints — confirm against the excerpt/JD before discarding on them.',
  '',
];
if (discovery.size) {
  md.push(`## Discovery candidates (${discovery.size} employers not in portals.yml or the company log)`, '');
  for (const d of [...discovery.values()].sort((a, b) => b.count - a.count).slice(0, 60)) {
    md.push(`- ${d.company} — ${d.count} pending · ${d.slug ? `slug ${d.slug} @ ` : ''}${d.host} · e.g. ${d.titles.join(' / ')}`);
  }
  md.push('');
}
for (const s of selected) {
  md.push(`## ${s.n} · ${s.company} · ${s.title}`);
  md.push(`${s.url}`);
  md.push(`tier ${s.tier} · ${s.location || 'location n/a'} · posted ${s.posted || 'n/a'} · liveness ${s.liveness}${s.jdFile ? ` · JD ${s.jdChars} chars (${s.jdVia}) → ${s.jdFile.replace(/\\/g, '/')}` : ''}`);
  if (s.liveness === 'expired') { md.push('EXPIRED — moved to Processed.', ''); continue; }
  if (s.flags?.length) md.push(...s.flags.map((f) => `- ⚑ ${f}`));
  if (s.excerpt) md.push('', '```', s.excerpt, '```');
  md.push('');
}
fs.writeFileSync(path.join(OUT, 'digest.md'), md.join('\n'));

console.log(JSON.stringify({
  pending: pending.length, paused: pausedCount, tiers: tierCounts, selected: selected.length,
  liveness: selected.reduce((m, s) => ((m[s.liveness] = (m[s.liveness] || 0) + 1), m), {}),
  jdCaptured: toFetch.filter((s) => s.jdChars).length,
  listings: listingReceipt,
  discoveryCandidates: discovery.size,
  digestChars: md.join('\n').length,
}));
