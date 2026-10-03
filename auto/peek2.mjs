import fs from 'fs';
import { enterDataRoot } from './config.mjs';

enterDataRoot();
for (const n of process.argv.slice(2)) {
  const f = `data/auto/jd/${n}.txt`;
  if (!fs.existsSync(f)) { console.log(`=== ${n}: no JD`); continue; }
  const t = fs.readFileSync(f, 'utf8');
  const title = (t.match(/^Title: (.*)$/m) || [])[1];
  const pick = (re, len) => { const i = t.search(re); return i < 0 ? '' : t.slice(i, i + len).replace(/\s*\n\s*/g, ' | '); };
  const loc = (t.match(/(Job Locations?|Location)\s*\n?\s*:?\s*([^\n]{3,80})/) || [])[2] || '';
  console.log(`=== ${n} · ${title} · ${loc}`);
  console.log('Q:', pick(/(Basic Qualifications|Qualifications:|QUALIFICATIONS|Required Qualifications|Requirements|What You.ll Need|Minimum Qualifications)/, 800));
  console.log('D:', pick(/(Responsibilities for this Position|Responsibilities|Job Description|Position Summary|What You.ll Do|Summary)/, 450));
  const pay = t.match(/\$\s?[\d,]{5,}[^\n]{0,50}/g) || [];
  console.log('$:', pay.slice(0, 1).join('') || '—', '| shift:', (t.match(/[^.\n]{0,40}(2nd|second|3rd|third|night|weekend) shift[^.\n]{0,40}/i) || [''])[0]);
}
