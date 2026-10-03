// judges/claude.mjs — judge with Claude Code (`claude -p`).
//
// Claude reads the prep digest, pre-screens, and writes judgments.json; the
// zero-token data/auto/gen.mjs turns that into reports + tracker rows (Claude
// runs it itself so it can fix and re-run when gen rejects a field). The prompt
// lives in judges/claude-prompt.md. The prompt goes in on stdin, so nothing
// long or multi-line is ever passed through a shell (Windows-safe).

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ENGINE_ROOT, DATA_ROOT, autoScript } from '../lib/board-config.mjs';

// gen.mjs reads these library.json keys; a fresh data folder only has "stories".
const LIBRARY_SKELETON = {
  profileIntro: '',
  linkedin: { headlinePrefix: '', items: [] },
  market: { as_of: '', rows: [], line: '' },
  stories: {},
};

export function ensureLibrary(path) {
  let lib = {};
  if (existsSync(path)) { try { lib = JSON.parse(readFileSync(path, 'utf8')); } catch { lib = {}; } }
  let changed = !existsSync(path);
  for (const [k, v] of Object.entries(LIBRARY_SKELETON)) if (lib[k] === undefined) { lib[k] = v; changed = true; }
  if (changed) writeFileSync(path, JSON.stringify(lib, null, 1) + '\n');
}

const q = (a) => (process.platform === 'win32' && /[\s()*&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export async function runClaudeJudge({ batch, budgetMs, log }) {
  const auto = join(DATA_ROOT, 'data', 'auto');
  const live = batch.filter((b) => b.liveness !== 'expired' && b.jdFile);
  if (!live.length) return { evaluated: 0, note: 'no live postings with a job description to judge' };
  ensureLibrary(join(auto, 'library.json'));
  rmSync(join(auto, 'judgments.json'), { force: true });

  const fwd = (p) => p.replace(/\\/g, '/');
  const prompt = readFileSync(join(ENGINE_ROOT, 'judges', 'claude-prompt.md'), 'utf8')
    .replaceAll('{{AUTO}}/judgment.example.json', fwd(autoScript('judgment.example.json')))
    .replaceAll('node {{AUTO}}/gen.mjs', `node "${fwd(autoScript('gen.mjs'))}"`)
    .replaceAll('{{AUTO}}', 'data/auto');

  // No permission bypass: Claude may read/write files and run node, nothing else.
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash(node:*)', '--add-dir', ENGINE_ROOT];
  log(`judge: claude -p on ${live.length} posting(s)`);
  const r = spawnSync('claude', process.platform === 'win32' ? args.map(q) : args, {
    cwd: DATA_ROOT, input: prompt, encoding: 'utf8', timeout: budgetMs,
    maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  if (r.error?.code === 'ENOENT') throw new Error('claude CLI not found on PATH (install Claude Code, or pick another judge in config/board.yml)');
  if (r.stdout) log(r.stdout.trim());
  if (r.status !== 0) log(`judge: claude exited ${r.status ?? r.signal}${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  const wrote = existsSync(join(auto, 'judgments.json'));
  return { evaluated: wrote ? (JSON.parse(readFileSync(join(auto, 'judgments.json'), 'utf8')).jobs || []).length : 0, ok: r.status === 0 };
}
