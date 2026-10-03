#!/usr/bin/env node
// board.mjs — `npm run board`: the whole daily run in one cross-platform command.
//
//   1. scan     scan.mjs: query every enabled portals.yml company     (no AI)
//   2. prep     rank the queue, liveness-check the top, fetch JDs     (no AI)
//   3. recheck  re-verify already-evaluated roles are still open      (no AI)
//   4. judge    evaluate the live postings: claude | openrouter | gemini |
//               ollama | openai | none            (config/board.yml `judge:`)
//   5. board    rebuild output/career-dashboard.html + output/queue.html (no AI)
//   6. sweep    optional reverse-ATS sweep; matches are queued for next run
//
// Each step has a time limit (config/board.yml `budgets`); a step that fails or
// runs over is reported and the run carries on, so the board always rebuilds.
// Nothing here submits or applies to anything.
//
// Usage:
//   npm run board                         full run with config/board.yml
//   npm run board -- --judge none         override the judge for this run
//   npm run board -- --build-only         just rebuild the board (no scan/judge)
//   npm run board -- --no-scan --no-recheck --open
//   npm run board -- --n 20 --max 5       prep 20 postings, judge at most 5
//   npm run board -- --sweep              also run the reverse ATS sweep
//
// Schedule it with cron / launchd / Task Scheduler (see docs/AUTOMATION.md).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { spawn, spawnSync } from 'child_process';
import { ENGINE_ROOT, DATA_ROOT, JUDGES, autoScript, loadBoardConfig, loadEnv } from './lib/board-config.mjs';
import { runJudge } from './judges/index.mjs';
import { writeQueuePage } from './lib/board-queue.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 24).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

loadEnv();
let cfg;
try { cfg = loadBoardConfig(); } catch (e) { console.error(`board: ${e.message}`); process.exit(1); }
if (value('--judge')) cfg.judge = value('--judge');
if (!JUDGES[cfg.judge]) { console.error(`board: unknown judge "${cfg.judge}" (choose: ${Object.keys(JUDGES).join(', ')})`); process.exit(1); }
if (value('--n')) cfg.prep_count = Number(value('--n'));
if (value('--max')) cfg.max_evaluations = Number(value('--max'));
if (flag('--no-scan')) cfg.scan = false;
if (flag('--no-recheck')) cfg.recheck = false;
if (flag('--sweep')) cfg.sweep.enabled = true;
if (flag('--open')) cfg.open = true;
const buildOnly = flag('--build-only');

mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
const LOG = join(DATA_ROOT, 'data', 'board.log');
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
function log(msg) {
  console.log(msg);
  try { appendFileSync(LOG, `${stamp()} ${msg}\n`); } catch { /* logging is best-effort */ }
}

// Run an engine script with a time limit, streaming its output. Resolves
// { ok, code, timedOut } — never rejects, so one bad step can't stop the run.
function step(label, script, args, minutes) {
  return new Promise((done) => {
    const started = Date.now();
    log(`--- ${label}: start (limit ${minutes} min)`);
    const child = spawn(process.execPath, [isAbsolute(script) ? script : join(ENGINE_ROOT, script), ...args], { cwd: ENGINE_ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, minutes * 60_000);
    child.on('error', (e) => { clearTimeout(timer); log(`--- ${label}: could not start (${e.message})`); done({ ok: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      log(`--- ${label}: ${timedOut ? `stopped at its ${minutes}-minute limit` : `done (exit ${code})`} in ${secs}s`);
      done({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

function openInBrowser(file) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* print the path instead */ }
}

// ── preflight ────────────────────────────────────────────────────────────────
const doctor = spawnSync(process.execPath, [join(ENGINE_ROOT, 'doctor.mjs'), '--json'], { cwd: ENGINE_ROOT, encoding: 'utf8' });
let health = {};
try { health = JSON.parse(doctor.stdout); } catch { /* doctor output is advisory here */ }
if (health.onboardingNeeded) {
  console.error(`board: setup isn't finished (missing: ${(health.missing || []).join(', ')}). Run: npm run setup`);
  process.exit(1);
}
for (const u of health.unpersonalized || []) log(`note: ${u.path} ${u.reason}; ${u.impact}. Run npm run setup to personalize it.`);

log(`=== board run: judge ${cfg.judge}${buildOnly ? ' (build only)' : ''} · data ${DATA_ROOT}`);
const t0 = Date.now();
const results = {};

if (!buildOnly) {
  if (cfg.scan) results.scan = await step('scan', 'scan.mjs', [], cfg.budgets.scan);
  results.prep = await step('prep', autoScript('prep.mjs'), ['--n', String(cfg.prep_count)], cfg.budgets.prep);
  if (cfg.recheck) results.recheck = await step('recheck', autoScript('recheck.mjs'), [], cfg.budgets.recheck);

  const batchPath = join(DATA_ROOT, 'data', 'auto', 'batch.json');
  if (cfg.judge !== 'none' && results.prep.ok && existsSync(batchPath)) {
    // prep writes jdFile relative to the data folder; judges run from the engine.
    const batch = JSON.parse(readFileSync(batchPath, 'utf8'))
      .map((b) => ({ ...b, jdFile: b.jdFile && !isAbsolute(b.jdFile) ? resolve(DATA_ROOT, b.jdFile) : b.jdFile }));
    log(`--- judge (${cfg.judge}): start (limit ${cfg.budgets.judge} min)`);
    try {
      const r = await runJudge(cfg.judge, { batch, cfg, budgetMs: cfg.budgets.judge * 60_000, log });
      results.judge = { ok: r.ok !== false, ...r };
      log(`--- judge: ${r.note || `${r.evaluated} posting(s) evaluated`}`);
    } catch (e) {
      results.judge = { ok: false };
      log(`--- judge: failed: ${e.message}`);
    }
  } else if (cfg.judge !== 'none') {
    log('--- judge: skipped (prep did not produce a batch)');
  }
}

results.board = await step('board', autoScript('dashboard.mjs'), [], 5);
const queue = writeQueuePage(DATA_ROOT);
log(`--- queue: ${queue.count} live posting(s) waiting → ${queue.path}`);

if (!buildOnly && cfg.sweep.enabled) {
  const left = Math.floor(cfg.sweep.minutes);
  const ckpt = join(DATA_ROOT, 'data', 'cache', 'ats-full-checkpoint.json');
  const args = ['--since', String(cfg.sweep.since_days), '--ats', cfg.sweep.ats];
  if (existsSync(ckpt)) args.push('--resume');
  results.sweep = await step('sweep', 'scan-ats-full.mjs', args, left);
}

const boardFile = join(DATA_ROOT, 'output', 'career-dashboard.html');
const failed = Object.entries(results).filter(([, r]) => r && r.ok === false).map(([k]) => k);
log(`=== board run finished in ${Math.round((Date.now() - t0) / 60000)} min${failed.length ? ` · steps with problems: ${failed.join(', ')}` : ''}`);
console.log(`\nJob board: ${boardFile}\nQueue:     ${queue.path}`);
if (cfg.open && existsSync(boardFile)) openInBrowser(cfg.judge === 'none' ? queue.path : boardFile);
process.exitCode = results.board.ok ? 0 : 1;
