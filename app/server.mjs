// app/server.mjs — the local Career-Ops app: a setup wizard and a home screen
// in the browser, so nobody has to type a command.
//
// It is a thin layer over the same scripts the terminal uses:
//   setup wizard  → node setup.mjs --yes --cv … --roles …   (one source of truth)
//   Find new jobs → node board.mjs                          (live log in the page)
//   Open board    → serves output/career-dashboard.html from your data folder
// plus daily scheduling (app/schedule.mjs) and updates (app/update.mjs).
//
// It listens on 127.0.0.1 only. Every request must carry the right Host header
// (blocks DNS rebinding) and every POST the per-launch token embedded in the
// page (blocks other websites from driving it).
//
// Start it with the double-click launcher, `npm start`, or `node app/launch.mjs`.

import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, extname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { JUDGES, detectJudges, hasKey, loadBoardConfig } from '../lib/board-config.mjs';
import { textToMarkdown, contactFromCv } from '../setup.mjs';
import { cvFileToText } from '../lib/cv-text.mjs';
import { getSchedule, setSchedule, scheduleWarning } from './schedule.mjs';
import { checkForUpdate, applyUpdate } from './update.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ENGINE, 'app', 'public');
const FIRST_PORT = Number(process.env.CAREER_OPS_PORT) || 4747;
const TOKEN = randomBytes(18).toString('hex');
const MAX_BODY = 20 * 1024 * 1024;

// The default home for a new user's data: outside the app folder, so deleting
// or replacing the app (a fresh ZIP download) never loses it.
export const DEFAULT_DATA_DIR = join(homedir(), 'career-ops-data');

// ── helpers ──────────────────────────────────────────────────────────────────
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const loadYaml = (f) => { try { return yaml.load(read(f)) || {}; } catch { return {}; } };
const mtime = (f) => { try { return statSync(f).mtime.toISOString(); } catch { return null; } };
const markerPath = join(ENGINE, '.career-ops-data');

export function openExternal(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${target}"`]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref();
    return true;
  } catch { return false; }
}

// A fresh ZIP download has no .career-ops-data marker. If the default data
// folder already holds a setup, point this copy at it instead of starting over.
export function adoptExistingData() {
  if (process.env.CAREER_OPS_ROOT || process.env.CAREER_OPS_DATA_DIR || existsSync(markerPath)) return false;
  if (existsSync(join(ENGINE, 'cv.md'))) return false; // data kept inside this copy
  if (!existsSync(join(DEFAULT_DATA_DIR, 'config', 'profile.yml'))) return false;
  writeFileSync(markerPath, `${DEFAULT_DATA_DIR}\n`);
  return true;
}

function isConfigured(root) {
  return root !== ENGINE || existsSync(join(ENGINE, 'cv.md'));
}

function lastRunInfo(root) {
  const log = read(join(root, 'data', 'board.log')).trimEnd().split('\n');
  // The newest finished run that searched (a --build-only rebuild doesn't count).
  let finished = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].match(/^(\S+) === board run finished in (\d+) min(?: · steps with problems: (.*))?/);
    if (m) { finished = { at: m[1], minutes: Number(m[2]), problems: m[3] ? m[3].split(', ') : [] }; continue; }
    if (finished && / === board run: /.test(log[i])) {
      if (!log[i].includes('(build only)')) return finished;
      finished = null;
    }
  }
  return null;
}

function countRows(root) {
  const t = read(join(root, 'data', 'applications.md'));
  return t.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length;
}

export function getState() {
  const root = getCareerOpsRoot();
  const configured = isConfigured(root);
  const cv = configured ? read(join(root, 'cv.md')) : '';
  const cvReal = Boolean(cv.trim()) && !/^# Your Name\b/m.test(cv);
  const profile = configured ? loadYaml(join(root, 'config', 'profile.yml')) : {};
  const profileReal = Boolean(profile.candidate?.full_name) && profile.candidate.full_name !== 'Jane Smith';
  const portals = configured ? loadYaml(join(root, 'portals.yml')) : {};
  let board = {};
  try { board = loadBoardConfig(join(root, 'config', 'board.yml')); } catch { board = {}; }
  const boardFile = join(root, 'output', 'career-dashboard.html');
  const queueFile = join(root, 'output', 'queue.html');
  return {
    engine: ENGINE,
    platform: process.platform,
    node: process.version,
    dataDir: configured ? root : null,
    defaultDataDir: DEFAULT_DATA_DIR,
    setupDone: configured && cvReal && profileReal && existsSync(join(root, 'portals.yml')) && existsSync(join(root, 'config', 'board.yml')),
    cv: cvReal ? cv : '',
    profile: profileReal ? {
      name: profile.candidate?.full_name || '', email: profile.candidate?.email || '', phone: profile.candidate?.phone || '',
      location: profile.candidate?.location || '', country: profile.location?.country || '',
      sponsorship: profile.location?.needs_sponsorship === true,
      roles: profile.target_roles?.primary || [], level: profile.target_roles?.archetypes?.[0]?.level || '',
      comp: profile.compensation?.target_range || '', flex: profile.compensation?.location_flexibility || '',
    } : null,
    portals: {
      keywords: portals.title_filter?.positive || [],
      locations: portals.location_filter?.allow || [],
      entryLevel: !(portals.title_filter?.negative || []).includes('Junior'),
      sweep: Boolean(board.sweep?.enabled), scan: board.scan !== false,
    },
    judge: board.judge || 'none',
    judges: Object.fromEntries(Object.entries(JUDGES).map(([k, j]) => [k, { label: j.label, needs: j.needs, env: j.env || '', help: j.help || '', hasKey: j.env ? hasKey(j.env) : null }])),
    outputs: { board: mtime(boardFile), queue: mtime(queueFile) },
    tracked: configured ? countRows(root) : 0,
    lastRun: configured ? lastRunInfo(root) : null,
    run: publicRun(),
    scheduleWarning: scheduleWarning(),
  };
}

