// tests/app.test.mjs — the no-terminal app (app/): setup flags, CV reading,
// the local server's guards, daily scheduling text and the ZIP-copy updater.
import http from 'http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { pass, fail, rmSync } from './helpers.mjs';
import { setupArgs, convertCv, createApp } from '../app/server.mjs';
import { cronLine, plistFor, scheduleWarning } from '../app/schedule.mjs';
import { readTar, applyTarball, isPreserved } from '../app/update.mjs';
import { itemsToText, cvFileToText } from '../lib/cv-text.mjs';

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
console.log('\napp/ — local app: setup flags, CV text, server guards, schedule, updater');

// setup flags: the wizard's answers become setup.mjs flags
const args = setupArgs({
  name: 'Alex Rivera', email: 'a@x.test', location: 'Denver, CO', roles: ['Data Analyst', 'BI Analyst'],
  keywords: [], locations: ['Denver', 'Remote'], entryLevel: true, judge: 'gemini', apiKey: ' k123 ', portals: 'bogus', sponsorship: false,
}, '/tmp/cv.md', { hasMarker: false });
const flag = (f) => args[args.indexOf(`--${f}`) + 1];
check(args.includes('--yes') && flag('cv') === '/tmp/cv.md', 'setup runs unattended with the CV file');
check(flag('roles') === 'Data Analyst, BI Analyst' && flag('keywords') === 'Data Analyst, BI Analyst', 'empty keywords fall back to the roles');
check(flag('locations') === 'Denver, Remote' && args.includes('--entry-level'), 'locations and entry level are passed');
check(flag('portals') === 'sweep' && flag('judge') === 'gemini' && flag('key') === 'k123', 'an unknown source falls back to the sweep; the key is trimmed');
check(flag('sponsorship') === 'no' && Boolean(flag('data-dir')), 'sponsorship is explicit and a first run gets a data folder');
check(!setupArgs({ name: 'A', roles: ['X'] }, null, { hasMarker: true }).includes('--data-dir'), 'an existing data folder is not asked again');
check(setupArgs({ name: 'A', roles: ['X'], judge: 'nope' }, null, { hasMarker: true }).includes('none'), 'an unknown judge falls back to none');

// CV text
const fromItems = itemsToText([{ str: 'Alex', transform: [1, 0, 0, 1, 0, 700] }, { str: ' Rivera', transform: [1, 0, 0, 1, 40, 700] }, { str: 'EXPERIENCE', transform: [1, 0, 0, 1, 0, 650] }]);
check(fromItems === 'Alex Rivera\nEXPERIENCE', 'PDF text items on a new line start a new line');
const conv = await convertCv({ fileName: 'cv.txt', text: 'Alex Rivera\nalex@x.test\n\nSkills\nSQL\n' });
check(conv.markdown.startsWith('# Alex Rivera') && conv.contact.email === 'alex@x.test', 'pasted CV text becomes markdown with contact details');
const conv64 = await convertCv({ fileName: 'cv.txt', base64: Buffer.from('Sam Lee\nsam@x.test\n').toString('base64') });
check(conv64.contact.name === 'Sam Lee', 'a text file sent as base64 is read');
let threw = '';
try { await cvFileToText(Buffer.from('x'), '.doc'); } catch (e) { threw = e.message; }
check(/Save As/.test(threw), 'an old .doc file gets a plain explanation');
threw = '';
try { await convertCv({ fileName: 'cv.pdf', base64: Buffer.from('not a pdf').toString('base64') }); } catch (e) { threw = e.message; }
check(/paste/i.test(threw), 'an unreadable PDF asks for pasted text');

