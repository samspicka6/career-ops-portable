// Career-Ops local app — setup wizard and home screen. Talks only to the local
// server (app/server.mjs); PDF and Word files are read here in the browser.
'use strict';

const TOKEN = document.querySelector('meta[name="career-ops-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const listOf = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Career-Ops-Token': TOKEN }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('Career-Ops is not running. Double-click the Start Career-Ops file again.'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Something went wrong (${res.status}).`);
  return j;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

let S = null; // server state
let W = null; // wizard answers
let step = 0;

// ── wizard ───────────────────────────────────────────────────────────────────
const STEPS = ['Your CV', 'About you', 'Jobs you want', 'Where to look', 'AI helper', 'Finish'];

function startWizard() {
  const p = S.profile || {};
  W = {
    cvMarkdown: S.cv || '',
    name: p.name || '', email: p.email || '', phone: p.phone || '', location: p.location || '',
    country: p.country || 'United States', sponsorship: Boolean(p.sponsorship),
    roles: (p.roles || []).join(', '), level: p.level || '', comp: p.comp || '', flex: p.flex || '',
    keywords: S.portals.keywords.join(', '), keywordsEdited: false,
    locations: S.portals.locations.join(', '),
    entryLevel: S.setupDone ? S.portals.entryLevel : false,
    portals: S.setupDone ? 'keep' : 'sweep',
    judge: S.judge || 'none', apiKey: '',
    dataDir: S.dataDir || S.defaultDataDir,
  };
  step = 0;
  renderWizard();
}

function stepsBar() {
  return `<div class="steps">${STEPS.map((s, i) => `<span class="${i === step ? 'on' : i < step ? 'done' : ''}">${i + 1}. ${esc(s)}</span>`).join('')}</div>`;
}

function field(k, label, { type = 'text', hint = '', placeholder = '' } = {}) {
  return `<label for="f-${k}">${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</label>
  <input id="f-${k}" type="${type}" data-k="${k}" value="${esc(W[k])}" placeholder="${esc(placeholder)}">`;
}

function nav({ next = 'Next', back = true, nextDisabled = false } = {}) {
  return `<div class="actions">
    ${back ? '<button class="btn" data-go="back">Back</button>' : S.setupDone ? '<button class="btn" data-go="home">Cancel</button>' : '<span></span>'}
    <button class="btn primary" data-go="next" ${nextDisabled ? 'disabled' : ''}>${esc(next)}</button>
  </div>`;
}

const VIEWS = [
  // 1. CV
  () => W.cvMarkdown ? `
    <h1>Check your CV</h1>
    <p class="muted">This is the text Career-Ops will use. It was converted without AI, so fix anything that looks off: the first line should be your name, and sections start with <code>##</code>.</p>
    <textarea class="cv" data-k="cvMarkdown">${esc(W.cvMarkdown)}</textarea>
    <button class="btn link" id="cvReset">Use a different file</button>
    ${nav({ back: false })}` : `
    <h1>Add your CV</h1>
    <p class="muted">Career-Ops compares every job against your CV. It stays on this computer.</p>
    <div class="drop" id="drop" tabindex="0" role="button">
      <strong>Choose your CV file</strong>
      <span class="muted small">or drag it here · PDF, Word (.docx) or text</span>
    </div>
    <input type="file" id="file" accept=".pdf,.docx,.txt,.md,.text" hidden>
    <p id="cvStatus" class="small muted" style="margin-top:10px"></p>
    <label for="paste">Or paste your CV text</label>
    <textarea id="paste" placeholder="Paste the text of your CV here"></textarea>
    <div class="actions">${S.setupDone ? '<button class="btn" data-go="home">Cancel</button>' : '<span></span>'}<button class="btn primary" id="usePaste">Use this text</button></div>`,

  // 2. About you
  () => `
    <h1>About you</h1>
    <p class="muted">Used on your job board and to judge which jobs you can take. We filled in what we found in your CV.</p>
    ${field('name', 'Full name')}
    <div class="row">${field('email', 'Email', { type: 'email' })}${field('phone', 'Phone', { type: 'tel', hint: '(optional)' })}</div>
    <div class="row">${field('location', 'Where you live', { placeholder: 'Denver, CO' })}${field('country', 'Country')}</div>
    <label class="check"><input type="checkbox" data-k="sponsorship" ${W.sponsorship ? 'checked' : ''}> <span>I will need visa sponsorship to work in this country</span></label>
    ${nav()}`,

  // 3. Jobs you want
  () => `
    <h1>Jobs you want</h1>
    <label for="f-roles">Job titles you're looking for <span class="hint">separate with commas</span></label>
    <input id="f-roles" type="text" data-k="roles" value="${esc(W.roles)}" placeholder="Data Analyst, Business Analyst">
    <div class="row">
      <div><label for="f-level">Level</label>
      <select id="f-level" data-k="level">${['', 'Entry level', 'Mid level', 'Senior', 'Lead / Manager'].map((l) => `<option value="${esc(l)}" ${W.level === l ? 'selected' : ''}>${esc(l || 'Any level')}</option>`).join('')}</select></div>
      ${field('comp', 'Pay you are aiming for', { hint: '(optional)', placeholder: '$70K-90K' })}
    </div>
    ${field('locations', 'Only show jobs in these places', { hint: 'commas; leave empty for anywhere', placeholder: 'Denver, Remote' })}
    ${field('flex', 'Remote or moving preferences', { hint: '(optional)', placeholder: 'Remote or hybrid; open to moving' })}
    <label class="check"><input type="checkbox" data-k="entryLevel" ${W.entryLevel ? 'checked' : ''}> <span>Include entry-level and "Junior" job titles</span></label>
    <details><summary>Advanced: words to look for in job titles</summary>
      <label for="f-keywords">Title words <span class="hint">a job is kept when its title contains one of these</span></label>
      <input id="f-keywords" type="text" data-k="keywords" value="${esc(W.keywords || W.roles)}">
    </details>
    ${nav({ nextDisabled: !listOf(W.roles).length })}`,

  // 4. Where to look
  () => `
    <h1>Where to look</h1>
    <p class="muted">Career-Ops reads job boards directly. It never applies to anything.</p>
    ${[
      ['sweep', 'Search everywhere', 'Searches thousands of company job boards (Greenhouse, Lever, Ashby) for your job titles. Any industry.', true],
      ['starter', 'A starter list of companies', 'About 200 preset companies, mostly tech and AI.', false],
      ['both', 'Both', 'The widest net. Takes the longest.', false],
      ...(S.setupDone ? [['keep', 'Keep what I have', 'Leave your current list of companies and searches as it is.', false]] : []),
    ].map(([k, t, d, rec]) => `<label class="choice"><input type="radio" name="portals" value="${k}" ${W.portals === k ? 'checked' : ''}><span class="title">${esc(t)}</span>${rec ? '<span class="badge rec">Recommended</span>' : ''}<div class="muted small">${esc(d)}</div></label>`).join('')}
    ${nav()}`,

  // 5. Judge
  () => {
    const J = [
      ['none', 'No AI (free)', 'Career-Ops finds, ranks and checks jobs; you read them yourself. A good place to start. You can add AI later.'],
      ['gemini', 'Google Gemini (free key)', 'Writes a scored report for each job. Needs a free key from Google; takes about two minutes to get.'],
      ['openrouter', 'OpenRouter (free key)', 'Free AI models through OpenRouter. Needs a free key.'],
      ['claude', 'Claude Code', 'For people who already have Claude Code installed and signed in. Gives the most detailed reports.'],
      ['ollama', 'Ollama (on this computer)', 'Free and private, runs on your own computer. Needs Ollama installed and a fast computer.'],
      ['openai', 'OpenAI or similar (paid key)', 'Uses a paid API key.'],
    ];
    const found = W.found || {};
    const j = S.judges[W.judge] || {};
    const needKey = j.env && !j.hasKey;
    return `
    <h1>AI helper</h1>
    <p class="muted">Optional. An AI can read each job and write a scored report on how well it fits your CV. Everything else works without it.</p>
    ${W.found ? '' : '<p class="small muted"><span class="spinner"></span> Checking what this computer already has…</p>'}
    ${J.map(([k, t, d]) => `<label class="choice"><input type="radio" name="judge" value="${k}" ${W.judge === k ? 'checked' : ''}><span class="title">${esc(t)}</span>${k === 'none' ? '<span class="badge rec">Recommended to start</span>' : found[k] ? '<span class="badge ok">Ready on this computer</span>' : ''}<div class="muted small">${esc(d)}</div></label>`).join('')}
    ${j.env ? `<div class="card" style="margin-top:14px">
      <label for="f-apiKey" style="margin-top:0">${esc(j.env)} ${j.hasKey ? '<span class="badge ok">already saved</span>' : ''}</label>
      <input id="f-apiKey" type="password" data-k="apiKey" value="${esc(W.apiKey)}" placeholder="${j.hasKey ? 'Leave empty to keep the saved key' : 'Paste your key here'}" autocomplete="off">
      <p class="small muted" style="margin-top:8px">Get one at ${j.help && /^https?:/.test(j.help.split(' ')[0]) ? `<a href="${esc(j.help.split(' ')[0])}" target="_blank" rel="noopener">${esc(j.help.split(' ')[0])}</a>` : esc(j.help)}. It is saved only on this computer.${needKey ? ' You can also skip this and add it later.' : ''}</p>
    </div>` : ''}
    ${W.judge === 'claude' && W.found && !found.claude ? '<div class="note warn">Claude Code was not found on this computer. Install it and sign in first, or pick another option.</div>' : ''}
    ${W.judge === 'ollama' && W.found && !found.ollama ? '<div class="note warn">Ollama is not running with a model. Install it from ollama.com and download a model first, or pick another option.</div>' : ''}
    ${nav()}`;
  },

  // 6. Finish
  () => `
    <h1>Ready to save</h1>
    <div class="card">
      <p><b>${esc(W.name)}</b> · ${esc(W.location || 'location not set')}</p>
      <p class="small">Looking for: <b>${esc(listOf(W.roles).join(', '))}</b>${W.level ? ` (${esc(W.level)})` : ''}</p>
      <p class="small">Places: ${esc(listOf(W.locations).join(', ') || 'anywhere')}</p>
      <p class="small" style="margin:0">AI helper: ${esc((S.judges[W.judge] || {}).label || W.judge)}</p>
    </div>
    ${S.dataDir ? `<p class="small muted">Your files are saved in <b>${esc(S.dataDir)}</b>.</p>` : `
      <label for="f-dataDir">Folder for your files <span class="hint">your CV, job list and reports; kept separate from the app so updates never touch them</span></label>
      <input id="f-dataDir" type="text" data-k="dataDir" value="${esc(W.dataDir)}">`}
    <div id="saveMsg"></div>
    ${nav({ next: 'Save and finish' })}`,
];

function bindFields() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    const ev = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      W[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'keywords') W.keywordsEdited = true;
      if (k === 'roles' && !W.keywordsEdited) { W.keywords = W.roles; const kw = $('f-keywords'); if (kw) kw.value = W.roles; }
      if (k === 'level' && W.level === 'Entry level') { W.entryLevel = true; const c = document.querySelector('[data-k="entryLevel"]'); if (c) c.checked = true; }
      if (k === 'roles') { const nx = document.querySelector('[data-go="next"]'); if (nx) nx.disabled = !listOf(W.roles).length; }
    });
  });
  document.querySelectorAll('input[type=radio]').forEach((el) => el.addEventListener('change', () => {
    W[el.name] = el.value;
    if (el.name === 'judge') { W.apiKey = ''; renderWizard(); }
  }));
}

function validate() {
  if (step === 1) {
    if (!W.name.trim()) return 'Please enter your name.';
  }
  if (step === 2 && !listOf(W.roles).length) return 'Please add at least one job title.';
  return '';
}

function renderWizard() {
  $('main').innerHTML = `<div class="card">${stepsBar()}${VIEWS[step]()}</div>`;
  $('topRight').innerHTML = '';
  bindFields();
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
    const go = b.dataset.go;
    if (go === 'home') return home();
    if (go === 'back') { step = Math.max(0, step - 1); return renderWizard(); }
    const problem = validate();
    if (problem) return toast(problem);
    if (step === STEPS.length - 1) return save(b);
    step++;
    renderWizard();
    if (step === 4 && !W.found) detectJudges();
  }));
  if (step === 0) bindCv();
  window.scrollTo(0, 0);
}

async function detectJudges() {
  try {
    const { found } = await api('/api/judges', {});
    W.found = found;
  } catch { W.found = {}; }
  if (step === 4) renderWizard();
}

async function save(btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    const r = await api('/api/setup', { ...W, roles: listOf(W.roles), keywords: listOf(W.keywords || W.roles), locations: listOf(W.locations) });
    S = r.state;
    home({ justSetUp: true });
  } catch (e) {
    $('saveMsg').innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Save and finish';
  }
}

// ── CV file reading ──────────────────────────────────────────────────────────
// Files go to the local server as base64 and are read there (pdf.js / mammoth),
// so this works offline and the CV never leaves the computer.
function toBase64(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readCvFile(file) {
  const status = $('cvStatus');
  status.textContent = `Reading ${file.name}…`;
  try {
    const plain = /\.(txt|md|text)$/i.test(file.name);
    const body = plain ? { fileName: file.name, text: await file.text() } : { fileName: file.name, base64: toBase64(await file.arrayBuffer()) };
    useCv(await api('/api/cv', body));
  } catch (e) {
    status.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

function useCv({ markdown, contact }) {
  W.cvMarkdown = markdown;
  for (const k of ['name', 'email', 'phone']) if (!W[k] && contact[k]) W[k] = contact[k];
  renderWizard();
}

function bindCv() {
  const reset = $('cvReset');
  if (reset) reset.addEventListener('click', () => { W.cvMarkdown = ''; renderWizard(); });
  const drop = $('drop');
  if (!drop) return;
  const file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { if (file.files[0]) readCvFile(file.files[0]); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readCvFile(e.dataTransfer.files[0]); });
  $('usePaste').addEventListener('click', async () => {
    const text = $('paste').value;
    if (!text.trim()) return toast('Paste your CV text first, or choose a file.');
    try { useCv(await api('/api/cv', { fileName: 'pasted.txt', text })); } catch (e) { toast(e.message); }
  });
}

// ── home ─────────────────────────────────────────────────────────────────────
const STEP_LABELS = { scan: 'Search companies', prep: 'Check jobs are open', recheck: 'Recheck saved jobs', judge: 'AI review', board: 'Build your board', sweep: 'Wide search' };

function runProgress(lines) {
  const steps = {};
  let finished = false;
  for (const l of lines) {
    const m = l.match(/^--- (\w+)(?: \([^)]*\))?: (.*)$/);
    if (m && STEP_LABELS[m[1]]) {
      const [, k, rest] = m;
      if (/^start/.test(rest)) steps[k] = 'active';
      else if (/^done \(exit 0\)/.test(rest) || (k === 'judge' && !/failed/.test(rest))) steps[k] = 'ok';
      else if (/^done|stopped|could not start|failed/.test(rest)) steps[k] = 'bad';
    }
    if (/^=== board run finished/.test(l)) finished = true;
  }
  return { steps, finished };
}

function fmtDate(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

let poll = null;
let runLines = [];
let runId = null;

function home({ justSetUp = false } = {}) {
  W = null;
  const first = (S.profile?.name || '').split(' ')[0];
  const running = S.run && !S.run.done;
  $('topRight').innerHTML = `<span>${esc(S.profile?.name || '')}</span>`;
  $('main').innerHTML = `
    ${justSetUp ? '<div class="note ok"><b>You\'re all set.</b> Press <b>Find new jobs</b> to run your first search. The first one takes the longest.</div>' : ''}
    <div class="card">
      <h1>Hi${first ? ` ${esc(first)}` : ''}</h1>
      <p class="muted">Looking for ${esc((S.profile?.roles || []).join(', ') || 'jobs')}${S.portals.locations.length ? ` in ${esc(S.portals.locations.join(', '))}` : ''}.</p>
      <div class="stat">
        <div><b>${S.tracked}</b>jobs on your board</div>
        <div><b>${esc(S.lastRun ? fmtDate(S.lastRun.at) : 'Not yet')}</b>last search</div>
        <div><b>${esc(S.judge === 'none' ? 'Off' : (S.judges[S.judge]?.label || S.judge).split(' (')[0])}</b>AI helper</div>
      </div>
    </div>
    <button class="btn primary big" id="runBtn" ${running ? 'disabled' : ''}>${running ? '<span class="spinner"></span> Searching…' : 'Find new jobs'}</button>
    <div class="grid2" style="margin:12px 0 16px">
      <a class="btn" href="/board" target="_blank" rel="noopener">Open my job board</a>
      <a class="btn" href="/queue" target="_blank" rel="noopener">Jobs waiting for a look</a>
    </div>
    <div id="runCard"></div>
    <div class="card">
      <h2>Settings</h2>
      <div class="settings-row"><div><h3>Your CV and job preferences</h3><div class="small muted">Change your CV, job titles, places or AI helper.</div></div><button class="btn" id="editBtn">Edit</button></div>
      <div class="settings-row"><div><h3>Search every day</h3><div class="small muted" id="schedNote">Runs the search automatically while your computer is on.</div></div>
        <div class="inline"><input type="time" id="schedTime" value="07:00"><label class="check" style="margin:0"><input type="checkbox" id="schedOn"> On</label></div></div>
      <div class="settings-row"><div><h3>Updates</h3><div class="small muted" id="updNote">Get the newest version of Career-Ops. Your files are never touched.</div></div><button class="btn" id="updBtn">Check for updates</button></div>
      <div class="settings-row"><div><h3>Your files</h3><div class="small muted">${esc(S.dataDir || '')}</div></div><button class="btn" id="folderBtn">Open folder</button></div>
      <div class="settings-row"><div><h3>Rebuild the board</h3><div class="small muted">Redraw your board from what is already saved, without searching.</div></div><button class="btn" id="buildBtn" ${running ? 'disabled' : ''}>Rebuild</button></div>
      <div class="settings-row"><div><h3>Close Career-Ops</h3><div class="small muted">Stops the app. Open it again with the Start Career-Ops file.</div></div><button class="btn" id="quitBtn">Close</button></div>
    </div>`;
  $('runBtn').addEventListener('click', () => startRun('full'));
  $('buildBtn').addEventListener('click', () => startRun('build'));
  $('editBtn').addEventListener('click', startWizard);
  $('folderBtn').addEventListener('click', () => api('/api/open-folder', {}).catch((e) => toast(e.message)));
  $('quitBtn').addEventListener('click', async () => {
    await api('/api/quit', {}).catch(() => {});
    clearInterval(poll);
    $('main').innerHTML = '<div class="card center"><h1>Career-Ops is closed</h1><p class="muted">You can close this tab. To open it again, double-click the Start Career-Ops file.</p></div>';
  });
  $('updBtn').addEventListener('click', checkUpdates);
  bindSchedule();
  if (S.run) { runId = S.run.id; runLines = S.run.lines; renderRun(S.run); if (running) startPolling(); }
}

async function bindSchedule() {
  const on = $('schedOn');
  const time = $('schedTime');
  const note = $('schedNote');
  try {
    const s = await api('/api/schedule', { get: true });
    on.checked = Boolean(s.enabled);
    if (s.time) time.value = s.time;
  } catch { /* leave defaults */ }
  if (S.scheduleWarning && !on.checked) note.innerHTML = `<span style="color:var(--warn)">${esc(S.scheduleWarning)}</span>`;
  const apply = async () => {
    try {
      const r = await api('/api/schedule', { enabled: on.checked, time: time.value });
      if (!r.ok) { on.checked = !on.checked; return toast(r.error); }
      toast(r.enabled ? `Career-Ops will search every day at ${time.value}.` : 'Daily search is off.');
    } catch (e) { toast(e.message); }
  };
  on.addEventListener('change', apply);
  time.addEventListener('change', () => { if (on.checked) apply(); });
}

async function checkUpdates() {
  const btn = $('updBtn');
  const note = $('updNote');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking…';
  try {
    const r = await api('/api/update/check', {});
    if (r.error) throw new Error(r.error);
    if (!r.available) { note.textContent = 'You have the newest version.'; btn.textContent = 'Check again'; btn.disabled = false; return; }
    note.textContent = `${r.note ? `${r.note} ` : ''}Newest change: ${r.latest?.message || 'new version'}.`;
    btn.textContent = 'Update now';
    btn.disabled = false;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Updating…';
      try {
        const a = await api('/api/update/apply', {});
        if (!a.ok) throw new Error(a.log || 'The update did not finish.');
        note.innerHTML = '<b>Updated.</b> Close Career-Ops (button below), then open it again with the Start Career-Ops file to finish.';
        btn.textContent = 'Updated';
      } catch (e) { note.textContent = e.message; btn.textContent = 'Try again'; btn.disabled = false; }
    };
  } catch (e) {
    note.textContent = `Could not check for updates: ${e.message}`;
    btn.textContent = 'Try again';
    btn.disabled = false;
  }
}

async function startRun(mode) {
  try {
    const { run } = await api('/api/run', { mode });
    runId = run.id;
    runLines = run.lines;
    S.run = run;
    home();
  } catch (e) { toast(e.message); }
}

function startPolling() {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const { run } = await api(`/api/run?since=${runLines.length}`);
      if (!run) return;
      if (run.id !== runId) { runId = run.id; runLines = []; }
      runLines = runLines.concat(run.lines);
      renderRun({ ...run, lines: runLines });
      if (run.done) {
        clearInterval(poll);
        S = await api('/api/state');
        const ok = run.exitCode === 0;
        home();
        toast(run.mode === 'build' ? (ok ? 'Your board was rebuilt.' : 'Rebuilding the board had a problem. See the details below.')
          : ok ? 'Search finished. Open your job board to see the results.' : 'The search finished with a problem. See the details below.');
      }
    } catch { /* keep polling; the server may be busy */ }
  }, 2000);
}

function renderRun(run) {
  const card = $('runCard');
  if (!card) return;
  const { steps } = runProgress(run.lines);
  const order = (run.mode === 'build' ? ['board'] : ['scan', 'prep', 'recheck', 'judge', 'board', 'sweep'])
    .filter((k) => !(k === 'scan' && !S.portals.scan) && !(k === 'sweep' && !S.portals.sweep) && !(k === 'judge' && S.judge === 'none'));
  // Steps in the order they actually ran (the wide search can run first), then
  // the ones still to come.
  const shown = [...Object.keys(steps), ...(run.done ? [] : order.filter((k) => !steps[k]))];
  const ok = run.done && run.exitCode === 0;
  card.innerHTML = `<div class="card">
    <h2>${run.done ? (run.mode === 'build' ? (ok ? 'Board rebuilt' : 'Rebuilding the board had a problem') : ok ? 'Last search finished' : 'Last search had a problem') : run.mode === 'build' ? 'Rebuilding your board…' : 'Searching for jobs…'}</h2>
    ${run.done ? `<p class="small muted">Started ${esc(fmtDate(run.startedAt))}.</p>` : '<p class="small muted">This often takes 10 to 40 minutes. You can use your computer meanwhile; keep this window open.</p>'}
    <div class="progress">${shown.map((k) => `<span class="${steps[k] || ''}">${steps[k] === 'ok' ? '✓ ' : steps[k] === 'bad' ? '! ' : ''}${esc(STEP_LABELS[k])}</span>`).join('')}</div>
    ${run.done && !ok ? '<div class="note warn">Some steps did not finish. Your board was still rebuilt with what was found. The details below say what happened; running the search again often fixes it.</div>' : ''}
    <details ${run.done && !ok ? 'open' : ''}><summary>Details</summary><pre class="log" id="log">${esc(run.lines.slice(-400).join('\n'))}</pre></details>
  </div>`;
  const log = $('log');
  if (log) log.scrollTop = log.scrollHeight;
}

// ── boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    S = await api('/api/state');
    if (S.setupDone) home();
    else startWizard();
  } catch (e) {
    $('main').innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
})();
