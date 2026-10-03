#!/usr/bin/env node
// auto/config.mjs — shared settings for the automated scan/pipeline scripts.
//
// Everything person-specific the nightly run needs (title patterns used to
// rank the queue, which employers count as "big", the pre-screen rules in the
// judging prompt, the job board's heading) lives in the
// `auto_scan:` block of config/profile.yml — see config/profile.example.yml.
// This module reads that block through the engine's data-root resolver
// (path-resolver.mjs: CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / .career-ops-data)
// and fills in neutral defaults for anything missing, so the scripts in auto/
// carry no one's targeting.
//
// CLI (used by the PowerShell wrappers, which cannot parse YAML):
//   node auto/config.mjs root                 data root (absolute)
//   node auto/config.mjs get <dotted.key>     one auto_scan value ('' if unset)
//   node auto/config.mjs prompt <name> [--out <file>]
//                                             render auto/prompts/<name>.md

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as loadYaml } from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE = path.resolve(HERE, '..');
export const DATA_ROOT = getCareerOpsRoot();
export const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || path.join(DATA_ROOT, 'config/profile.yml');

/** Absolute path of an engine script, for spawning it from inside the data root. */
export const engineScript = (name) => path.join(ENGINE, name);

/** Run the rest of the script from the data root, where the relative data paths live. */
export function enterDataRoot() {
  process.chdir(DATA_ROOT);
}

export const DEFAULTS = {
  board: {
    title: 'Job Board',
    eyebrow: 'career-ops · job search',
    artifact_url: '',
  },
  candidate: {
    experience: 'an entry-level candidate',
    graduation_year: null,
    earliest_start: '',
    degree_fields: [],
  },
  ranking: {
    entry_level_titles: [
      'Engineer I', 'Engineer 1', 'Associate', 'Entry Level', 'Entry-Level', 'Junior',
      'New Grad', 'New Grads', 'New Graduate', 'Recent Grad', 'Recent Graduate',
      'Early Career', 'Level 1', 'Rotational', 'Development Program',
    ],
    discipline_titles: [],
    big_employers: [],
  },
  prescreen: {
    off_target_kinds: 'off-archetype',
    discard_internships: true,
  },
  discovery: {
    industries: '',
    max_per_run: 15,
  },
};

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/** The profile's auto_scan block merged over DEFAULTS. A missing profile yields the defaults. */
export function loadAutoConfig(profilePath = PROFILE_PATH) {
  let block = {};
  if (fs.existsSync(profilePath)) {
    const doc = loadYaml(fs.readFileSync(profilePath, 'utf8')) || {};
    block = doc.auto_scan || {};
  }
  return merge(DEFAULTS, block);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One alternation regex from a list of title words. Plain entries match as
 * whole words ("Engineer I" does not match "Engineer II"); an entry written as
 * /.../ is used as a raw regex fragment. Returns null for an empty list.
 */
export function wordListRegex(list, { anchored = false } = {}) {
  const parts = (list || []).map(String).filter(Boolean).map((w) => {
    if (w.length > 2 && w.startsWith('/') && w.endsWith('/')) return w.slice(1, -1);
    const body = escapeRe(w);
    const lead = anchored ? '' : (/^\w/.test(w) ? '\\b' : '');
    return `${lead}${body}${/\w$/.test(w) ? '\\b' : ''}`;
  });
  if (!parts.length) return null;
  return new RegExp(anchored ? `^(?:${parts.join('|')})` : `(?:${parts.join('|')})`, 'i');
}

/** Pre-screen criteria for the judging prompt, built from the candidate block. */
function discardCriteria(cfg) {
  const c = cfg.candidate;
  const out = [`requires years of experience ${c.experience} lacks`];
  const fields = c.degree_fields || [];
  if (fields.length) out.push(`restricts the degree to a major other than ${fields.join(' or ')} without "or related"`);
  if (c.earliest_start) out.push(`needs a start date before ${c.earliest_start}`);
  if (cfg.prescreen.off_target_kinds) out.push(`is ${cfg.prescreen.off_target_kinds}`);
  if (cfg.prescreen.discard_internships) out.push('is an intern/co-op');
  return out.length > 1 ? `${out.slice(0, -1).join(', ')}, or ${out.at(-1)}` : out[0];
}

function discoveryBlock(cfg) {
  const d = cfg.discovery;
  if (!d.industries) {
    return 'Company discovery: digest.md lists "Discovery candidates". This profile sets no\n' +
      'auto_scan.discovery.industries, so do NOT add companies to portals.yml this run;\n' +
      'append one TSV line per candidate to data/auto-scan-companies.log\n' +
      '(date, skipped, company, board, "discovery not configured").';
  }
  return `Company discovery: digest.md lists "Discovery candidates" (employers in
Pending not in portals.yml or data/auto-scan-companies.log). ADD only ones you
can confidently identify as ${d.industries} (max ${d.max_per_run}/run): write a YAML
\`companies: [{name, slug}]\` (or \`{name, workday: <url>}\`) and run
\`node ${path.join(ENGINE, 'discover-ats.mjs')} --in <file> --write --summary\`, then normalize
portals.yml to CRLF: \`node -e "const f=require('fs');f.writeFileSync('portals.yml',f.readFileSync('portals.yml','utf8').replace(/\\r\\n/g,'\\n').replace(/\\n/g,'\\r\\n'))"\`.
SKIP everything else and anything uncertain; do not web-research. Append one
TSV line per decision to data/auto-scan-companies.log
(date, added|skipped, company, board, reason).`;
}

/** Render auto/prompts/<name>.md, substituting {{placeholders}} from the config. */
export function renderPrompt(name, cfg = loadAutoConfig()) {
  const file = path.join(HERE, 'prompts', `${name}.md`);
  const vars = {
    discard_criteria: discardCriteria(cfg),
    discovery: discoveryBlock(cfg),
    artifact_url: cfg.board.artifact_url,
    engine: ENGINE,
    data_root: DATA_ROOT,
    board_file: path.join(DATA_ROOT, 'output', 'career-dashboard.artifact.html'),
  };
  return fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`prompt ${name}: unknown placeholder ${m}`);
    return vars[k];
  });
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

if (isMainModule(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const outAt = process.argv.indexOf('--out');
  if (cmd === 'root') console.log(DATA_ROOT);
  else if (cmd === 'engine') console.log(ENGINE);
  else if (cmd === 'get' && arg) {
    const v = get(loadAutoConfig(), arg);
    console.log(v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));
  } else if (cmd === 'prompt' && arg) {
    const text = renderPrompt(arg);
    if (outAt > 0 && process.argv[outAt + 1]) fs.writeFileSync(process.argv[outAt + 1], text);
    else process.stdout.write(text);
  } else {
    console.error('usage: node auto/config.mjs root | engine | get <dotted.key> | prompt <name> [--out <file>]');
    process.exit(1);
  }
}