// ── CV conversion ────────────────────────────────────────────────────────────
// The page sends pasted text, or the chosen file as base64; files are read here
// (lib/cv-text.mjs: pdf.js for PDF, mammoth for Word), so nothing leaves the
// computer and no internet is needed.
export async function convertCv({ fileName = '', text, base64 }) {
  const ext = extname(fileName).toLowerCase();
  let raw = typeof text === 'string' ? text : '';
  if (!raw.trim() && base64) raw = await cvFileToText(Buffer.from(base64, 'base64'), ext);
  if (!raw.trim()) throw new Error('No CV text found. Paste your CV in the box, or choose a PDF, Word (.docx) or text file.');
  const markdown = ext === '.md' ? raw.replace(/\r/g, '').trim() + '\n' : textToMarkdown(raw);
  return { markdown, contact: contactFromCv(markdown) };
}

// ── setup: run setup.mjs non-interactively with the wizard's answers ─────────
export function setupArgs(a, cvFile, { hasMarker = existsSync(markerPath) } = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean).join(', ');
  const args = [join(ENGINE, 'setup.mjs'), '--yes'];
  const add = (flag, v) => { if (v !== undefined && v !== null) args.push(`--${flag}`, String(v)); };
  if (!hasMarker && !process.env.CAREER_OPS_ROOT && !process.env.CAREER_OPS_DATA_DIR) add('data-dir', a.dataDir || DEFAULT_DATA_DIR);
  if (cvFile) add('cv', cvFile);
  add('name', a.name || '');
  add('email', a.email || '');
  add('phone', a.phone || '');
  add('location', a.location || '');
  add('country', a.country || 'United States');
  add('sponsorship', a.sponsorship ? 'yes' : 'no');
  add('roles', list(a.roles));
  add('level', a.level || '');
  add('comp', a.comp || '');
  add('flex', a.flex || '');
  add('portals', ['sweep', 'starter', 'both', 'keep'].includes(a.portals) ? a.portals : 'sweep');
  add('keywords', list(a.keywords) || list(a.roles));
  add('locations', list(a.locations));
  if (a.entryLevel) args.push('--entry-level');
  add('judge', JUDGES[a.judge] ? a.judge : 'none');
  if (a.apiKey && String(a.apiKey).trim()) add('key', String(a.apiKey).trim());
  return args;
}

function runSetup(answers) {
  if (!String(answers.name || '').trim()) throw new Error('Please enter your name.');
  if (!(Array.isArray(answers.roles) ? answers.roles : String(answers.roles || '').split(',')).some((r) => String(r).trim())) throw new Error('Please add at least one job title you want.');
  const root = getCareerOpsRoot();
  const current = isConfigured(root) ? read(join(root, 'cv.md')) : '';
  let cvFile = null;
  const md = String(answers.cvMarkdown || '').replace(/\r/g, '');
  if (md.trim() && md.trim() !== current.trim()) {
    cvFile = join(tmpdir(), `career-ops-cv-${randomBytes(6).toString('hex')}.md`);
    writeFileSync(cvFile, md.trim() + '\n');
  }
  if (!md.trim() && !current.trim()) throw new Error('Please add your CV first.');
  const r = spawnSync(process.execPath, setupArgs(answers, cvFile), { cwd: ENGINE, encoding: 'utf8', timeout: 120_000 });
  if (cvFile) { try { unlinkSync(cvFile); } catch { /* temp file */ } }
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(output.split('\n').filter(Boolean).pop() || 'Setup failed.');
  // init-data writes the marker relative to this folder; make it absolute so
  // moving the app folder (say, out of Downloads) keeps finding the data.
  const marker = read(markerPath).trim();
  if (marker && !isAbsolute(marker)) writeFileSync(markerPath, `${resolve(ENGINE, marker)}\n`);
  return { output, state: getState() };
}

