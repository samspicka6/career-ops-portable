// tests/board-setup.test.mjs — the pure parts of `npm run setup` and `npm run board`:
// CV text → markdown, profile/portals template edits, and the single-JD judge's
// tracker/report/pipeline bookkeeping.
import * as yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { pass, fail } from './helpers.mjs';
import { textToMarkdown, contactFromCv, fillProfile, fillProfileModes, fillPortals } from '../setup.mjs';
import { stampTsv, stampReportUrl, markProcessed } from '../judges/single-jd.mjs';
import { pendingUrls, buildQueuePage } from '../lib/board-queue.mjs';
import { loadBoardConfig, DEFAULTS } from '../lib/board-config.mjs';

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
console.log('\nsetup.mjs / board.mjs — setup helpers and judge bookkeeping');

// CV conversion
const md = textToMarkdown('Alex Rivera\nalex@example.com | (555) 201-3344\n\nEXPERIENCE\nAnalyst, Acme\n• Built dashboards\n\nSkills:\nSQL, Python\n');
check(md.startsWith('# Alex Rivera\n'), 'first CV line becomes the # name heading');
check(/^## Experience$/m.test(md) && /^## Skills$/m.test(md), 'section lines become ## headings');
check(/^- Built dashboards$/m.test(md), 'bullet glyphs become markdown bullets');
check(textToMarkdown('# Already\n\nmarkdown') === '# Already\n\nmarkdown\n', 'markdown input is kept as is');
const contact = contactFromCv(md);
check(contact.name === 'Alex Rivera' && contact.email === 'alex@example.com', 'name and email are read from the CV');
check(contact.phone === '(555) 201-3344', 'phone keeps its leading parenthesis');

// profile.yml
const example = readFileSync(new URL('../config/profile.example.yml', import.meta.url), 'utf8');
const p = {
  name: 'Alex Rivera', email: 'alex@example.com', phone: '', location: 'Denver, CO', linkedin: '', github: '',
  roles: ['Data Analyst', 'BI Analyst'], level: 'Entry level', headline: 'Data Analyst', comp: '$70K-90K', compMin: '', flex: 'Remote ok',
  country: 'United States', city: 'Denver', timezone: '', needsSponsorship: false, authorizedIn: ['United States'], visa: 'Authorized', fresh: true,
};
const filled = fillProfile(example, p);
const doc = yaml.load(filled);
check(doc.candidate.full_name === 'Alex Rivera' && doc.candidate.location === 'Denver, CO', 'candidate fields are filled');
check(doc.target_roles.primary.join('|') === 'Data Analyst|BI Analyst', 'target roles replace the example roles');
check(doc.target_roles.archetypes.length === 2 && doc.target_roles.archetypes[0].fit === 'primary', 'archetypes come from the roles');
check(doc.narrative.exit_story === '' && !/Jane|janesmith/.test(filled.replace(/^\s*#.*$/gm, '')), 'no example-person values survive outside comments');
check(filled.includes('# Career-Ops Profile Configuration'), 'template comments are kept');
const refined = filled.replace('exit_story: ""', 'exit_story: "My own words"');
const rerun = yaml.load(fillProfile(refined, { ...p, fresh: false, rolesChanged: false }));
check(rerun.narrative.exit_story === 'My own words', 're-running setup keeps a hand-written narrative');

// modes/_profile.md
const modesTpl = readFileSync(new URL('../modes/_profile.template.md', import.meta.url), 'utf8');
const modes = fillProfileModes(modesTpl, ['Data Analyst']);
check(modes.includes('| **Data Analyst** |') && !modes.includes('LLMOps Engineer** |'), 'archetype table is replaced with the user roles');

// portals.yml
const portalsTpl = readFileSync(new URL('../templates/portals.example.yml', import.meta.url), 'utf8');
const portals = yaml.load(fillPortals(portalsTpl, { keywords: ['Data Analyst'], locations: ['Denver', 'Remote'], entryLevel: true }));
check(portals.title_filter.positive.join('|') === 'Data Analyst', 'title keywords replace the example positives');
check(!portals.title_filter.negative.includes('Junior'), 'entry-level drops the "Junior" negative');
check(portals.location_filter.allow.join('|') === 'Denver|Remote', 'locations become a location_filter allow list');
check(Array.isArray(portals.tracked_companies) && portals.tracked_companies.length > 0, 'the rest of portals.yml is untouched');

// single-JD judge bookkeeping
const tsv = 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\n7\t2026-10-03\tacme\t(see report)\tEvaluated\t4.0/5\t❌\t[007](reports/007-acme.md)\t\n';
const st = stampTsv(tsv, { company: 'Acme', role: 'Data Analyst', url: 'https://x.test/j/1' });
check(st.fields.company === 'Acme' && st.fields.role === 'Data Analyst' && st.fields.url === 'https://x.test/j/1', 'TSV gets the posting company, role and url');
check(st.text.split('\n')[0].endsWith('\turl') && st.text.split('\n')[1].split('\t').length === 10, 'url label and value are added together');
check(stampReportUrl('**URL:** (pasted)\n', 'https://x.test/j/1') === '**URL:** https://x.test/j/1\n', 'pasted report URL is replaced');
check(stampReportUrl('**URL:** https://a.test\n', 'https://b.test') === '**URL:** https://a.test\n', 'a real report URL is kept');
const pipe = '# P\n\n## Pending\n\n- [ ] https://x.test/j/1 | Acme | DA\n- [ ] https://x.test/j/2 | B | BI\n\n## Processed\n';
const moved = markProcessed(pipe, [{ url: 'https://x.test/j/1', line: '- [x] #007 | https://x.test/j/1 | Acme | DA | 4.0/5 | PDF ❌' }]);
check(!moved.includes('- [ ] https://x.test/j/1') && moved.includes('- [x] #007'), 'evaluated posting moves to Processed');
check([...pendingUrls(moved)].join() === 'https://x.test/j/2', 'the other posting stays Pending');

// queue page + config
const html = buildQueuePage({ batch: [{ url: 'https://x.test/j/2', company: 'B<script>', title: 'BI', liveness: 'active', tier: 3, flags: [] }], pending: new Set(['https://x.test/j/2']), generated: 'now' });
check(html.includes('B&lt;script&gt;') && !html.includes('B<script>'), 'queue page escapes posting text');
check(loadBoardConfig('/nonexistent/board.yml').judge === DEFAULTS.judge, 'missing config/board.yml falls back to defaults');
