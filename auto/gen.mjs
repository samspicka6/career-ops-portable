#!/usr/bin/env node
// auto/gen.mjs — zero-token report assembler for the scheduled pipeline run.
//
// Claude writes only data/auto/judgments.json (compact per-role judgments +
// discard reasons); this script does everything mechanical:
//   - refuses cover-letter "key achievement" bullets that are not verbatim cv.md
//   - reserves report numbers (reserve-report-num.mjs), writes reports/ with the
//     full A-G structure, Machine Summary, and the JD archived verbatim from
//     data/auto/jd/NN.txt (never re-typed by the model)
//   - writes batch/tracker-additions/*.tsv (PDF ❌ — no auto CVs)
//   - moves evaluated/discarded items from Pending to Processed in
//     data/pipeline.md and appends discards to data/discard.log
//   - runs merge-tracker.mjs and verify-pipeline.mjs
// Items in batch.json that appear in neither `jobs` nor `discards` stay Pending.
//
// Usage: node auto/gen.mjs [--dry-run]   (data paths are relative to the data root)
//
// judgments.json shape (see auto/judgment.example.json for a full job):
//   { "discards": { "NN": "one-line reason" },
//     "jobs": [ { "n": "NN", "slug": "...", "company": "...", ... } ],
//     "newStories": { "key": [title, S, T, A, R, reflection] } }

import fs from 'fs';
import { execFileSync } from 'child_process';
import { enterDataRoot, engineScript } from './config.mjs';

enterDataRoot();

const DRY = process.argv.includes('--dry-run');
const A = 'data/auto';
const d = new Date();
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const batch = JSON.parse(fs.readFileSync(`${A}/batch.json`, 'utf8'));
const byN = new Map(batch.map((b) => [b.n, b]));
const J = JSON.parse(fs.readFileSync(`${A}/judgments.json`, 'utf8'));
const lib = JSON.parse(fs.readFileSync(`${A}/library.json`, 'utf8'));
const jobs = J.jobs || [];
const discards = J.discards || {};
Object.assign(lib.stories, J.newStories || {});

