// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// DirectEmployers (NLx / "jobsyn") microsite provider — the branded career
// sites DirectEmployers Association hosts for member employers (e.g.
// careers.textron.com). The listing on those sites is rendered client-side
// from one shared, zero-auth search API backed by Google Cloud Talent
// Solution:
//
//   GET https://prod-search-api.jobsyn.org/api/v1/google-talent/search
//       ?q=<keyword>&page=<1-based>&num_items=<n>
//   x-origin: <the microsite host, e.g. careers.textron.com>
//
// The `x-origin` header is what selects the tenant — without it the API
// answers 403, with it 200 (captured live from a browser session, then
// verified with curl, 2026-09-22). No cookie, token, or session bootstrap.
//
// Response: { jobs: [ { job: {...}, ... } ], pagination: { has_more_pages,
// page, page_size, total, total_pages }, filters, meta, featured_jobs }.
// Per job (jobs[].job): title, requisitionId, addresses[], companyDisplayName,
// applicationInfo.uris[] (an rr.jobsyn.org redirect), description (HTML),
// postingPublishTime (ISO 8601), customAttributes.<name>.stringValues[0] for
// city_display, state_short, country_short, reqid, other_recruiting_company,
// title_slug, city_display_slug, buid.
//
// PAGE SIZE IS SERVER-CAPPED AT 10 regardless of num_items (measured: 10, 20,
// 50 and 100 all return exactly 10 rows). An 891-posting tenant is ~90 pages.
//
// Multi-brand tenants: one microsite feed can carry several business units
// under one employer (Textron's feed carries Textron Aviation, Bell Textron
// Inc., Textron Systems, Textron Specialized Vehicles, Kautex, …). They share
// one `buid`; the distinguishing field is customAttributes
// .other_recruiting_company. Set `recruiting_company: "<name>"` (or an array)
// on a tracked_companies: entry to keep only matching units —
// case-insensitive substring match, same semantics as adp.mjs's brand_filter.
// Without it, every unit on the feed is returned under the entry's name.
//
// Job URL: the microsite's own canonical path
//   https://<x-origin>/<city_display_slug>/<title_slug>/<GUID>/job/
// where GUID is the last path segment of applicationInfo.uris[0]. That is the
// path the rr.jobsyn.org redirect resolves to (followed live), minus a hop
// through the tracking redirector. Falls back to the redirect URI itself when
// the slugs are missing.

import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';

const API_HOST = 'prod-search-api.jobsyn.org';
const API_PATH = '/api/v1/google-talent/search';
// A redirect URI the API hands back is only trusted when it points here.
const REDIRECT_HOST = 'rr.jobsyn.org';

const PAGE_SIZE = 10;            // server cap (see header)
const DEFAULT_MAX_PAGES = 150;   // 1,500 postings; raise per-entry via max_pages
const MAX_PAGES_CAP = 500;
const INTER_PAGE_DELAY_MS = 200;
const RETRY_POLICY = { retries: 3 };

// One microsite feed is often read by several portals.yml entries (Textron's
// three business units), and the API rate-limits: three back-to-back ~90-page
// walks of the same feed answered HTTP 429 on the third (observed 2026-09-22).
// So the walk is shared: the raw items are cached per transport function
// (scan.mjs hands every company the same makeHttpCtx() fetchJson, while each
// test injects its own) and per origin/query/page-cap, then filtered per entry.
// Probes (ctx.maxPages) never use or fill the cache.
/** @type {WeakMap<Function, Map<string, Promise<any[]>>>} */
const walkCache = new WeakMap();

