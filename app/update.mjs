// app/update.mjs — "Check for updates" in the app.
//
// A git checkout updates with `git pull --ff-only`. A copy that came from
// GitHub's "Download ZIP" has no git, so the newest version is downloaded as a
// tarball and its files are written over the engine. Either way only engine
// files change: the data folder, .env, .career-ops-data and node_modules are
// never touched, and files you made yourself are never deleted.
//
// Where updates come from: package.json "careerOpsPortable.updateRepo"
// ("owner/repo") and ".branch", so a fork updates from itself.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join, normalize, sep } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = join(ENGINE, 'app', '.installed-commit');
const PRESERVE = ['.env', '.career-ops-data', 'node_modules/', 'app/.installed-commit', 'app/run-board.cmd'];

function source() {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')); } catch { /* defaults below */ }
  const c = pkg.careerOpsPortable || {};
  return { repo: c.updateRepo || 'samspicka6/career-ops-portable', branch: c.branch || 'main' };
}

const git = (args) => spawnSync('git', args, { cwd: ENGINE, encoding: 'utf8', timeout: 120_000 });
const isGitCheckout = () => existsSync(join(ENGINE, '.git')) && git(['--version']).status === 0;

async function latestCommit({ repo, branch }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'career-ops-portable' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  const j = await res.json();
  return { sha: j.sha, date: j.commit?.committer?.date || '', message: (j.commit?.message || '').split('\n')[0] };
}

// → { method, available, current, latest: {sha,date,message}, note? }
export async function checkForUpdate() {
  const src = source();
  if (isGitCheckout()) {
    const f = git(['fetch', '--quiet', 'origin', src.branch]);
    if (f.status !== 0) return { method: 'git', available: false, error: `git fetch failed: ${(f.stderr || '').trim()}` };
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(['rev-parse', 'FETCH_HEAD']).stdout.trim();
    const behind = Number(git(['rev-list', '--count', `HEAD..FETCH_HEAD`]).stdout.trim() || 0);
    const msg = git(['log', '-1', '--format=%s', 'FETCH_HEAD']).stdout.trim();
    return { method: 'git', available: behind > 0, current: head, latest: { sha: remote, message: msg }, behind };
  }
  const latest = await latestCommit(src);
  const current = existsSync(MARK) ? readFileSync(MARK, 'utf8').trim() : '';
  return {
    method: 'download', current, latest, available: current !== latest.sha,
    note: current ? '' : 'This copy came from a ZIP download, so its exact version is unknown. Updating brings it to the newest version.',
  };
}

// Minimal tar reader: regular files and directories, with pax/GNU long names
// (GitHub tarballs use a pax global header carrying the commit id).
export function* readTar(buf) {
  let off = 0;
  let longName = null;
  let pax = {};
  let globalPax = {};
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  const parsePax = (b) => {
    const out = {};
    let i = 0;
    const s = b.toString('utf8');
    while (i < s.length) {
      const sp = s.indexOf(' ', i);
      if (sp < 0) break;
      const len = Number(s.slice(i, sp));
      if (!len) break;
      const rec = s.slice(sp + 1, i + len - 1);
      const eq = rec.indexOf('=');
      out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return out;
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { globalPax = { ...globalPax, ...parsePax(body) }; continue; }
    if (type === 'x') { pax = parsePax(body); continue; }
    if (type === 'L') { longName = str(body); continue; }
    const prefix = str(h.subarray(345, 500));
    const name = pax.path || longName || (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    const mode = parseInt(str(h.subarray(100, 108)).trim() || '644', 8);
    pax = {};
    longName = null;
    yield { name, type: type === '\0' ? '0' : type, mode, body, globalPax };
  }
}

export function isPreserved(rel) {
  return PRESERVE.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

// Write the tarball's files over `root`. Returns { written, commit }.
export function applyTarball(tgz, root = ENGINE) {
  const buf = gunzipSync(tgz);
  let written = 0;
  let commit = '';
  for (const e of readTar(buf)) {
    commit ||= e.globalPax.comment || '';
    const rel = e.name.split('/').slice(1).join('/'); // drop "repo-branch/"
    if (!rel || isPreserved(rel)) continue;
    const dest = normalize(join(root, rel));
    if (!dest.startsWith(normalize(root) + sep)) continue; // never write outside the engine
    if (e.type === '5') { mkdirSync(dest, { recursive: true }); continue; }
    if (e.type !== '0') continue; // symlinks and the like are skipped
    mkdirSync(dirname(dest), { recursive: true });
    const prev = existsSync(dest) ? readFileSync(dest) : null;
    if (!prev || !prev.equals(e.body)) { writeFileSync(dest, e.body); written++; }
    if (process.platform !== 'win32' && e.mode & 0o111) { try { chmodSync(dest, 0o755); } catch { /* best effort */ } }
  }
  return { written, commit };
}

// → { ok, method, changed, packageChanged, log }
export async function applyUpdate() {
  const before = readFileSync(join(ENGINE, 'package.json'), 'utf8');
  if (isGitCheckout()) {
    const r = git(['pull', '--ff-only', 'origin', source().branch]);
    const log = `${r.stdout}${r.stderr}`.trim();
    if (r.status !== 0) return { ok: false, method: 'git', log: `${log}\n\nThe update could not be applied automatically (you may have changed engine files). Your data is untouched.` };
    return { ok: true, method: 'git', log, packageChanged: before !== readFileSync(join(ENGINE, 'package.json'), 'utf8') };
  }
  const src = source();
  const res = await fetch(`https://codeload.github.com/${src.repo}/tar.gz/refs/heads/${src.branch}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) return { ok: false, method: 'download', log: `Download failed: GitHub answered ${res.status}.` };
  const { written, commit } = applyTarball(Buffer.from(await res.arrayBuffer()));
  if (commit) writeFileSync(MARK, `${commit}\n`);
  return { ok: true, method: 'download', changed: written, log: `Updated ${written} file(s).`, packageChanged: before !== readFileSync(join(ENGINE, 'package.json'), 'utf8') };
}
