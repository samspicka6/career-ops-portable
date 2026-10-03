// lib/board-config.mjs — shared settings for `npm run setup` and `npm run board`.
//
// The board's choices (which judge evaluates postings, how many per run, which
// steps run) live in config/board.yml in the user layer, so an update never
// resets them. Everything has a default: a missing or partial file still runs.
// Keys/env loading is here too, so setup and board agree on where API keys are.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_ROOT = getCareerOpsRoot();
export const BOARD_CONFIG_PATH = join(DATA_ROOT, 'config', 'board.yml');

export const JUDGES = {
  claude: {
    label: 'Claude Code (claude -p)',
    needs: 'the Claude Code CLI on PATH, logged in',
    help: 'https://docs.claude.com/en/docs/claude-code',
  },
  openrouter: {
    label: 'OpenRouter free models (openrouter-runner.mjs)',
    needs: 'OPENROUTER_API_KEY in .env',
    env: 'OPENROUTER_API_KEY',
    help: 'https://openrouter.ai (free key)',
  },
  gemini: {
    label: 'Google Gemini (gemini-eval.mjs)',
    needs: 'GEMINI_API_KEY in .env',
    env: 'GEMINI_API_KEY',
    help: 'https://aistudio.google.com/apikey (free key)',
  },
  ollama: {
    label: 'Ollama, local and private (ollama-eval.mjs)',
    needs: 'Ollama running locally with a model pulled',
    help: 'https://ollama.com, then: ollama pull llama3.3',
  },
  openai: {
    label: 'Any OpenAI-compatible API (openai-eval.mjs)',
    needs: 'OPENAI_API_KEY (and optionally OPENAI_BASE_URL / OPENAI_MODEL) in .env',
    env: 'OPENAI_API_KEY',
    help: 'see .env.example',
  },
  none: {
    label: 'None: no AI, rank and verify postings only',
    needs: 'nothing',
  },
};

export const DEFAULTS = {
  judge: 'none',
  // Postings prep liveness-checks and fetches a JD for, per run.
  prep_count: 40,
  // Cap on postings an API judge evaluates per run (each one is a model call).
  max_evaluations: 10,
  scan: true,
  recheck: true,
  sweep: { enabled: false, minutes: 25, since_days: 4, ats: 'greenhouse,lever,ashby' },
  // Per-step time limits in minutes; a step over its limit is stopped and the run continues.
  budgets: { scan: 20, prep: 40, recheck: 15, judge: 60 },
  open: false,
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

export function loadBoardConfig(path = BOARD_CONFIG_PATH) {
  let file = {};
  if (existsSync(path)) {
    try { file = yaml.load(readFileSync(path, 'utf8')) || {}; } catch (e) {
      throw new Error(`${path} is not valid YAML: ${e.message}`);
    }
  }
  const cfg = merge(DEFAULTS, file);
  if (!JUDGES[cfg.judge]) throw new Error(`config/board.yml: unknown judge "${cfg.judge}" (choose: ${Object.keys(JUDGES).join(', ')})`);
  return cfg;
}

// Rewrites only the keys given, keeping the rest of the file (and its comments
// when the file came from config/board.example.yml) intact.
export function saveBoardConfig(updates, path = BOARD_CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  let text = existsSync(path) ? readFileSync(path, 'utf8')
    : existsSync(join(ENGINE_ROOT, 'config', 'board.example.yml')) ? readFileSync(join(ENGINE_ROOT, 'config', 'board.example.yml'), 'utf8')
      : '';
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
    const re = new RegExp(`^${k}:.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  }
  writeFileSync(path, text);
}

// .env lives next to the engine (that is where the eval scripts' dotenv looks).
export const ENV_PATH = join(ENGINE_ROOT, '.env');

export function readEnvFile(path = ENV_PATH) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadEnv() {
  for (const [k, v] of Object.entries(readEnvFile())) if (process.env[k] === undefined) process.env[k] = v;
}

const PLACEHOLDER = /your_|paste-your|_here$|^sk-or-v1-paste/i;
export function hasKey(name) {
  const v = process.env[name] ?? readEnvFile()[name];
  return Boolean(v && !PLACEHOLDER.test(v));
}

export function setEnvKey(name, value, path = ENV_PATH) {
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(`^#?\\s*${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.replace(/\n*$/, '\n')}${name}=${value}\n`;
  writeFileSync(path, text.replace(/^\n/, ''));
}

// On Windows `claude` is a .cmd/.exe shim that spawn() only finds through the shell.
export function commandWorks(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

export async function ollamaUp() {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const j = await res.json();
    return (j.models || []).length > 0;
  } catch { return false; }
}

// Which judges can run on this machine right now, in recommendation order.
export async function detectJudges() {
  const found = {};
  found.claude = commandWorks('claude');
  found.openrouter = hasKey('OPENROUTER_API_KEY');
  found.gemini = hasKey('GEMINI_API_KEY');
  found.ollama = await ollamaUp();
  found.openai = hasKey('OPENAI_API_KEY');
  found.none = true;
  return found;
}

// The board scripts (prep, recheck, gen, dashboard) live in auto/.
export function autoScript(name) {
  return join(ENGINE_ROOT, 'auto', name);
}