// ── board runs ───────────────────────────────────────────────────────────────
let current = null; // { id, mode, startedAt, lines[], exitCode, done }
let runSeq = 0;
function publicRun(since = 0) {
  if (!current) return null;
  return { id: current.id, mode: current.mode, startedAt: current.startedAt, done: current.done, exitCode: current.exitCode, total: current.lines.length, lines: current.lines.slice(since) };
}

function startRun(mode) {
  if (current && !current.done) return publicRun();
  const args = [join(ENGINE, 'board.mjs')];
  if (mode === 'build') args.push('--build-only');
  current = { id: ++runSeq, mode, startedAt: new Date().toISOString(), lines: [], exitCode: null, done: false };
  const run = current;
  const child = spawn(process.execPath, args, { cwd: ENGINE, stdio: ['ignore', 'pipe', 'pipe'] });
  const push = (chunk) => {
    for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l.trim()) run.lines.push(l.replace(/\x1b\[[0-9;]*m/g, ''));
    if (run.lines.length > 5000) run.lines.splice(0, run.lines.length - 5000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { run.lines.push(`Could not start: ${e.message}`); run.done = true; run.exitCode = 1; });
  child.on('close', (code) => { run.done = true; run.exitCode = code; });
  return publicRun();
}

// ── http ─────────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { fail(new Error('That file is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new Error('Bad request.')); } });
    req.on('error', fail);
  });
}

function missingPage(what) {
  return `<!doctype html><meta charset="utf-8"><title>Not built yet</title><body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px">
<h1>No ${what} yet</h1><p>Go back to Career-Ops and press <b>Find new jobs</b>. The ${what} appears here when the run finishes.</p>
<p><a href="/">Back to Career-Ops</a></p>`;
}

export function createApp({ port }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === 'GET') {
        if (p === '/api/ping') return send(res, 200, { app: 'career-ops' });
        if (p === '/' || p === '/index.html') return send(res, 200, read(join(PUBLIC, 'index.html')).replace('%%TOKEN%%', TOKEN), TYPES['.html']);
        if (p === '/app.js' || p === '/app.css') return send(res, 200, read(join(PUBLIC, p.slice(1))), TYPES[extname(p)]);
        if (p === '/api/state') return send(res, 200, getState());
        if (p === '/api/run') return send(res, 200, { run: publicRun(Number(url.searchParams.get('since')) || 0) });
        if (p === '/board' || p === '/queue') {
          const root = getCareerOpsRoot();
          const f = join(root, 'output', p === '/board' ? 'career-dashboard.html' : 'queue.html');
          return existsSync(f) ? send(res, 200, readFileSync(f), TYPES['.html']) : send(res, 200, missingPage(p === '/board' ? 'job board' : 'job queue'), TYPES['.html']);
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (req.headers['x-career-ops-token'] !== TOKEN) return send(res, 403, { error: 'This page is out of date. Reload it.' });
      const body = await readBody(req);
      switch (p) {
        case '/api/cv': return send(res, 200, await convertCv(body));
        case '/api/setup': return send(res, 200, runSetup(body));
        case '/api/judges': return send(res, 200, { found: await detectJudges() });
        case '/api/run': return send(res, 200, { run: startRun(body.mode === 'build' ? 'build' : 'full') });
        case '/api/open-folder': {
          const root = getCareerOpsRoot();
          return send(res, 200, { ok: isConfigured(root) && openExternal(root) });
        }
        case '/api/schedule': return send(res, 200, body.get ? getSchedule() : setSchedule(body));
        case '/api/update/check': return send(res, 200, await checkForUpdate());
        case '/api/update/apply': return send(res, 200, await applyUpdate());
        case '/api/quit':
          send(res, 200, { ok: true });
          setTimeout(() => process.exit(0), 200);
          return undefined;
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });
}

async function alreadyRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).app === 'career-ops';
  } catch { return false; }
}

function listen(server, port) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
}

export async function startServer({ open = true } = {}) {
  if (adoptExistingData()) console.log(`Found your data from an earlier install: ${DEFAULT_DATA_DIR}`);
  for (let port = FIRST_PORT; port < FIRST_PORT + 20; port++) {
    if (await alreadyRunning(port)) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Career-Ops is already open at ${url}`);
      if (open) openExternal(url);
      return null;
    }
    const server = createApp({ port });
    try {
      await listen(server, port);
    } catch (e) {
      if (e.code === 'EADDRINUSE') continue;
      throw e;
    }
    const url = `http://127.0.0.1:${port}/`;
    console.log('\n  Career-Ops is running.');
    console.log(`  Your browser should open by itself. If it does not, open: ${url}`);
    console.log('  Keep this window open while you use Career-Ops; close it when you are done.\n');
    if (open) openExternal(url);
    return { server, url, port };
  }
  throw new Error(`no free port between ${FIRST_PORT} and ${FIRST_PORT + 19}`);
}
