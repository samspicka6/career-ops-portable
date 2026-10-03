// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ADP Workforce Now (WFN) "Career Center" provider — hits the public
// staffing/v1/job-requisitions REST API (zero-auth, GET). Used by employers
// large and small who outsource HR/payroll to ADP and get a recruiting
// portal at workforcenow.adp.com as part of the bundle.
//
// Career page URL (what a company links from its own site):
//   https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html
//     ?cid=<cid>&ccId=<ccId>
//   cid is a per-tenant GUID; ccId scopes a "career center" within that
//   tenant (observed default across many tenants: 19000101_000001).
//
// JSON API (GET, zero-auth, no token/cookie):
//   https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions
//     ?cid=<cid>&ccId=<ccId>&$skip=<n>&$top=<n>
//   Response: { jobRequisitions: [ { itemID, requisitionTitle, postDate,
//   payGradeRange, workLevelCode, customFieldGroup, requisitionLocations,
//   clientRequisitionID }, ... ] }. The list payload does NOT carry the
//   posting body (requisitionDescription) — that needs a per-item request,
//   see fetchDetails below.
//
// Per-item detail (same API shape, itemID appended to the path):
//   .../job-requisitions/<itemID>?cid=<cid>&ccId=<ccId>
//   Adds `requisitionDescription` (HTML) to the same object.
//
// Public apply/posting URL for a requisition: the recruitment.html career
// page above, plus `&jobId=<ExternalJobID>` — ExternalJobID is a short
// numeric string nested in customFieldGroup.stringFields, NOT the long
// itemID used to key the API (observed live: itemID "9205892399474_1" vs.
// ExternalJobID "954815" for the same requisition — the site's own
// generated career-page links use the short form).
//
// Multi-tenant quirk (observed live, not documented by ADP): one (cid, ccId)
// pair can serve MULTIPLE unrelated or sister brands under one recruiting
// portal — e.g. a holding company's portfolio companies, or a PE-owned
// group's subsidiaries all routed through one shared ADP account. A
// tracked_companies: entry for a single brand therefore needs a brand
// filter, or it silently ingests every sibling company's postings under the
// configured company's name. See brand_filter below.
//
// Also observed live: repeated calls with the same $skip/$top can return a
// shifted window (new postings arriving between calls move the boundary,
// since the API sorts by most-recent-first with no stable cursor). This
// provider does not attempt to correct for it — scan.mjs's own dedup layer
// (job.url as the dedup key) absorbs the occasional missed/duplicate item
// across runs, the same way it absorbs any other board's eventual-consistency
// gaps.

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';

const ALLOWED_ADP_HOSTS = new Set([
  'workforcenow.adp.com',
  'workforcenow.cloud.adp.com',
]);

// The server caps $top at 20 regardless of what is requested (observed
// live: requesting $top=200 still returns at most 20 rows) — so this is
// both the request page size and the "short page = last page" signal.
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 60;     // ~1200 postings; raise per-entry via max_pages
const MAX_PAGES_CAP = 300;
const RETRY_POLICY = { retries: 3 }; // WAF-fronted, like workday/oraclecloud
const INTER_PAGE_DELAY_MS = 200;
const DEFAULT_DETAIL_LIMIT = 30;     // fetchDetails: true default cap

/** @param {string} url */
function assertAdpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`adp: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`adp: URL must use HTTPS: ${url}`);
  if (!ALLOWED_ADP_HOSTS.has(parsed.hostname)) {
    throw new Error(`adp: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_ADP_HOSTS].join(', ')}`);
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
 * Resolve WFN coordinates (cid, ccId, host) from a portal entry. `entry.api`
 * takes precedence over `entry.careers_url` (mirrors greenhouse/oraclecloud)
 * so a branded careers page can stay as careers_url while the WFN host/cid
 * is pinned via api:.
 *
 * @param {import('./_types.js').PortalEntry & {ccId?: string}} entry
 * @returns {{host:string, cid:string, ccId:string}|null}
 */
export function resolveSite(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!ALLOWED_ADP_HOSTS.has(parsed.hostname)) continue;
    const cid = parsed.searchParams.get('cid');
    if (!cid) continue;
    const ccId = (typeof entry.ccId === 'string' && entry.ccId)
      || parsed.searchParams.get('ccId')
      || '19000101_000001';
    return { host: parsed.hostname, cid, ccId };
  }
  return null;
}

/** @param {{host:string, cid:string, ccId:string}} site */
export function buildListUrl(site, skip = 0, top = PAGE_SIZE) {
  const url = new URL(`https://${site.host}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`);
  url.searchParams.set('cid', site.cid);
  url.searchParams.set('ccId', site.ccId);
  url.searchParams.set('$skip', String(skip));
  url.searchParams.set('$top', String(top));
  return url.href;
}