// ── validation (fail loudly; the model fixes judgments.json and re-runs) ────
const errors = [];
const norm = (s) => String(s).replace(/\*\*/g, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
const cv = norm(fs.readFileSync('cv.md', 'utf8'));
const REQUIRED = ['n', 'slug', 'company', 'role', 'archetype', 'score', 'legit', 'decision', 'risk', 'tldr', 'reqs', 'gaps', 'level', 'demand', 'ctype', 'custom', 'stories', 'storyMap', 'caseStudy', 'redQs', 'descQ', 'realism', 'legitNotes', 'keywords', 'coverOpen', 'coverBullets', 'coverGaps', 'note'];
for (const j of jobs) {
  const b = byN.get(j.n);
  if (!b) { errors.push(`${j.n}: not in batch.json`); continue; }
  if (!b.jdFile) errors.push(`${j.n}: no JD captured — discard it or leave it pending`);
  for (const k of REQUIRED) if (j[k] === undefined) errors.push(`${j.n}: missing field "${k}"`);
  if (typeof j.score !== 'number' || j.score < 0 || j.score > 5) errors.push(`${j.n}: score must be a number 0-5`);
  if (!/^[a-z0-9-]+$/.test(j.slug || '')) errors.push(`${j.n}: slug must be kebab-case`);
  for (const bl of j.coverBullets || []) if (!cv.includes(norm(bl))) errors.push(`${j.n}: cover bullet not verbatim in cv.md: "${String(bl).slice(0, 90)}"`);
  (j.stories || []).forEach((k) => { if (!lib.stories[k]) errors.push(`${j.n}: unknown story key "${k}" (add it under newStories)`); });
  if ((j.storyMap || []).length !== (j.stories || []).length) errors.push(`${j.n}: storyMap and stories differ in length`);
  if (discards[j.n]) errors.push(`${j.n}: both evaluated and discarded`);
}
for (const n of Object.keys(discards)) if (!byN.has(n)) errors.push(`discard ${n}: not in batch.json`);
if (errors.length) { console.error('judgments.json rejected:\n  ' + errors.join('\n  ')); process.exit(1); }

// ── report assembly (structure of the 2026-09-23 run's reports) ─────────────
const ic = { strong: '✅ Strong', partial: '⚠️ Partial', missing: '❌ Missing', na: '➖ N/A' };
const y = (s) => (s === null || s === undefined) ? 'null' : JSON.stringify(s);
const yList = (a, ind = '  ') => (a && a.length) ? '\n' + a.map((x) => `${ind}- ${y(x)}`).join('\n') : ' []';

const firstSeen = new Map();
if (fs.existsSync('data/scan-history.tsv')) {
  for (const l of fs.readFileSync('data/scan-history.tsv', 'utf8').split('\n').slice(1)) {
    const [u, date] = l.split('\t');
    if (u && date && (!firstSeen.has(u) || date < firstSeen.get(u))) firstSeen.set(u, date);
  }
}

function machine(j) {
  return `\`\`\`yaml
company: ${y(j.company)}
role: ${y(j.role)}
score: ${j.score.toFixed(1)}
legitimacy_tier: ${y(j.legit)}
archetype: ${y(j.archetype)}
final_decision: ${y(j.decision)}
hard_stops:${yList(j.hard)}
soft_gaps:${yList(j.soft)}
top_strengths:${yList(j.strengths)}
risk_level: ${y(j.risk)}
confidence: ${y(j.confidence || 'Medium')}
next_action: ${y(j.next)}
work_auth: "not_needed"
discard_reasons:${yList(j.discard)}
via: null
company_confidential: false
advertised_comp: ${y(j.comp || null)}
reports_to: ${y(j.reportsTo || null)}
requirement_importance:${j.reqs.length ? '\n' + j.reqs.map((r) => `  - requirement: ${y(r[0])}
    jd_signal: ${y(r[2] === 'inferred' ? null : r[1])}
    evidence: ${y(r[2])}
    importance: ${y(r[3])}
    match: ${y(r[4])}`).join('\n') : ' []'}
risk_summary:
  legitimacy: ${y(j.legit.toLowerCase().replace(/ /g, '_'))}
  classification: "clear"
  culture: ${y((j.culture || ['pass'])[0])}
  interview_redflags: "not_evaluated"
  ai_infra: "not_evaluated"
  ai_screening_disclosure: "not_evaluated"
\`\`\``;
}

function report(j, b, num) {
  const posted = b.posted || 'not visible in source';
  const culture0 = (j.culture || ['pass'])[0];
  const culture = culture0 === 'pass' ? '✅ pass' : `⚠️ ${culture0} — ${(j.culture || [])[1] || ''}`;
  const legitRow = j.legit === 'High Confidence' ? '✅ High Confidence' : `⚠️ ${j.legit} — ${j.legitReason || ''}`;
  const reqRows = j.reqs.map((r) => `| ${r[0]} | ${r[2] === 'stated' ? '"' + r[1] + '"' : r[2] === 'structural' ? r[1] : '—'} | ${r[2]} | ${r[3]} | ${ic[r[4]] || r[4]} | ${r[5]} |`).join('\n');
  const stories = j.stories.map((k, i) => { const s = lib.stories[k]; return `| ${i + 1} | ${j.storyMap[i]} | ${s[0]} | ${s[1]} | ${s[2]} | ${s[3]} | ${s[4]} | ${s[5]} |`; }).join('\n');
  const mk = lib.market;
  const compBlock = j.comp ? `| Source | Figure | Note |
|---|---|---|
| Advertised (JD) | ${j.comp} | JD |
${mk.rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}

- **Company type:** ${j.ctype}
- **Compensation reliability:** High — base range published per pay-transparency rules; ${j.compNote || ''}
- **Advertised range:** ${j.comp}
- **Likely guaranteed base:** ${j.baseGuess || 'within the advertised range; level-dependent'}
- **Variable / conditional cash:** annual incentive where eligible, not guaranteed
- **Expected stable cash:** the base offer only
- **Non-cash benefits:** ${j.benefits || 'medical/dental/vision, 401(k), PTO per JD'}

**HR verification questions:**
1. Which level/grade is this offer mapped to for a May 2027 graduate, and where in the posted range does that level usually land?
2. Is relocation assistance offered for this req, and is it a lump sum or managed move?
3. Is any shift differential or sign-on included, and is it guaranteed or conditional?
4. When would the start date be for a candidate graduating May 2027?` : `- **Company type:** ${j.ctype}
- **Compensation reliability:** Unknown — no advertised salary figure; skip component split, detailed market rows, and HR verification questions

Market reference (not an advertised figure, as of ${mk.as_of}): ${mk.line}`;
  const short = j.companyShort || j.company;
  const cover = `## Cover Letter Draft

> Draft generated at evaluation time. Complete via \`/career-ops cover ${j.slug}\` to fill in angles, confirm research, and generate the PDF.
> Gaps flagged below — address them during the cover flow.

---

**Opening** *(placeholder — refine with your "why this role" angle)*
${j.coverOpen}

**Profile introduction**
${lib.profileIntro}${j.coverIntro ? ' ' + j.coverIntro : ''}

**Key achievements** *(selected from cv.md — exact wording preserved)*
${j.coverBullets.map((t) => `- ${String(t).replace(/\.$/, '')}.`).join('\n')}

**Problems I will solve** *(placeholder — requires company research + your input)*
> To be completed: what challenges does ${short} face that you'd address? How would you approach them?

**Closing**
I am happy to discuss further at your convenience.

---

**Gaps flagged:**
${j.coverGaps.map((g) => `- ${g}`).join('\n')}

**JD keywords to mirror** *(extracted for ATS + human read)*
${j.keywords.slice(0, 10).join(', ')}

---
*Run \`/career-ops cover ${j.slug}\` to complete angles, confirm company research, and generate the PDF.*`;

  const jdRaw = fs.readFileSync(b.jdFile, 'utf8');
  const jd = jdRaw.slice(jdRaw.indexOf('\n\n') + 2).trim();
  const seen = firstSeen.get(b.url);
  const li = lib.linkedin;
  return `# Evaluation: ${j.company} — ${j.role}

**Date:** ${DATE}
**URL:** ${b.url}
**Via:** — (direct application)
**Archetype:** ${j.archetype}
**Score:** ${j.score.toFixed(1)}/5
**Legitimacy:** ${j.legit}
**Work Auth:** ➖ Not needed
**PDF:** not generated — run /career-ops pdf ${j.slug} to create on demand
**Verification:** live — liveness sweep ${b.liveness} (check-liveness.mjs, ${DATE}); JD text via ${b.jdVia}

---

## Machine Summary

${machine(j)}

## A) Role Summary

| Field | Value |
|---|---|
| Archetype detected | ${j.archetype} |
| Domain | ${j.domain || '—'} |
| Function | ${j.func || '—'} |
| Seniority | ${j.seniority || '—'} |
| Remote | ${j.remote || '—'} |
| Team size | ${j.team || 'not stated'} |
| Culture screen | ${culture} (no \`culture_screen\` configured in profile.yml; qualitative) |
| TL;DR | ${j.tldr} |

**Work authorization:** ➖ Not needed — role is in the United States, candidate is a U.S. citizen (\`config/profile.yml\` → \`needs_sponsorship: false\`). ${!j.authQuote || String(j.authQuote).startsWith('not stated') ? 'JD: ' + (j.authQuote || 'not stated') : 'JD: "' + j.authQuote + '"'}

## B) Match with CV

| Requirement | JD signal | Evidence | Importance | Match | Evidence / gap |
|---|---|---|---|---|---|
${reqRows}

### Gaps

${j.gaps.map((g, i) => `${i + 1}. **${g[0]}** — ${g[1]}`).join('\n')}

## C) Level and Strategy

${j.level}

**If they downlevel me:** entry level is already the right level. If the offer lands at the bottom of the range, ask for the level criteria for the next grade and a 12-month review.

## D) Comp and Demand

**Demand:** ${j.demand}

${compBlock}

## E) Customization Plan

| # | Section | Current status | Proposed change | Why |
|---|---|---|---|---|
${j.custom.map((c, i) => `| ${i + 1} | ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} |`).join('\n')}

**LinkedIn (top 5):** 1) Headline: "${li.headlinePrefix} | ${j.liHeadline || j.archetype}". 2) ${li.items[0]} 3) Skills: ${j.liSkills || j.keywords.slice(0, 5).join(', ')}. 4) ${li.items[1]} 5) Set open-to-work for ${j.liOpen || j.role}.

## F) Interview Plan

| # | JD Requirement | STAR+R Story | S | T | A | R | Reflection |
|---|---|---|---|---|---|---|---|
${stories}

**Recommended case study:** ${j.caseStudy}

**Red-flag questions:**
${j.redQs.map((q) => `- *"${q[0]}"* — ${q[1]}`).join('\n')}

## G) Posting Legitimacy

**Assessment:** ${j.legit}

| Signal | Finding | Weight |
|---|---|---|
| Posting freshness | Posted ${posted}; liveness sweep ${DATE}: ${b.liveness} | Positive |
| Apply path | Apply control present on the live posting | Positive |
| Description quality | ${j.descQ} | ${j.descW || 'Positive'} |
| Requirements realism | ${j.realism} | ${j.realismW || 'Positive'} |
| Reposting pattern | ${seen ? `First seen in scan-history ${seen}` : `No prior scan-history entry before ${DATE}`}${j.repost ? '; ' + j.repost : ''} | ${j.repostW || 'Neutral'} |
| Salary transparency | ${j.comp ? 'Range published: ' + j.comp : 'Not stated'} | ${j.comp ? 'Positive' : 'Neutral'} |
| Employment classification | ${j.classification || 'Full-time W-2 employee language; no contractor-style terms'} | Positive |

**Context notes:** ${j.legitNotes}

## Risk Summary

| Signal | Status |
|--------|--------|
| Posting legitimacy | ${legitRow} |
| Employment classification | ✅ clear |
| Culture screen | ${culture} |
| Interview red flags | — no interview sessions yet |
| AI claims vs. infrastructure | — not evaluated |
| AI-screening disclosure | — not evaluated |

---

## Keywords extracted

${j.keywords.join(', ')}

${cover}

## Job Description (archived verbatim)

Posted: ${posted}

${jd}
`;
}

