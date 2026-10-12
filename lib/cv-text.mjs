// lib/cv-text.mjs — plain text out of a CV file, for `npm run setup` and the app.
//
//   .pdf   pdf.js (pdfjs-dist, pure JavaScript; pdftotext as a fallback)
//   .docx  mammoth
//   .txt / .md / anything else: read as UTF-8
//
// No AI and no network: the file never leaves the computer.

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Rebuild lines from pdf.js text items: an item flagged hasEOL ends a line,
// and a jump in the y position starts one (some PDFs never set hasEOL).
export function itemsToText(items) {
  let out = '';
  let lastY = null;
  for (const it of items) {
    const y = it.transform ? it.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.hasEOL) out += '\n';
    if (y !== null) lastY = y;
  }
  return out;
}

async function pdfWithPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(itemsToText(tc.items));
  }
  await doc.destroy();
  return pages.join('\n\n');
}

function pdfWithPdftotext(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-cv-'));
  try {
    const f = join(dir, 'cv.pdf');
    writeFileSync(f, buf);
    const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.replace(/ {3,}/g, '  ') : '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_TEXT = 'No text could be read from this PDF (it may be a scanned image). Open it, select all the text, copy it, and paste it instead.';

export async function cvFileToText(buf, ext) {
  ext = String(ext || '').toLowerCase();
  if (ext === '.pdf') {
    let text = '';
    try { text = await pdfWithPdfjs(buf); } catch { text = ''; }
    if (!text.trim()) text = pdfWithPdftotext(buf);
    if (!text.trim()) throw new Error(NO_TEXT);
    return text;
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const r = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    if (!r.value.trim()) throw new Error('No text could be read from this Word file. Copy the text and paste it instead.');
    return r.value;
  }
  if (ext === '.doc') throw new Error('Older .doc files can\'t be read. In Word, use Save As and pick PDF or .docx, or paste the text instead.');
  return Buffer.from(buf).toString('utf8');
}
