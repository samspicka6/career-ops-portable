#!/usr/bin/env node
// app/launch.mjs — what the double-click launchers run (`npm start` too).
//
//   1. checks the Node version
//   2. installs or refreshes dependencies when package.json changed since the
//      last install (first run, or after an update)
//   3. starts the local app (app/server.mjs) and opens it in the browser
//
// Uses only Node built-ins, because it runs before `npm install` has.

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isMainModule } from '../lib/is-main-module.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = join(ENGINE, 'node_modules', '.career-ops-install-stamp');

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`\nCareer-Ops needs Node.js 18 or newer; this computer has ${process.version}.`);
  console.error('Install the current LTS version from https://nodejs.org and start Career-Ops again.\n');
  process.exit(1);
}

function installHash() {
  const h = createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    if (existsSync(join(ENGINE, f))) h.update(readFileSync(join(ENGINE, f)));
  }
  return h.digest('hex');
}

export function needsInstall() {
  if (!existsSync(join(ENGINE, 'node_modules', 'js-yaml'))) return true;
  try { return readFileSync(STAMP, 'utf8').trim() !== installHash(); } catch { return true; }
}

// npm sits next to node in every official install; put that folder first on
// PATH so a Node that was installed a minute ago is found without a new login.
export function runNpmInstall({ quiet = false } = {}) {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` };
  if (!quiet) {
    console.log('\nInstalling what Career-Ops needs (first run or after an update).');
    console.log('This downloads a few hundred MB, including a browser used to check that postings are still open.');
    console.log('It can take a few minutes; keep this window open.\n');
  }
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ENGINE, env, stdio: 'inherit', shell: process.platform === 'win32' });
  const ok = r.status === 0;
  if (ok || existsSync(join(ENGINE, 'node_modules', 'js-yaml'))) {
    mkdirSync(join(ENGINE, 'node_modules'), { recursive: true });
    if (ok) writeFileSync(STAMP, installHash());
  }
  return ok;
}

async function main() {
  if (needsInstall()) {
    const ok = runNpmInstall();
    if (!ok && !existsSync(join(ENGINE, 'node_modules', 'js-yaml'))) {
      console.error('\nThe install did not finish. Check your internet connection and start Career-Ops again.');
      console.error('If it keeps failing, see "Troubleshooting" in README.md.\n');
      process.exit(1);
    }
    if (!ok) console.warn('\nPart of the install reported a problem (often the optional browser download). Starting anyway.\n');
  }
  const { startServer } = await import(pathToFileURL(join(ENGINE, 'app', 'server.mjs')).href);
  await startServer({ open: !process.argv.includes('--no-open') });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`\nCareer-Ops could not start: ${e.message}\n`); process.exit(1); });
}
