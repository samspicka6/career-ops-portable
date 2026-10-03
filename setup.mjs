#!/usr/bin/env node
// setup.mjs — `npm run setup`: from a fresh clone to a personal, working
// career-ops in a few questions, with no AI involved.
//
//   1. data folder   where your CV, profile, tracker and reports live
//                    (init-data.mjs; default ../career-ops-data)
//   2. CV            paste it, or point at a .md / .txt / .pdf file
//   3. profile       name, contact, location, target roles → config/profile.yml
//                    and the target-roles table in modes/_profile.md
//   4. portals       title keywords, locations, and how to find postings
//   5. judge         who evaluates postings in `npm run board`
//                    (claude / openrouter / gemini / ollama / openai / none)
//
// Re-running is safe: every step shows what is already there and keeps it
// unless you say otherwise. For scripted installs every question has a flag;
// --yes takes the default for anything not given:
//   node setup.mjs --yes --data-dir ~/my-search --cv cv.pdf --roles "Data Analyst, BI Analyst" \
//     --location "Denver, CO" --locations "Denver, Remote" --portals sweep --judge none

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { ENGINE_ROOT, JUDGES, detectJudges, hasKey, loadBoardConfig, saveBoardConfig, setEnvKey } from './lib/board-config.mjs';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  if (['yes', 'in-place', 'entry-level', 'help', 'force'].includes(key)) opt[key] = true;
  else opt[key] = argv[++i];
}
if (opt.help && isMainModule(import.meta.url)) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const AUTO = Boolean(opt.yes) || !process.stdin.isTTY && !opt.interactive;

