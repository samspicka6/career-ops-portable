// app/schedule.mjs — "find new jobs every day" without touching cron by hand.
//
// One daily run of board.mjs, registered with whatever the OS uses:
//   Windows  Task Scheduler (schtasks), task "Career-Ops Board"
//   macOS    a LaunchAgent, ~/Library/LaunchAgents/org.career-ops.board.plist
//   Linux    a crontab line tagged "# career-ops-board"
// The computer has to be on (and, on Windows, signed in) at that time; a run
// that is missed is simply done the next day.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, posix } from 'path';
import { fileURLToPath } from 'url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = join(ENGINE, 'board.mjs');
const NODE = process.execPath;
const TASK = 'Career-Ops Board';
const LABEL = 'org.career-ops.board';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const CRON_TAG = '# career-ops-board';

const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 20_000 });
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// macOS blocks background jobs from Desktop, Documents and Downloads unless the
// user grants access, so a daily run from there fails quietly. Say so up front.
export function scheduleWarning(platform = process.platform, engine = ENGINE, home = homedir()) {
  if (platform !== 'darwin') return '';
  const protectedDir = ['Desktop', 'Documents', 'Downloads'].find((d) => engine.startsWith(posix.join(home, d) + '/'));
  return protectedDir
    ? `The Career-Ops folder is inside ${protectedDir}, where macOS stops background jobs from reading files. Move the folder to your home folder (${home}) first, then turn daily runs on.`
    : '';
}

export function getSchedule() {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST', '/V']);
    if (r.status !== 0) return { enabled: false };
    const m = r.stdout.match(/Start Time:\s*(\d{1,2}):(\d{2})/i);
    return { enabled: true, time: m ? `${m[1].padStart(2, '0')}:${m[2]}` : '' };
  }
  if (process.platform === 'darwin') {
    if (!existsSync(PLIST)) return { enabled: false };
    const t = readFileSync(PLIST, 'utf8');
    const h = (t.match(/<key>Hour<\/key>\s*<integer>(\d+)/) || [])[1];
    const m = (t.match(/<key>Minute<\/key>\s*<integer>(\d+)/) || [])[1];
    return { enabled: true, time: h ? `${h.padStart(2, '0')}:${(m || '0').padStart(2, '0')}` : '' };
  }
  const r = run('crontab', ['-l']);
  const line = (r.stdout || '').split('\n').find((l) => l.includes(CRON_TAG));
  if (!line) return { enabled: false };
  const [min, hour] = line.trim().split(/\s+/);
  return { enabled: true, time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` };
}

export function cronLine(time, node = NODE, engine = ENGINE) {
  const [h, m] = time.split(':').map(Number);
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${m} ${h} * * * cd ${q(engine)} && ${q(node)} board.mjs >/dev/null 2>&1 ${CRON_TAG}`;
}

export function plistFor(time, node = NODE, engine = ENGINE) {
  const [h, m] = time.split(':').map(Number);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(join(engine, 'board.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(engine)}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

// Returns { ok, enabled, time, error? }.
export function setSchedule({ enabled, time }) {
  if (enabled && !validTime(time)) return { ok: false, error: 'Pick a time like 07:00.' };
  if (process.platform === 'win32') {
    if (!enabled) {
      run('schtasks', ['/Delete', '/TN', TASK, '/F']);
      return { ok: true, enabled: false };
    }
    // /TR is limited to 261 characters; a long install path would overflow it,
    // so the task runs a tiny .cmd that lives next to the engine.
    const cmd = join(ENGINE, 'app', 'run-board.cmd');
    writeFileSync(cmd, `@echo off\r\ncd /d "${ENGINE}"\r\n"${NODE}" "${BOARD}"\r\n`);
    const r = run('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', time, '/TN', TASK, '/TR', `"${cmd}"`]);
    return r.status === 0 ? { ok: true, enabled: true, time } : { ok: false, error: (r.stderr || r.stdout || 'schtasks failed').trim() };
  }
  if (process.platform === 'darwin') {
    run('launchctl', ['unload', PLIST]);
    if (!enabled) {
      if (existsSync(PLIST)) unlinkSync(PLIST);
      return { ok: true, enabled: false };
    }
    const warn = scheduleWarning();
    if (warn) return { ok: false, error: warn };
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, plistFor(time));
    const r = run('launchctl', ['load', '-w', PLIST]);
    return r.status === 0 ? { ok: true, enabled: true, time } : { ok: false, error: (r.stderr || 'launchctl failed').trim() };
  }
  const now = run('crontab', ['-l']);
  const kept = (now.status === 0 ? now.stdout : '').split('\n').filter((l) => l && !l.includes(CRON_TAG));
  if (enabled) kept.push(cronLine(time));
  const r = run('crontab', ['-'], kept.length ? `${kept.join('\n')}\n` : '');
  if (r.error?.code === 'ENOENT') return { ok: false, error: 'This computer has no crontab command, so daily runs cannot be set up from here.' };
  return r.status === 0 ? { ok: true, enabled: Boolean(enabled), time } : { ok: false, error: (r.stderr || 'crontab failed').trim() };
}