// ── write ───────────────────────────────────────────────────────────────────
let nums = [];
if (jobs.length) {
  if (DRY) nums = jobs.map((_, i) => `D${String(i + 1).padStart(2, '0')}`);
  else {
    const out = execFileSync(process.execPath, [engineScript('reserve-report-num.mjs'), '--count', String(jobs.length)], { encoding: 'utf8' }).trim();
    const m = out.match(/(\d{3,})(?:\s*-\s*(\d{3,}))?/);
    if (!m) throw new Error(`reserve-report-num: unexpected output "${out}"`);
    const lo = +m[1], hi = m[2] ? +m[2] : lo;
    for (let k = lo; k <= hi; k++) nums.push(String(k).padStart(3, '0'));
    if (nums.length !== jobs.length) throw new Error(`reserved ${nums.length}, need ${jobs.length}`);
  }
}
fs.mkdirSync('batch/tracker-additions', { recursive: true });
const processed = [];
jobs.forEach((j, i) => {
  const b = byN.get(j.n), num = nums[i];
  const file = `reports/${num}-${j.slug}-${DATE}.md`;
  const text = report(j, b, num);
  if (DRY) { fs.writeFileSync(`${A}/dry-${j.n}.md`, text); console.log('dry report', `${A}/dry-${j.n}.md`, text.length, 'chars'); return; }
  fs.writeFileSync(file, text);
  const notes = `${j.note}${b.posted ? '; posted: ' + b.posted : ''}`.replace(/[\t\n]/g, ' ');
  fs.writeFileSync(`batch/tracker-additions/${num}-${j.slug}.tsv`,
    `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n${+num}\t${DATE}\t${j.company}\t${j.role}\tEvaluated\t${j.score.toFixed(1)}/5\t❌\t[${num}](${file})\t${notes}\t${b.url}\n`);
  processed.push({ url: b.url, line: `- [x] #${num} | ${b.url} | ${j.company} | ${j.role} | ${j.score.toFixed(1)}/5 | PDF ❌` });
  console.log(num, j.slug, j.score.toFixed(1));
});
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
let discardLog = '';
for (const [n, reason] of Object.entries(discards)) {
  const b = byN.get(n);
  processed.push({ url: b.url, line: `- [x] #-- | ${b.url} | ${b.company} | ${b.title} | skipped (pre-screen mismatch: ${reason})` });
  discardLog += `${now}\t${b.url}\t${reason}\n`;
}
if (DRY) { console.log(`dry run: ${jobs.length} reports, ${Object.keys(discards).length} discards; nothing written outside ${A}/`); process.exit(0); }