// ── prompting ───────────────────────────────────────────────────────────────
let rl = null;
const io = () => (rl ||= createInterface({ input: process.stdin, output: process.stdout }));
async function ask(question, dflt = '', flagValue) {
  if (flagValue !== undefined) return String(flagValue).trim();
  if (AUTO) return dflt;
  const a = (await io().question(`${question}${dflt ? ` [${dflt}]` : ''}: `)).trim();
  return a || dflt;
}
async function yesNo(question, dflt = false, flagValue) {
  if (flagValue !== undefined) return flagValue === true || /^(y|yes|true|1)$/i.test(String(flagValue));
  const a = await ask(`${question} (${dflt ? 'Y/n' : 'y/N'})`, '');
  return a ? /^y/i.test(a) : dflt;
}
async function choose(question, options, dfltKey, flagValue) {
  if (flagValue !== undefined) {
    if (!options.some((o) => o.key === flagValue)) throw new Error(`--${question.flag}: choose one of ${options.map((o) => o.key).join(', ')}`);
    return flagValue;
  }
  console.log(`\n${question.text}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.key === dfltKey ? '  ← recommended' : ''}`));
  if (AUTO) return dfltKey;
  for (;;) {
    const a = await ask('Pick a number', String(options.findIndex((o) => o.key === dfltKey) + 1));
    const o = options[Number(a) - 1] || options.find((x) => x.key === a);
    if (o) return o.key;
  }
}
async function pasteBlock(prompt) {
  console.log(`${prompt}\n(paste it, then type END on its own line and press Enter)`);
  const lines = [];
  for (;;) {
    let line;
    try { line = await io().question(''); } catch { break; }
    if (line.trim() === 'END') break;
    lines.push(line);
  }
  return lines.join('\n');
}
const say = (s = '') => console.log(s);
const heading = (n, t) => say(`\n── ${n}/5 · ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);
const list = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

// ── CV text helpers (zero-token, deliberately simple) ────────────────────────
const SECTION = /^(summary|profile|objective|professional summary|experience|work experience|professional experience|employment|education|projects|skills|technical skills|certifications|awards|honors|publications|leadership|activities|volunteer|languages|interests)\s*:?\s*$/i;

export function textToMarkdown(text) {
  const raw = text.replace(/\r/g, '').replace(/\f/g, '\n').replace(/\t/g, ' ');
  if (/^#\s/m.test(raw)) return raw.trim() + '\n';
  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
  const out = [];
  let named = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (out.length && out.at(-1) !== '') out.push(''); continue; }
    if (!named) { out.push(`# ${t}`, ''); named = true; continue; }
    if (SECTION.test(t)) {
      const title = t.replace(/:$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      if (out.at(-1) !== '') out.push('');
      out.push(`## ${title}`, '');
      continue;
    }
    const bullet = t.match(/^[•▪◦●○■□➢►\-–—*·]\s*(.+)$/);
    out.push(bullet ? `- ${bullet[1]}` : t.replace(/\s{2,}/g, ' '));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function contactFromCv(md) {
  const head = md.split('\n').slice(0, 15).join('\n');
  return {
    name: ((md.match(/^#\s+(.+)$/m) || [])[1] || '').trim(),
    email: (md.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0],
    phone: ((head.match(/(\+?\(?\d[\d\s().-]{8,}\d)/) || [])[1] || '').trim(),
    linkedin: (md.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i) || [''])[0],
    github: (md.match(/(?:https?:\/\/)?github\.com\/[\w-]+/i) || [''])[0],
  };
}

function readCvFile(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.pdf') {
    const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout.trim()) {
      throw new Error('could not read the PDF (needs pdftotext from Poppler: `brew install poppler`, `apt install poppler-utils`, or on Windows `choco install poppler`). You can also save the CV as .txt or paste it.');
    }
    return textToMarkdown(r.stdout.replace(/ {3,}/g, '  '));
  }
  if (ext === '.docx' || ext === '.doc') throw new Error('Word files are not read directly: save it as PDF or plain text, or paste it.');
  const text = readFileSync(file, 'utf8');
  return ext === '.md' ? text : textToMarkdown(text);
}

// ── profile.yml edits (keep the example's comments; verify, else re-dump) ────
const yq = (s) => JSON.stringify(String(s ?? ''));
function setLine(text, re, line) { return re.test(text) ? text.replace(re, line) : text; }
function replaceBlock(text, startRe, endRe, body) {
  const s = text.search(startRe);
  if (s < 0) return text;
  const afterStart = text.indexOf('\n', s) + 1;
  const rest = text.slice(afterStart);
  const e = rest.search(endRe);
  return text.slice(0, afterStart) + body + (e < 0 ? '' : rest.slice(e));
}

export function fillProfile(template, p) {
  let t = template;
  t = setLine(t, /^  full_name: .*$/m, `  full_name: ${yq(p.name)}`);
  t = setLine(t, /^  email: .*$/m, `  email: ${yq(p.email)}`);
  t = setLine(t, /^  phone: .*$/m, `  phone: ${yq(p.phone)}`);
  t = setLine(t, /^  location: ".*$/m, `  location: ${yq(p.location)}`);
  t = setLine(t, /^  linkedin: .*$/m, `  linkedin: ${yq(p.linkedin)}`);
  t = setLine(t, /^  portfolio_url: .*$/m, '  portfolio_url: ""');
  t = setLine(t, /^  github: .*$/m, `  github: ${yq(p.github)}`);
  t = setLine(t, /^  twitter: .*$/m, '  twitter: ""');
  t = replaceBlock(t, /^  primary:\s*$/m, /^  # Archetypes|^  archetypes:/m, p.roles.map((r) => `    - ${yq(r)}\n`).join(''));
  // Archetypes and narrative are regenerated only from the template or when the
  // roles changed, so re-running setup never wipes what the user refined by hand.
  if (p.fresh || p.rolesChanged) {
    t = replaceBlock(t, /^  archetypes:\s*$/m, /^\S/m, p.roles.map((r, i) =>
      `    - name: ${yq(r)}\n      level: ${yq(p.level)}\n      fit: "${i === 0 ? 'primary' : 'secondary'}"\n`).join('') + '\n');
  }
  if (p.fresh) {
    t = replaceBlock(t, /^narrative:\s*$/m, /^\S/m,
      `  headline: ${yq(p.headline)}\n  exit_story: ""\n  superpowers: []\n  proof_points: []\n\n`);
  }
  t = setLine(t, /^  target_range: .*$/m, `  target_range: ${yq(p.comp)}`);
  t = setLine(t, /^  minimum: .*$/m, `  minimum: ${yq(p.compMin)}`);
  t = setLine(t, /^  location_flexibility: .*$/m, `  location_flexibility: ${yq(p.flex)}`);
  t = setLine(t, /^  country: .*$/m, `  country: ${yq(p.country)}`);
  t = setLine(t, /^  city: .*$/m, `  city: ${yq(p.city)}`);
  t = setLine(t, /^  timezone: .*$/m, `  timezone: ${yq(p.timezone)}`);
  t = setLine(t, /^  visa_status: .*$/m, `  visa_status: ${yq(p.visa)}`);
  t = setLine(t, /^  authorized_in: .*$/m, `  authorized_in: ${JSON.stringify(p.authorizedIn)}`);
  t = setLine(t, /^  needs_sponsorship: .*$/m, `  needs_sponsorship: ${p.needsSponsorship}`);
  // Verify the text edits landed; if the template drifted, fall back to a dump.
  let doc;
  try { doc = yaml.load(t); } catch { doc = null; }
  const ok = doc && doc.candidate?.full_name === p.name && doc.target_roles?.primary?.[0] === p.roles[0] && doc.location?.city === p.city;
  if (ok) return t;
  const d = yaml.load(template) || {};
  d.candidate = { ...d.candidate, full_name: p.name, email: p.email, phone: p.phone, location: p.location, linkedin: p.linkedin, github: p.github, portfolio_url: '', twitter: '' };
  d.target_roles = { ...d.target_roles, primary: p.roles };
  if (p.fresh || p.rolesChanged) d.target_roles.archetypes = p.roles.map((r, i) => ({ name: r, level: p.level, fit: i === 0 ? 'primary' : 'secondary' }));
  if (p.fresh) d.narrative = { headline: p.headline, exit_story: '', superpowers: [], proof_points: [] };
  d.compensation = { ...d.compensation, target_range: p.comp, minimum: p.compMin, location_flexibility: p.flex };
  d.location = { ...d.location, country: p.country, city: p.city, timezone: p.timezone, visa_status: p.visa, authorized_in: p.authorizedIn, needs_sponsorship: p.needsSponsorship };
  return yaml.dump(d, { lineWidth: 120 });
}

// The archetype table is what evaluations score fit against; the template's
// table is someone else's targeting, so replace it with the user's roles.
export function fillProfileModes(template, roles) {
  const table = ['| Archetype | Thematic axes | What they buy |', '|-----------|---------------|---------------|',
    ...roles.map((r) => `| **${r}** | (from cv.md: the skills this role uses) | Someone who can do ${r} work from day one |`)].join('\n');
  const s = template.indexOf('## Your Target Roles');
  if (s < 0) return `${template}\n\n## Your Target Roles\n\n${table}\n`;
  const tStart = template.indexOf('| Archetype', s);
  if (tStart < 0) return template;
  let tEnd = tStart;
  const lines = template.slice(tStart).split('\n');
  for (const l of lines) { if (!l.startsWith('|')) break; tEnd += l.length + 1; }
  return template.slice(0, tStart) + table + '\n' + template.slice(tEnd);
}

// ── portals.yml edits ───────────────────────────────────────────────────────
export function fillPortals(template, { keywords, locations, entryLevel }) {
  let t = template;
  const tf = t.search(/^title_filter:\s*$/m);
  if (tf >= 0 && keywords.length) {
    const head = t.slice(0, tf);
    let body = t.slice(tf);
    body = replaceBlock(body, /^  positive:\s*$/m, /^  negative:\s*$/m,
      `    # Written by npm run setup from your target roles. Substring match; see the notes above.\n${keywords.map((k) => `    - ${yq(k)}\n`).join('')}`);
    t = head + body;
  }
  if (entryLevel) t = t.replace(/^    - "Junior"\s*\n/m, '');
  if (locations.length && !/^location_filter:/m.test(t)) {
    const block = `# Written by npm run setup. Postings whose structured location matches none of
# these are skipped; edit freely (see the location_filter notes above).
location_filter:
  allow:
${locations.map((l) => `    - ${yq(l)}\n`).join('')}
`;
    const at = t.search(/^title_filter:\s*$/m);
    t = at >= 0 ? t.slice(0, at) + block + t.slice(at) : `${t}\n${block}`;
  }
  return t;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  say('career-ops setup — your CV, profile, job sources and board in five steps. No AI needed.');

  // 1. data folder
  heading(1, 'Where your data lives');
  const markerPath = join(ENGINE_ROOT, '.career-ops-data');
  const envDir = process.env.CAREER_OPS_ROOT || process.env.CAREER_OPS_DATA_DIR;
  let root = getCareerOpsRoot();
  const inPlaceData = root === ENGINE_ROOT && existsSync(join(ENGINE_ROOT, 'cv.md'));
  if (envDir || existsSync(markerPath)) {
    say(`Using your data folder: ${root}`);
  } else if (opt['in-place'] || (inPlaceData && !opt['data-dir'])) {
    say(`Keeping your data in this checkout (${ENGINE_ROOT}).`);
  } else {
    say('Your CV, profile and tracker go in their own folder, so this checkout stays a clean engine you can update.');
    const dir = await ask('Data folder', '../career-ops-data', opt['data-dir']);
    const r = spawnSync(process.execPath, [join(ENGINE_ROOT, 'init-data.mjs'), dir], { cwd: ENGINE_ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`init-data failed: ${r.stderr || r.stdout}`);
    root = resolve(ENGINE_ROOT, dir);
    say(`Created ${root} and pointed this checkout at it.`);
  }
  const P = (rel) => join(root, rel);
  const seed = (rel, tpl) => { if (!existsSync(P(rel)) && existsSync(join(ENGINE_ROOT, tpl))) { mkdirSync(join(P(rel), '..'), { recursive: true }); copyFileSync(join(ENGINE_ROOT, tpl), P(rel)); } };
  seed('config/profile.yml', 'config/profile.example.yml');
  seed('portals.yml', 'templates/portals.example.yml');
  seed('modes/_profile.md', 'modes/_profile.template.md');
  seed('modes/_custom.md', 'modes/_custom.template.md');
  mkdirSync(P('data'), { recursive: true });
  if (!existsSync(P('data/applications.md'))) writeFileSync(P('data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  if (!existsSync(P('data/pipeline.md'))) writeFileSync(P('data/pipeline.md'), '# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n');

  // 2. CV
  heading(2, 'Your CV');
  const cvPath = P('cv.md');
  const cvNow = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
  const cvIsStub = !cvNow.trim() || /^# Your Name\b/m.test(cvNow);
  let cv = cvNow;
  if (!cvIsStub && !opt.cv) {
    say(`cv.md already holds a CV (${cvNow.split('\n')[0].replace(/^#\s*/, '')}).`);
  }
  if (opt.cv || cvIsStub || (!AUTO && await yesNo('Replace it?', false))) {
    let source = opt.cv;
    if (!source && !AUTO) source = await ask('Path to your CV file (.md, .txt or .pdf), or press Enter to paste it', '');
    if (source) cv = readCvFile(resolve(process.cwd(), source.replace(/^["']|["']$/g, '')));
    else if (!AUTO) cv = textToMarkdown(await pasteBlock('Paste your CV text:'));
    if (cv.trim() && cv !== cvNow) { writeFileSync(cvPath, cv); say(`Saved cv.md (${cv.split('\n').length} lines). Check the headings once: it was converted without AI.`); }
    else if (cvIsStub) say('No CV given: cv.md is still the stub. Re-run setup or edit cv.md before judging postings.');
  }
  const contact = contactFromCv(cv);

  // 3. profile
  heading(3, 'Profile');
  const profilePath = P('config/profile.yml');
  let current = {};
  try { current = yaml.load(readFileSync(profilePath, 'utf8')) || {}; } catch { current = {}; }
  const isTemplate = !current.candidate?.full_name || current.candidate.full_name === 'Jane Smith';
  const c = isTemplate ? {} : current.candidate || {};
  let doProfile = isTemplate || opt.roles || opt.name;
  if (!doProfile) { say(`config/profile.yml is already yours (${c.full_name}).`); doProfile = !AUTO && await yesNo('Update it?', false); }
  let roles = list(opt.roles) || [];
  if (doProfile) {
    const name = await ask('Full name', c.full_name || contact.name, opt.name);
    const email = await ask('Email', c.email || contact.email, opt.email);
    const phone = await ask('Phone (optional)', c.phone || contact.phone, opt.phone);
    const location = await ask('Where you live (City, ST/Country)', c.location || '', opt.location);
    const country = await ask('Country', current.location?.country && !isTemplate ? current.location.country : 'United States', opt.country);
    const needsSponsorship = await yesNo(`Will you need visa sponsorship to work in ${country}?`, !isTemplate && current.location?.needs_sponsorship === true, opt.sponsorship);
    const prevRoles = !isTemplate ? (current.target_roles?.primary || []).join(', ') : '';
    for (;;) {
      roles = list(await ask('Target roles, comma-separated (e.g. "Data Analyst, BI Analyst")', prevRoles, opt.roles));
      if (roles.length || AUTO) break;
      say('  At least one role, please: it drives the scan filter and how postings are scored.');
    }
    if (!roles.length) throw new Error('no target roles given (use --roles "Role A, Role B")');
    const level = await ask('Level you are targeting (e.g. Entry level, Mid, Senior)', opt['entry-level'] ? 'Entry level' : '', opt.level);
    const comp = await ask('Target pay range (optional, e.g. "$70K-90K")', !isTemplate ? current.compensation?.target_range || '' : '', opt.comp);
    const flex = await ask('Remote / relocation preference (optional)', !isTemplate ? current.compensation?.location_flexibility || '' : '', opt.flex);
    const tpl = isTemplate ? readFileSync(join(ENGINE_ROOT, 'config', 'profile.example.yml'), 'utf8') : readFileSync(profilePath, 'utf8');
    const city = location.split(',')[0].trim();
    writeFileSync(profilePath, fillProfile(tpl, {
      name, email, phone, location, linkedin: c.linkedin || contact.linkedin, github: c.github || contact.github,
      fresh: isTemplate, rolesChanged: roles.join('|') !== (current.target_roles?.primary || []).join('|'),
      roles, level, headline: `${roles[0]}${level ? ` (${level})` : ''}`, comp, compMin: '', flex,
      country, city, timezone: !isTemplate ? current.location?.timezone || '' : '',
      needsSponsorship, authorizedIn: needsSponsorship ? [] : [country],
      visa: needsSponsorship ? `Needs sponsorship to work in ${country}` : `Authorized to work in ${country}, no sponsorship needed`,
    }));
    say('Saved config/profile.yml.');
    const modesPath = P('modes/_profile.md');
    const modesTpl = readFileSync(join(ENGINE_ROOT, 'modes', '_profile.template.md'), 'utf8');
    const modesNow = existsSync(modesPath) ? readFileSync(modesPath, 'utf8') : modesTpl;
    if (modesNow === modesTpl || opt.force) { writeFileSync(modesPath, fillProfileModes(modesTpl, roles)); say('Wrote your target roles into modes/_profile.md (refine the table any time).'); }
    else say('modes/_profile.md is already personalized; left as is.');
  } else {
    roles = current.target_roles?.primary || [];
  }

  // 4. portals
  heading(4, 'Where to look for jobs');
  const portalsPath = P('portals.yml');
  const portalsNow = readFileSync(portalsPath, 'utf8');
  const portalsTpl = readFileSync(join(ENGINE_ROOT, 'templates', 'portals.example.yml'), 'utf8');
  const portalsIsTemplate = portalsNow === portalsTpl;
  const how = await choose({ text: 'How should the board find postings?', flag: 'portals' }, [
    { key: 'sweep', label: 'Keyword sweep: search every public Greenhouse, Lever and Ashby board for your keywords (any industry, no company list)' },
    { key: 'starter', label: 'Starter list: 200+ preset companies (mostly tech and AI), filtered by your keywords' },
    { key: 'both', label: 'Both' },
    { key: 'keep', label: 'Keep my current portals.yml as is' },
  ], portalsIsTemplate ? 'sweep' : 'keep', opt.portals);
  if (how !== 'keep') {
    const keywords = list(await ask('Title keywords to match (comma-separated)', roles.join(', '), opt.keywords));
    const locations = list(await ask('Only show postings in these locations (comma-separated, e.g. "Denver, Remote"; blank = anywhere)', '', opt.locations));
    const entryLevel = opt['entry-level'] || (!AUTO && await yesNo('Are you looking for entry-level roles? (keeps "Junior" titles in)', false));
    writeFileSync(portalsPath, fillPortals(portalsIsTemplate ? portalsTpl : portalsNow, { keywords, locations, entryLevel }));
    say(`Saved portals.yml (${keywords.length} keyword(s)${locations.length ? `, ${locations.length} location(s)` : ''}).`);
  }

  // 5. judge
  heading(5, 'Who judges the postings');
  say('The board scans, ranks and liveness-checks postings for free. Optionally a model then reads each');
  say('job description and writes a scored report. Checking what this computer has...');
  const boardPath = P('config/board.yml');
  let existing = {};
  try { existing = existsSync(boardPath) ? loadBoardConfig(boardPath) : {}; } catch { existing = {}; }
  const found = await detectJudges();
  const order = ['claude', 'ollama', 'gemini', 'openrouter', 'openai', 'none'];
  const recommended = existing.judge && existsSync(boardPath) ? existing.judge : order.find((k) => found[k]);
  const judge = await choose({ text: 'Pick a judge:', flag: 'judge' },
    order.map((k) => ({ key: k, label: `${JUDGES[k].label}${found[k] ? '  ✓ ready' : `  (needs ${JUDGES[k].needs})`}` })), recommended, opt.judge);
  const envName = JUDGES[judge].env;
  if (envName && !hasKey(envName)) {
    say(`${JUDGES[judge].label} needs ${envName}. Get one at ${JUDGES[judge].help}.`);
    const key = await ask(`Paste ${envName} (stored in .env, never committed; blank to add later)`, '', opt.key);
    if (key) { setEnvKey(envName, key); say('Saved to .env.'); } else say(`Add ${envName}=... to .env before running the board.`);
  }
  if (judge === 'ollama' && !found.ollama) say('Start Ollama and pull a model before running the board: ollama pull llama3.3');
  if (judge === 'claude' && !found.claude) say('Install Claude Code and run `claude` once to log in: https://docs.claude.com/en/docs/claude-code');
  saveBoardConfig({
    judge,
    scan: how === 'sweep' ? false : existing.scan ?? true,
    sweep: { ...(existing.sweep || { minutes: 25, since_days: 4, ats: 'greenhouse,lever,ashby' }), enabled: how === 'sweep' || how === 'both' ? true : existing.sweep?.enabled ?? false },
  }, boardPath);
  say(`Saved config/board.yml (judge: ${judge}).`);

  // done
  const doctor = spawnSync(process.execPath, [join(ENGINE_ROOT, 'doctor.mjs'), '--json'], { cwd: ENGINE_ROOT, encoding: 'utf8' });
  let health = {};
  try { health = JSON.parse(doctor.stdout); } catch { /* advisory */ }
  say('\n── Done ' + '─'.repeat(57));
  if (health.onboardingNeeded) say(`Still missing: ${health.missing.join(', ')}`);
  for (const u of health.unpersonalized || []) say(`Heads-up: ${u.path} ${u.reason}.`);
  say(`Your data: ${root}`);
  say('Next:  npm run board            scan, verify, judge and build your job board');
  say('       npm run board -- --open  same, then open it in the browser');
  say('Re-run npm run setup any time to change any of this.');
}

if (isMainModule(import.meta.url)) {
  main().then(() => rl?.close(), (e) => { rl?.close(); console.error(`\nsetup: ${e.message}`); process.exit(1); });
}
