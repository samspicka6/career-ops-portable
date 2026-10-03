// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// UKG Pro Recruiting (formerly UltiPro) job-board provider.
//
// Career page URL (what an employer links from its own site):
//   https://recruiting.ultipro.com/<companyCode>/JobBoard/<boardGuid>/
//   e.g. recruiting.ultipro.com/BAR1005BGI/JobBoard/ff46b34e-c0ce-4e3c-adbb-8bf890b80d89
//
// The board renders client-side from one zero-auth JSON endpoint (captured
// from a live browser session, then replayed with plain curl — no cookie, no
// anti-forgery token, 2026-09-22):
//   POST https://recruiting.ultipro.com/<co>/JobBoard/<board>/JobBoardView/LoadSearchResults
//   Content-Type: application/json; charset=UTF-8
//   {"opportunitySearch":{"Top":<n>,"Skip":<offset>,"QueryString":"","Filters":[]}}
//   → { opportunities: [...], totalCount, locations }
// The body MUST be nested under `opportunitySearch`; a flat body still answers
// 200 with the right shape but an always-empty `opportunities` list, which is
// why static guessing failed before the capture.
//
// Per opportunity: Id (GUID), Title, RequisitionNumber, FullTime,
// JobCategoryName, PostedDate (ISO), BriefDescription (plain text),
// Locations[].Address.{City, State.Code, Country.Code}.
// Posting URL: https://<host>/<co>/JobBoard/<board>/OpportunityDetail?opportunityId=<Id>
// (the same shape the site's own links use).

import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';

const ALLOWED_HOSTS = new Set(['recruiting.ultipro.com', 'recruiting2.ultipro.com']);
const CO_RE = /^[A-Za-z0-9]{3,32}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE_SIZE = 50;           // Top=50 verified live
const DEFAULT_MAX_PAGES = 40;   // 2,000 postings; raise per-entry via max_pages
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 200;
const RETRY_POLICY = { retries: 3 };

/** @param {string} url */
function assertUltiproUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ultipro: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ultipro: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`ultipro: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_HOSTS].join(', ')}`);
  }
  return url;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Board coordinates from an entry. `entry.api` takes precedence over
 * `entry.careers_url` (mirrors greenhouse/oraclecloud/adp).
 *
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{host: string, co: string, board: string}|null}
 */
export function resolveBoard(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) continue;
    const segs = parsed.pathname.split('/').filter(Boolean);
    const jb = segs.findIndex((s) => s.toLowerCase() === 'jobboard');
    if (jb < 1) continue;
    const co = segs[jb - 1];
    const board = segs[jb + 1];
    if (!co || !board || !CO_RE.test(co) || !GUID_RE.test(board)) continue;
    return { host: parsed.hostname, co, board: board.toLowerCase() };
  }
  return null;
}

/** @param {{host: string, co: string, board: string}} b */
export function buildSearchUrl(b) {
  return `https://${b.host}/${b.co}/JobBoard/${b.board}/JobBoardView/LoadSearchResults`;
}

/** @param {{host: string, co: string, board: string}} b @param {string} id */
export function buildPostingUrl(b, id) {
  const seg = safeEncodeURIComponent(id);
  if (seg === null) return null;
  return `https://${b.host}/${b.co}/JobBoard/${b.board}/OpportunityDetail?opportunityId=${seg}`;
}

/** @param {number} skip @param {number} top */
export function buildSearchBody(skip, top = PAGE_SIZE) {
  return JSON.stringify({ opportunitySearch: { Top: top, Skip: skip, QueryString: '', Filters: [] } });
}

/** @param {any} loc */
function formatLocation(loc) {
  const a = loc?.Address;
  if (!a || typeof a !== 'object') {
    return typeof loc?.LocalizedName === 'string' ? loc.LocalizedName.trim() : '';
  }
  const parts = [
    typeof a.City === 'string' ? a.City.trim() : '',
    typeof a.State?.Code === 'string' ? a.State.Code.trim() : '',
    typeof a.Country?.Code === 'string' ? a.Country.Code.trim() : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Pure normalizer for one opportunity → Job. Exported for unit tests.
 *
 * @param {any} o
 * @param {{host: string, co: string, board: string}} b
 * @param {string} companyName
 */
export function normalizeOpportunity(o, b, companyName) {
  if (!o || typeof o !== 'object') return null;
  const title = typeof o.Title === 'string' ? o.Title.trim() : '';
  if (!title) return null;
  const id = typeof o.Id === 'string' && GUID_RE.test(o.Id.trim()) ? o.Id.trim() : '';
  if (!id) return null;
  const url = buildPostingUrl(b, id);
  if (!url) return null;

  const locations = Array.isArray(o.Locations)
    ? [...new Set(o.Locations.map(formatLocation).filter(Boolean))]
    : [];
  /** @type {any} */
  const job = { title, url, company: companyName, location: locations.join(' · ') };
  const postedAt = toEpochMs(o.PostedDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description = htmlToText(o.BriefDescription);
  if (description) job.description = description;
  return job;
}

/** @type {Provider} */
export default {
  id: 'ultipro',

  detect(entry) {
    try {
      const b = resolveBoard(entry);
      return b ? { url: buildSearchUrl(b) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const b = resolveBoard(entry);
    if (!b) throw new Error(`ultipro: cannot derive the job-board API URL for ${entry.name}`);
    const url = assertUltiproUrl(buildSearchUrl(b));

    const configuredMax = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMaxPages = Number(ctx?.maxPages);
    const maxPages = ctxMaxPages > 0 ? Math.min(configuredMax, ctxMaxPages) : configuredMax;

    /** @type {any[]} */
    const rows = [];
    /** @type {number|null} */
    let total = null;
    let stoppedOnError = false;
    for (let page = 0; page < maxPages; page++) {
      const skip = page * PAGE_SIZE;
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, url, {
          method: 'POST',
          redirect: 'error',
          body: buildSearchBody(skip),
          headers: {
            'User-Agent': BROWSER_LIKE_USER_AGENT,
            Accept: 'application/json',
            'Content-Type': 'application/json; charset=UTF-8',
          },
        }, RETRY_POLICY);
      } catch (err) {
        if (page === 0 || ctxMaxPages > 0) throw err;
        console.error(`⚠️  ultipro: ${entry.name} page ${page} failed — ${err instanceof Error ? err.message : String(err)} (keeping ${rows.length} rows collected so far)`);
        stoppedOnError = true;
        break;
      }

      if (json === null || json === undefined || (typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0)) break;
      if (!Array.isArray(json?.opportunities)) {
        throw new Error(`ultipro: unexpected response shape for ${entry.name} — keys: ${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}`);
      }
      rows.push(...json.opportunities);
      if (total === null && typeof json.totalCount === 'number' && Number.isFinite(json.totalCount)) total = json.totalCount;

      if (json.opportunities.length < PAGE_SIZE) break;
      if (total !== null && skip + PAGE_SIZE >= total) break;
    }
    if (!stoppedOnError && !(ctxMaxPages > 0) && total !== null && rows.length < total && maxPages * PAGE_SIZE < total) {
      console.error(`⚠️  ultipro: ${entry.name} truncated at max_pages=${maxPages} (${rows.length} of ${total}) — raise max_pages on this entry`);
    }

    const seen = new Set();
    const jobs = [];
    for (const o of rows) {
      const job = normalizeOpportunity(o, b, entry.name);
      if (!job || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }
    return jobs;
  },
};
