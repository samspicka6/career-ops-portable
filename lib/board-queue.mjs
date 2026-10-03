// lib/board-queue.mjs — the "still to look at" page for `npm run board`.
//
// The job board lists evaluated roles. With `judge: none` (or postings the
// judge did not reach) the useful output is the ranked, liveness-checked queue
// itself, so this writes output/queue.html from prep's batch.json: one card per
// live posting still Pending, with its zero-token flags and a link. No model.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function pendingUrls(pipelineText) {
  const out = new Set();
  let inPending = false;
  for (const l of pipelineText.split('\n')) {
    if (/^##\s+Pending/.test(l)) inPending = true;
    else if (/^##\s/.test(l)) inPending = false;
    else if (inPending && l.startsWith('- [ ] ')) out.add(l.slice(6).split(' | ')[0].trim());
  }
  return out;
}

export function buildQueuePage({ batch, pending, generated }) {
  const items = batch.filter((b) => b.liveness !== 'expired' && pending.has(b.url));
  const cards = items.map((b) => `
  <article>
    <h2><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)}</a></h2>
    <p class="meta">${esc(b.company)} · ${esc(b.location || 'location n/a')}${b.posted ? ` · posted ${esc(b.posted)}` : ''} · <span class="live ${esc(b.liveness)}">${esc(b.liveness)}</span> · tier ${esc(b.tier)}</p>
    ${(b.flags || []).length ? `<ul>${b.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  </article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Queue</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--card:#fff;--line:#e4e1d8;--ok:#1f7a4d;--warn:#9a6700;--accent:#2357c5}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#ecebe6;--muted:#a3a19a;--card:#1e1e1c;--line:#33322e;--ok:#5cc28e;--warn:#e0b34f;--accent:#7ea6ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px}
h2{font-size:16px;margin:0 0 4px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.meta{color:var(--muted);margin:0;font-size:13.5px}ul{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:var(--muted)}
.live.active{color:var(--ok)}.live.uncertain,.live.unchecked{color:var(--warn)}
</style></head><body><main>
<h1>Job queue</h1>
<p class="sub">${items.length} live posting(s) waiting for a look, best-ranked first. Generated ${esc(generated)} by <code>npm run board</code>, no AI involved. Flags are keyword hints, so check the posting before ruling it out.</p>
${cards || '<p>Nothing waiting. Run <code>npm run board</code> after the next scan.</p>'}
</main></body></html>
`;
}

export function writeQueuePage(dataRoot) {
  const batchPath = join(dataRoot, 'data', 'auto', 'batch.json');
  const pipelinePath = join(dataRoot, 'data', 'pipeline.md');
  const batch = existsSync(batchPath) ? JSON.parse(readFileSync(batchPath, 'utf8')) : [];
  const pending = pendingUrls(existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const html = buildQueuePage({ batch, pending, generated: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` });
  mkdirSync(join(dataRoot, 'output'), { recursive: true });
  const out = join(dataRoot, 'output', 'queue.html');
  writeFileSync(out, html);
  return { path: out, count: batch.filter((b) => b.liveness !== 'expired' && pending.has(b.url)).length };
}