/** @param {{host:string, cid:string, ccId:string}} site @param {string} itemID */
export function buildDetailUrl(site, itemID) {
  const seg = safeEncodeURIComponent(itemID);
  if (seg === null) return null;
  const url = new URL(`https://${site.host}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${seg}`);
  url.searchParams.set('cid', site.cid);
  url.searchParams.set('ccId', site.ccId);
  return url.href;
}

/** @param {{host:string, cid:string, ccId:string}} site @param {string} jobId */
export function buildPostingUrl(site, jobId) {
  const seg = safeEncodeURIComponent(jobId);
  if (seg === null) return null;
  const url = new URL(`https://${site.host}/mascsr/default/mdf/recruitment/recruitment.html`);
  url.searchParams.set('cid', site.cid);
  url.searchParams.set('ccId', site.ccId);
  url.searchParams.set('jobId', jobId); // re-set raw; URL already encodes on serialize
  return url.href;
}

/** @param {any} req */
function externalJobId(req) {
  const fields = req?.customFieldGroup?.stringFields;
  if (!Array.isArray(fields)) return null;
  const f = fields.find((x) => x?.nameCode?.codeValue === 'ExternalJobID');
  return typeof f?.stringValue === 'string' && f.stringValue ? f.stringValue : null;
}

/** @param {any} req */
function isHourly(req) {
  const fields = req?.customFieldGroup?.codeFields;
  if (!Array.isArray(fields)) return false;
  const f = fields.find((x) => x?.nameCode?.codeValue === 'SalaryType');
  return f?.codeValue === 'HR';
}

const HOURS_PER_YEAR = 2080; // 52 weeks x 40 hours — same convention _shared.md uses elsewhere

/** @param {any} req */
function parseSalary(req) {
  const range = req?.payGradeRange;
  const min = range?.minimumRate?.amountValue;
  const max = range?.maximumRate?.amountValue;
  const currency = range?.minimumRate?.currencyCode || range?.maximumRate?.currencyCode;
  if (typeof min !== 'number' && typeof max !== 'number') return undefined;
  const hourly = isHourly(req);
  const scale = hourly ? HOURS_PER_YEAR : 1;
  /** @type {{min?:number, max?:number, currency?:string}} */
  const out = {};
  if (typeof min === 'number') out.min = min * scale;
  if (typeof max === 'number') out.max = max * scale;
  if (currency) out.currency = String(currency).toUpperCase();
  return out;
}

/** @param {any} req */
function locationParts(req) {
  const loc = Array.isArray(req?.requisitionLocations) ? req.requisitionLocations[0] : null;
  const shortName = typeof loc?.nameCode?.shortName === 'string' ? loc.nameCode.shortName.trim() : '';
  if (!shortName) return { brand: '', location: '' };
  const segs = shortName.split(',').map((s) => s.trim()).filter(Boolean);
  const brand = segs[0] || '';
  const location = segs.slice(1).join(', ');
  return { brand, location: location || shortName };
}

/**
 * Whether a requisition's brand matches an entry's brand_filter — one or
 * more case-insensitive substrings tested against the location's brand
 * prefix (e.g. "Kaman" matches both "Kaman Air Vehicles" and "Kamatics
 * Corporation"). No filter configured → matches everything (job_boards:
 * shape, multi-brand tenant read as-is).
 *
 * @param {string} brand
 * @param {string|string[]|undefined} brandFilter
 */
export function matchesBrandFilter(brand, brandFilter) {
  if (!brandFilter) return true;
  const needles = (Array.isArray(brandFilter) ? brandFilter : [brandFilter])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().toLowerCase());
  if (needles.length === 0) return true;
  const hay = brand.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

/**
 * Pure normalizer for one requisition → Job shape (minus description,
 * filled separately when fetchDetails is on). Exported for unit tests.
 *
 * @param {any} req
 * @param {{host:string, cid:string, ccId:string}} site
 * @param {import('./_types.js').PortalEntry & {brand_filter?: string|string[]}} entry
 * @returns {(import('./_types.js').Job & {_brand?: string}) | null}
 */