// server guards: right Host header, and the per-launch token on POSTs
// createApp checks the Host header against its port, so find a free port first.
const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const app = createApp({ port });
await new Promise((r) => app.listen(port, '127.0.0.1', r));
const req = (method, path, headers = {}, body) => new Promise((done) => {
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => done({ status: res.statusCode, body: d }));
  });
  if (body) r.write(body);
  r.end();
});
check((await req('GET', '/api/ping')).body.includes('career-ops'), 'the app answers on 127.0.0.1');
check((await req('GET', '/api/ping', { Host: `evil.test:${port}` })).status === 403, 'a foreign Host header is refused (DNS rebinding)');
check((await req('POST', '/api/quit', { 'Content-Type': 'application/json' }, '{}')).status === 403, 'a POST without the page token is refused');
const page = (await req('GET', '/')).body;
const token = (page.match(/name="career-ops-token" content="([0-9a-f]+)"/) || [])[1];
check(Boolean(token) && !page.includes('%%TOKEN%%'), 'the page carries the per-launch token');
const cvRes = await req('POST', '/api/cv', { 'Content-Type': 'application/json', 'X-Career-Ops-Token': token }, JSON.stringify({ fileName: 'a.txt', text: 'Jo Doe\n' }));
check(cvRes.status === 200 && JSON.parse(cvRes.body).markdown.startsWith('# Jo Doe'), 'a POST with the token works');
app.close();

// daily schedule (a made-up macOS home folder, built so no literal user path is checked in)
const MAC_HOME = ['', 'Users', 'a'].join('/');
check(cronLine('07:05', '/usr/bin/node', "/opt/it's here").startsWith("5 7 * * * cd '/opt/it'\\''s here' && '/usr/bin/node' board.mjs"), 'cron line quotes paths and sets the time');
const plist = plistFor('18:30', '/usr/local/bin/node', `${MAC_HOME}/career-ops & co`);
check(plist.includes('<integer>18</integer>') && plist.includes('<integer>30</integer>') && plist.includes('career-ops &amp; co'), 'LaunchAgent plist has the time and escapes paths');
check(/Downloads/.test(scheduleWarning('darwin', `${MAC_HOME}/Downloads/career-ops`, MAC_HOME)), 'macOS warns about a folder in Downloads');
check(scheduleWarning('darwin', `${MAC_HOME}/career-ops`, MAC_HOME) === '' && scheduleWarning('win32', 'C:\\Users\\a\\Downloads\\x', 'C:\\Users\\a') === '', 'no warning elsewhere');

// updater: tarball reading and writing over a ZIP copy
function tarEntry(name, body = '', type = '0', mode = 0o644) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body);
  return Buffer.concat([h, data]);
}
const pax = (k, v) => { const rec = ` ${k}=${v}\n`; let len = rec.length; len += String(len + String(len).length).length; return `${len}${rec}`; };
const tgz = gzipSync(Buffer.concat([
  tarEntry('pax_global_header', pax('comment', 'abc123'), 'g'),
  tarEntry('repo-main/', '', '5'),
  tarEntry('repo-main/board.mjs', 'new board'),
  tarEntry('repo-main/start.sh', '#!/bin/sh', '0', 0o755),
  tarEntry('repo-main/.env', 'SECRET=overwritten'),
  tarEntry('repo-main/node_modules/x.js', 'nope'),
  tarEntry('repo-main/../escape.txt', 'nope'),
  Buffer.alloc(1024),
]));
check([...readTar(gunzipSync(tgz))].some((e) => e.globalPax.comment === 'abc123'), 'the tar reader sees the commit id in the pax header');
const dir = mkdtempSync(join(tmpdir(), 'co-update-'));
const root = join(dir, 'engine');
mkdirSync(root);
writeFileSync(join(root, '.env'), 'SECRET=mine');
writeFileSync(join(root, 'board.mjs'), 'old board');
writeFileSync(join(root, 'mine.txt'), 'keep');
const r = applyTarball(tgz, root);
check(r.commit === 'abc123' && readFileSync(join(root, 'board.mjs'), 'utf8') === 'new board', 'engine files are replaced');
check(readFileSync(join(root, '.env'), 'utf8') === 'SECRET=mine' && !existsSync(join(root, 'node_modules')), '.env and node_modules are never touched');
check(existsSync(join(root, 'mine.txt')) && !existsSync(join(dir, 'escape.txt')), 'own files stay; nothing is written outside the folder');
check(isPreserved('.career-ops-data') && isPreserved('node_modules/a/b') && !isPreserved('app/server.mjs'), 'preserve list covers the marker and node_modules only');
rmSync(dir, { recursive: true, force: true });

