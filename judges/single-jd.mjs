// judges/single-jd.mjs — judge with one of the existing one-JD-at-a-time
// evaluators: openrouter-runner.mjs, gemini-eval.mjs, ollama-eval.mjs or
// openai-eval.mjs. Each writes a report + one tracker-addition TSV per call;
// this adapter feeds them the prep batch, then does the bookkeeping they leave
// to a human: stamp the posting's real company/role/URL onto the TSV and the
// report header (so merge-tracker dedups by URL and the board links to the
// posting), move the posting to Processed, and merge the tracker.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { ENGINE_ROOT, DATA_ROOT } from '../lib/board-config.mjs';

const EVALUATORS = {
  openrouter: (b) => ['openrouter-runner.mjs', 'evaluate', readFileSync(b.jdFile, 'utf8')],
  gemini: (b) => ['gemini-eval.mjs', '--posting-url', b.url, '--file', b.jdFile],
  ollama: (b) => ['ollama-eval.mjs', '--posting-url', b.url, '--file', b.jdFile],
  openai: (b) => ['openai-eval.mjs', '--posting-url', b.url, '--file', b.jdFile],
};

const additionsDir = () => process.env.CAREER_OPS_ADDITIONS || join(DATA_ROOT, 'batch', 'tracker-additions');
const listTsv = () => {
  const dir = additionsDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tsv')) : [];
};
const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

// Overwrite company/role/url in a headed tracker-addition TSV (the form every
// evaluator writes, #3517). Returns the row's fields by label.
export function stampTsv(text, { company, role, url }) {
  const [head, row, ...rest] = text.replace(/\r/g, '').split('\n');
  const labels = head.split('\t');
  const cells = (row || '').split('\t');
  const set = (label, value) => {
    let i = labels.indexOf(label);
    if (i < 0) { labels.push(label); i = labels.length - 1; }
    while (cells.length < labels.length) cells.push('');
    cells[i] = clean(value);
  };
  if (company) set('company', company);
  if (role) set('role', role);
  if (url) set('url', url);
  const fields = Object.fromEntries(labels.map((l, i) => [l, cells[i] ?? '']));
  return { text: [labels.join('\t'), cells.join('\t'), ...rest].join('\n'), fields };
}

export function stampReportUrl(md, url) {
  if (/^\*\*URL:\*\*\s*https?:\/\//m.test(md)) return md;
  if (/^\*\*URL:\*\*.*$/m.test(md)) return md.replace(/^\*\*URL:\*\*.*$/m, `**URL:** ${url}`);
  return `**URL:** ${url}\n${md}`;
}

// Same Pending → Processed move data/auto/gen.mjs does.
export function markProcessed(pipelineText, processed) {
  const urls = new Set(processed.map((p) => p.url));
  const lines = pipelineText.split('\n');
  const kept = lines.filter((l) => !(l.startsWith('- [ ] ') && urls.has(l.slice(6).split(' | ')[0].trim())));
  const at = kept.findIndex((l) => l.trim() === '## Processed');
  if (at < 0) kept.push('', '## Processed', '', ...processed.map((p) => p.line));
  else kept.splice(at + 1, 0, '', ...processed.map((p) => p.line));
  return kept.join('\n');
}

export async function runSingleJdJudge(name, { batch, cfg, budgetMs, log }) {
  const todo = batch.filter((b) => b.liveness !== 'expired' && b.jdFile && existsSync(b.jdFile)).slice(0, cfg.max_evaluations);
  if (!todo.length) return { evaluated: 0, note: 'no live postings with a job description to judge' };
  log(`judge: ${name} on ${todo.length} posting(s) (max_evaluations ${cfg.max_evaluations})`);
  const deadline = Date.now() + budgetMs;
  const processed = [];
  for (const [i, b] of todo.entries()) {
    const left = deadline - Date.now();
    if (left < 30_000) { log(`judge: time budget used up; ${todo.length - i} posting(s) stay Pending`); break; }
    const before = new Set(listTsv());
    const [script, ...args] = EVALUATORS[name](b);
    const r = spawnSync(process.execPath, [join(ENGINE_ROOT, script), ...args], {
      cwd: ENGINE_ROOT, encoding: 'utf8', timeout: Math.min(left, 10 * 60_000), maxBuffer: 32 * 1024 * 1024,
    });
    const fresh = listTsv().filter((f) => !before.has(f));
    if (!fresh.length) {
      const why = `${r.stderr || r.stdout || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      log(`  ${b.n} ${b.company} — ${b.title}: no evaluation written (exit ${r.status ?? r.signal})${why ? `: ${why}` : ''}`);
      continue;
    }
    const tsvPath = join(additionsDir(), fresh[0]);
    const { text, fields } = stampTsv(readFileSync(tsvPath, 'utf8'), { company: b.company, role: b.title, url: b.url });
    writeFileSync(tsvPath, text);
    const rel = (fields.report.match(/\(([^)]+)\)/) || [])[1];
    const reportPath = rel ? join(DATA_ROOT, rel) : '';
    if (reportPath && existsSync(reportPath)) writeFileSync(reportPath, stampReportUrl(readFileSync(reportPath, 'utf8'), b.url));
    const num = String(fields.num).padStart(3, '0');
    processed.push({ url: b.url, line: `- [x] #${num} | ${b.url} | ${clean(b.company)} | ${clean(b.title)} | ${fields.score || 'N/A'} | PDF ❌` });
    log(`  ${b.n} ${b.company} — ${b.title}: #${num} ${fields.score || '(no score)'}`);
  }
  if (processed.length) {
    const pipelinePath = join(DATA_ROOT, 'data', 'pipeline.md');
    writeFileSync(pipelinePath, markProcessed(readFileSync(pipelinePath, 'utf8'), processed));
    execFileSync(process.execPath, [join(ENGINE_ROOT, 'merge-tracker.mjs')], { cwd: ENGINE_ROOT, stdio: 'inherit' });
    try { execFileSync(process.execPath, [join(ENGINE_ROOT, 'verify-pipeline.mjs')], { cwd: ENGINE_ROOT, stdio: 'inherit' }); } catch { log('verify-pipeline reported problems (see above)'); }
  }
  return { evaluated: processed.length };
}