// pipeline.md: drop the Pending lines, prepend the Processed lines
if (processed.length) {
  const urls = new Set(processed.map((p) => p.url));
  const lines = fs.readFileSync('data/pipeline.md', 'utf8').split('\n');
  const kept = lines.filter((l) => !(l.startsWith('- [ ] ') && urls.has(l.slice(6).split(' | ')[0].trim())));
  const at = kept.findIndex((l) => l.trim() === '## Processed');
  kept.splice(at + 1, 0, '', ...processed.map((p) => p.line));
  fs.writeFileSync('data/pipeline.md', kept.join('\n'));
  if (discardLog) fs.appendFileSync('data/discard.log', discardLog);
}

// Report numbers are now real files; release the sentinels, then merge + verify.
if (nums.length) {
  try { execFileSync(process.execPath, [engineScript('reserve-report-num.mjs'), '--release', nums.length > 1 ? `${nums[0]}-${nums.at(-1)}` : nums[0]], { stdio: 'ignore' }); } catch { /* GC'd after 4h anyway */ }
  execFileSync(process.execPath, [engineScript('merge-tracker.mjs')], { stdio: 'inherit' });
}
if (J.newStories && Object.keys(J.newStories).length) fs.writeFileSync(`${A}/library.json`, JSON.stringify(lib, null, 1) + '\n');
try { execFileSync(process.execPath, [engineScript('verify-pipeline.mjs')], { stdio: 'inherit' }); } catch { console.error('verify-pipeline reported problems (see above)'); }
const left = batch.filter((b) => b.liveness !== 'expired' && !discards[b.n] && !jobs.some((j) => j.n === b.n)).map((b) => b.n);
console.log(`done: ${jobs.length} reports, ${Object.keys(discards).length} discards, ${left.length} batch items left pending${left.length ? ' (' + left.join(',') + ')' : ''}`);
