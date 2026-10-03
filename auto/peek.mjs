// auto/peek.mjs — compact duties/qualifications/pay slices of captured JDs,
// so evaluation reads ~2.5K chars per posting instead of the whole JD.
// Usage: node auto/peek.mjs 01 07 13 ...
import fs from 'fs';
import { enterDataRoot, loadAutoConfig } from './config.mjs';

enterDataRoot();
const GRAD_YEAR = Number(loadAutoConfig().candidate.graduation_year) || 0;
const START = new RegExp(`[^.\\n]{0,80}(${GRAD_YEAR ? GRAD_YEAR + '|' : ''}start date|graduat)[^.\\n]{0,80}`, 'gi');
for (const n of process.argv.slice(2)) {
  const f = `data/auto/jd/${n}.txt`;
  if (!fs.existsSync(f)) { console.log(`=== ${n}: no JD`); continue; }
  const t = fs.readFileSync(f, 'utf8');
  const head = t.split('\n').slice(1, 4).map((l) => l.replace(/^\w+: /, '')).join(' · ');
  const pick = (re, len) => { const i = t.search(re); return i < 0 ? '' : t.slice(i, i + len).replace(/\s*\n\s*/g, ' | '); };
  console.log(`=== ${n} · ${head}`);
  console.log('DUTIES:', pick(/(Position Responsibilities|What you.ll do|WHAT YOU.LL DO|Responsibilities|RESPONSIBILITIES|YOU WILL|In this role|What You Will Be Doing|The Role|About the role|Description)/, 1000));
  console.log('QUALS:', pick(/(Basic Qualifications|Qualifications You Must Have|QUALIFICATIONS:|YOU MUST HAVE|Required Skills|Qualifications:|About You|BASIC QUALIFICATIONS)/, 1100));
  const pay = t.match(/\$\s?[\d,]{5,}[^\n]{0,70}/g) || [];
  console.log('PAY:', pay.slice(0, 2).join(' || ') || '—');
  console.log('START/GRAD:', (t.match(START) || []).slice(0, 2).join(' || ') || '—');
}
