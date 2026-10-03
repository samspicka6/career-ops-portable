// Print only requirement-bearing sentences (years, degree, shift, start/grad) per JD.
import fs from 'fs';
import { enterDataRoot } from './config.mjs';

enterDataRoot();
for (const n of process.argv.slice(2)) {
  const f = `data/auto/jd/${n}.txt`;
  if (!fs.existsSync(f)) { console.log(`=== ${n}: no JD`); continue; }
  const t = fs.readFileSync(f, 'utf8');
  const title = (t.match(/^Title: (.*)$/m) || [])[1];
  const body = t.slice(t.indexOf('\n\n') + 2).replace(/([a-z.)])([A-Z][a-z])/g, '$1\n$2');
  const out = [];
  for (const raw of body.split(/\n|(?<=[.;])\s+/)) {
    const s = raw.trim();
    if (s.length < 12 || s.length > 260) continue;
    if (/\b(\d+\+?\s*(years?|yrs|months?)|bachelor|degree|b\.s\.|graduat|start (date|by|between)|shift|intern|co-op|level \d|gpa)\b/i.test(s) && !/benefit|401|vacation|holiday|pay range|salary|equal opportunity|eeo/i.test(s)) out.push(s);
    if (out.length >= 6) break;
  }
  const pay = (t.match(/\$\s?[\d,]{5,}(\.\d\d)?\s*(-|–|—|to)\s*\$?\s?[\d,]{5,}/) || [''])[0];
  console.log(`=== ${n} · ${title}${pay ? ' · ' + pay : ''}`);
  for (const s of out) console.log('  - ' + s.slice(0, 230));
}