// Hostname shape accepted for x-origin: a plain DNS name, no port/path/userinfo.
const ORIGIN_HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** @param {string} url */
function assertApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`directemployers: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`directemployers: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== API_HOST) {
    throw new Error(`directemployers: untrusted hostname "${parsed.hostname}" — must be ${API_HOST}`);
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
 * The microsite host sent as `x-origin`. Taken from `entry.x_origin` when set,
 * else the hostname of `entry.careers_url`. Never from `entry.api` — the API
 * host is fixed, so `api:` carries nothing tenant-specific here.
 *
 * @param {import('./_types.js').PortalEntry & {x_origin?: string}} entry
 * @returns {string|null}
 */
export function resolveOrigin(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.x_origin === 'string' && ORIGIN_HOST_RE.test(entry.x_origin.trim())) {
    return entry.x_origin.trim().toLowerCase();
  }
  if (typeof entry.careers_url !== 'string' || !entry.careers_url) return null;
  let parsed;
  try {
    parsed = new URL(entry.careers_url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ORIGIN_HOST_RE.test(parsed.hostname)) return null;
  return parsed.hostname.toLowerCase();
}

/**
 * @param {number} page 1-based
 * @param {string} [query]
 */
export function buildSearchUrl(page, query = '') {
  const url = new URL(`https://${API_HOST}${API_PATH}`);
  url.searchParams.set('q', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('num_items', String(PAGE_SIZE));
  return url.href;
}

/** @param {any} attrs @param {string} name */
function attr(attrs, name) {
  const v = attrs?.[name]?.stringValues;
  if (!Array.isArray(v) || typeof v[0] !== 'string') return '';
  return v[0].trim();
}

/**
 * @param {string} unit
 * @param {string|string[]|undefined} filter
 */
export function matchesRecruitingCompany(unit, filter) {
  if (!filter) return true;
  const needles = (Array.isArray(filter) ? filter : [filter])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().toLowerCase());
  if (needles.length === 0) return true;
  const hay = String(unit || '').toLowerCase();
  return needles.some((n) => hay.includes(n));
}

/**
 * GUID from an rr.jobsyn.org redirect URI, or null when the URI is not one.
 * @param {unknown} uri
 */
function redirectGuid(uri) {
  if (typeof uri !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== REDIRECT_HOST) return null;
  const seg = parsed.pathname.split('/').filter(Boolean).pop() || '';
  return /^[A-Za-z0-9]{8,64}$/.test(seg) ? seg : null;
}

/**
 * Pure normalizer for one jobs[] item → Job. Exported for unit tests.
 *
 * @param {any} item
 * @param {string} origin microsite host (x-origin)
 * @param {import('./_types.js').PortalEntry & {recruiting_company?: string|string[]}} entry
 */
export function normalizeJob(item, origin, entry) {
  const job = item?.job;
  if (!job || typeof job !== 'object') return null;
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  if (!title) return null;

  const attrs = job.customAttributes;
  const unit = attr(attrs, 'other_recruiting_company');
  if (!matchesRecruitingCompany(unit, entry.recruiting_company)) return null;

  const applyUri = Array.isArray(job.applicationInfo?.uris) ? job.applicationInfo.uris[0] : undefined;
  const guid = redirectGuid(applyUri);
  if (!guid) return null; // no trustworthy, linkable posting URL

  const citySlug = attr(attrs, 'city_display_slug');
  const titleSlug = attr(attrs, 'title_slug');
  let url;
  if (citySlug && titleSlug) {
    const c = safeEncodeURIComponent(citySlug);
    const t = safeEncodeURIComponent(titleSlug);
    url = c !== null && t !== null ? `https://${origin}/${c}/${t}/${guid}/job/` : `https://${REDIRECT_HOST}/${guid}`;
  } else {
    url = `https://${REDIRECT_HOST}/${guid}`;
  }

  const cityDisplay = attr(attrs, 'city_display');
  const country = attr(attrs, 'country_short');
  const firstAddress = Array.isArray(job.addresses) && typeof job.addresses[0] === 'string' ? job.addresses[0].trim() : '';
  const location = cityDisplay ? [cityDisplay, country].filter(Boolean).join(', ') : firstAddress;

  /** @type {any} */
  const out = { title, url, company: entry.name, location };
  const postedAt = toEpochMs(job.postingPublishTime);
  if (postedAt !== undefined) out.postedAt = postedAt;
  // The list payload carries the full posting body for free — no extra request.
  const description = htmlToText(job.description);
  if (description) out.description = description;
  return out;
}

/** @type {Provider} */
export default {
  id: 'directemployers',

  // Microsites live on each employer's own branded domain, so there is no host
  // pattern to auto-claim — select with an explicit `provider: directemployers`.

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) {
      throw new Error(`directemployers: cannot resolve the microsite host (x-origin) for ${entry.name} — set careers_url to the https careers site or x_origin`);
    }
    const query = typeof entry.query === 'string' ? entry.query : '';

    const configuredMax = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = probing ? Math.min(configuredMax, ctxMaxPages) : configuredMax;

    const walk = () => walkFeed(entry, ctx, origin, query, maxPages, probing);
    let items;
    const transport = typeof ctx?.fetchJson === 'function' ? ctx.fetchJson : null;
    if (probing || !transport) {
      items = await walk();
    } else {
      let perTransport = walkCache.get(transport);
      if (!perTransport) {
        perTransport = new Map();
        walkCache.set(transport, perTransport);
      }
      const key = `${origin}\n${query}\n${maxPages}`;
      let pending = perTransport.get(key);
      if (!pending) {
        pending = walk();
        perTransport.set(key, pending);
        // A failed walk must not poison later entries for the rest of the run.
        pending.catch(() => perTransport.delete(key));
      }
      items = await pending;
    }

    const seen = new Set();
    const jobs = [];
    for (const item of items) {
      const job = normalizeJob(item, origin, entry);
      if (!job || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }
    return jobs;
  },
};

/**
 * Walk every page of one microsite feed and return the raw jobs[] items.
 * @param {any} entry @param {any} ctx @param {string} origin @param {string} query
 * @param {number} maxPages @param {boolean} probing
 */
async function walkFeed(entry, ctx, origin, query, maxPages, probing) {
    const ctxMaxPages = probing ? 1 : 0;
    /** @type {any[]} */
    const items = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const url = assertApiUrl(buildSearchUrl(page, query));
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, url, {
          redirect: 'error',
          headers: {
            'User-Agent': BROWSER_LIKE_USER_AGENT,
            Accept: 'application/json',
            'x-origin': origin,
          },
        }, RETRY_POLICY);
      } catch (err) {
        // Page 1 failing means the board is unreachable — surface it. While a
        // health probe runs, propagate unwrapped so ProbePageBudgetReached keeps
        // its identity. A later page failing keeps what was collected.
        if (page === 1 || ctxMaxPages > 0) throw err;
        console.error(`⚠️  directemployers: ${entry.name} page ${page} failed — ${err instanceof Error ? err.message : String(err)} (keeping ${items.length} rows collected so far)`);
        break;
      }

      if (json === null || json === undefined || (typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0)) break;
      if (!Array.isArray(json?.jobs)) {
        throw new Error(`directemployers: unexpected response shape for ${entry.name} — keys: ${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}`);
      }
      items.push(...json.jobs);

      const hasMore = json?.pagination?.has_more_pages === true;
      if (!hasMore || json.jobs.length === 0) break;
      if (page === maxPages && !(ctxMaxPages > 0)) truncated = true;
    }
    if (truncated) {
      console.error(`⚠️  directemployers: ${entry.name} hit the ${maxPages}-page cap with more postings remaining — raise max_pages on this entry`);
    }
    return items;
}