export function normalizeRequisition(req, site, entry) {
  if (!req || typeof req !== 'object') return null;
  const title = typeof req.requisitionTitle === 'string' ? req.requisitionTitle.trim() : '';
  if (!title) return null;
  const jobId = externalJobId(req);
  if (!jobId) return null;
  const url = buildPostingUrl(site, jobId);
  if (!url) return null;
  const { brand, location } = locationParts(req);
  if (!matchesBrandFilter(brand, entry.brand_filter)) return null;
  const company = entry.brand_filter ? entry.name : (brand || entry.name);
  const salary = parseSalary(req);
  const postedAt = toEpochMs(req.postDate);
  /** @type {any} */
  const job = { title, url, company, location };
  if (salary) job.salary = salary;
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/**
 * Extracts requisitionDescription (HTML) as plain text from a detail-endpoint
 * response. Exported for tests.
 * @param {any} detail
 */
export function detailDescriptionText(detail) {
  const html = detail?.requisitionDescription;
  if (typeof html !== 'string' || !html) return undefined;
  const text = htmlToText(decodeEntities(html));
  return text || undefined;
}

/** @type {Provider} */
export default {
  id: 'adp',

  detect(entry) {
    try {
      const site = resolveSite(entry);
      return site ? { url: buildListUrl(site, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const site = resolveSite(entry);
    if (!site) throw new Error(`adp: cannot derive API URL for ${entry.name}`);

    const configuredMax = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMaxPages = Number(ctx?.maxPages);
    const maxPages = ctxMaxPages > 0 ? Math.min(configuredMax, ctxMaxPages) : configuredMax;

    /** @type {any[]} */
    const rawReqs = [];
    for (let page = 0; page < maxPages; page++) {
      const skip = page * PAGE_SIZE;
      const listUrl = buildListUrl(site, skip, PAGE_SIZE);
      assertAdpUrl(listUrl); // SSRF guard before every fetch
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, listUrl, {
          redirect: 'error',
          headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
        }, RETRY_POLICY);
      } catch (err) {
        // While verify-portals probes (ctx.maxPages set), a fetch rejection
        // must propagate unwrapped so ProbePageBudgetReached is recognizable.
        if (ctxMaxPages > 0) throw err;
        console.error(`⚠️  adp: ${entry.name} page ${page} failed — ${err instanceof Error ? err.message : String(err)} (keeping ${rawReqs.length} rows collected so far)`);
        break;
      }

      if (Array.isArray(json?.jobRequisitions)) {
        const list = json.jobRequisitions;
        rawReqs.push(...list);
        if (list.length < PAGE_SIZE) break; // short page = last page
        continue;
      }
      // Contentless body — "endpoint alive, nothing matched": null, {}, or
      // {jobRequisitions: null}. Treated as the end of results, not an error.
      const isContentless = json === null || json === undefined
        || (typeof json === 'object' && !Array.isArray(json)
          && (Object.keys(json).length === 0 || json.jobRequisitions === null));
      if (isContentless) break;
      // Anything else isn't the documented shape — surface it rather than
      // silently reporting an empty board forever.
      throw new Error(`adp: unexpected response shape for ${entry.name} — keys: ${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}`);
    }

    const jobs = rawReqs
      .map((req) => normalizeRequisition(req, site, entry))
      .filter(/** @returns {job is import('./_types.js').Job} */ (job) => job !== null);

    // Optional per-posting description enrichment (opt-in, bounded — mirrors
    // vdab.mjs / smartrecruiters.mjs). Skipped entirely while a health probe
    // is running (ctx.maxPages set): the probe has no use for it.
    if (entry.fetchDetails && !(ctxMaxPages > 0)) {
      const limit = Number.isInteger(entry.detailLimit) && entry.detailLimit > 0
        ? entry.detailLimit
        : DEFAULT_DETAIL_LIMIT;
      const byUrl = new Map(jobs.map((j) => [j.url, j]));
      const targets = rawReqs.slice(0, limit);
      for (const req of targets) {
        const job = normalizeRequisition(req, site, entry);
        if (!job) continue;
        const target = byUrl.get(job.url);
        if (!target) continue;
        const detailUrl = buildDetailUrl(site, req.itemID);
        if (!detailUrl) continue;
        assertAdpUrl(detailUrl);
        try {
          await sleep(INTER_PAGE_DELAY_MS, ctx);
          const detail = await fetchJsonWithRetry(ctx, detailUrl, {
            redirect: 'error',
            headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
          }, RETRY_POLICY);
          const description = detailDescriptionText(detail);
          if (description) target.description = description;
        } catch (err) {
          console.error(`⚠️  adp: ${entry.name} detail fetch failed for ${job.url} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return jobs;
  },
};
