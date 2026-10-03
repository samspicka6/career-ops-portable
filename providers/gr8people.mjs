// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// GR8 People career-portal provider (tracked_companies:).
//
// Career page URL: https://<tenant>.workgr8.com/  (e.g. duncanaviation.workgr8.com)
//
// The portal's job pages are a Next.js app, but every tenant also serves its
// complete open-jobs list as one zero-auth XML feed (found via a live browser
// session, then fetched with plain curl, 2026-09-22):
//   GET https://<tenant>.workgr8.com/?method=cappPortal.openJobsFeed
//   → application/xml  <jobs><job>…</job>…</jobs>
// One request returns the whole board — no pagination. Sizes seen live: 61
// jobs (Duncan Aviation), 263 jobs / 2.6 MB (West Star Aviation), so the
// request gets a longer timeout than the 10 s default.
//
// Per <job>: title, jobid, jobcode, detail-url (CDATA, canonical posting URL),
// apply-url, isRemote, workplaceType, description (<summary> etc. with CDATA
// HTML), category, company/name, positionType, primaryLocation{city, state,
// country}, postingLocations. There is NO posting date, so postedAt is omitted.

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';

const HOST_RE = /^[a-z0-9-]+\.workgr8\.com$/i;
const FEED_TIMEOUT_MS = 30_000;
const RETRY_POLICY = { retries: 2 };

/** @param {string} url */
function assertGr8Url(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gr8people: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`gr8people: URL must use HTTPS: ${url}`);
  if (!HOST_RE.test(parsed.hostname)) {
    throw new Error(`gr8people: untrusted hostname "${parsed.hostname}" — must match *.workgr8.com`);
  }
  return url;
}

/**
 * Tenant host from `entry.api` or `entry.careers_url` (api first).
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {string|null}
 */
export function resolveHost(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!HOST_RE.test(parsed.hostname)) continue;
    return parsed.hostname.toLowerCase();
  }
  return null;
}

/** @param {string} host */
export function buildFeedUrl(host) {
  return `https://${host}/?method=cappPortal.openJobsFeed`;
}

/**
 * Text content of an XML fragment: CDATA sections verbatim, everything else
 * entity-decoded.
 * @param {string|undefined} s
 */
function xmlText(s) {
  if (typeof s !== 'string') return '';
  const cdata = [...s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  if (cdata.length) return cdata.join('\n').trim();
  return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/** @param {string} block @param {string} tag */
function child(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

/**
 * Pure parser for the whole feed. Exported for unit tests. Returns [] for an
 * empty feed; throws when the body is not a <jobs> document at all.
 *
 * @param {string} xml
 * @param {string} host tenant host, used for URL validation and fallback URLs
 * @param {string} companyName
 */
export function parseGr8Feed(xml, host, companyName) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  if (!/<jobs[\s>]/.test(xml)) {
    throw new Error(`gr8people: feed for ${companyName} is not a <jobs> document`);
  }
  const out = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<job>([\s\S]*?)<\/job>/g)) {
    const block = m[1];
    const title = xmlText(child(block, 'title'));
    if (!title) continue;

    let url = '';
    const detail = xmlText(child(block, 'detail-url'));
    if (detail) {
      try {
        const parsed = new URL(detail);
        if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === host) url = parsed.href;
      } catch {
        // fall through to the jobid-built URL
      }
    }
    if (!url) {
      const jobid = xmlText(child(block, 'jobid'));
      if (/^\d+$/.test(jobid)) url = `https://${host}/jobs/${jobid}`;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const loc = child(block, 'primaryLocation') || '';
    const place = [xmlText(child(loc, 'city')), xmlText(child(loc, 'state')), xmlText(child(loc, 'country'))]
      .filter(Boolean).join(', ');
    const remote = xmlText(child(block, 'isRemote')).toLowerCase() === 'true';
    const location = [place, remote ? 'Remote' : ''].filter(Boolean).join(' · ');

    /** @type {any} */
    const job = { title, url, company: companyName, location };
    // The job's own <description>, not the one nested inside <company>.
    const ownBlock = block.replace(/<company>[\s\S]*?<\/company>/g, '');
    const description = htmlToText(xmlText(child(ownBlock, 'description')));
    if (description) job.description = description;
    out.push(job);
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'gr8people',

  detect(entry) {
    try {
      const host = resolveHost(entry);
      return host ? { url: buildFeedUrl(host) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const host = resolveHost(entry);
    if (!host) throw new Error(`gr8people: cannot derive the feed URL for ${entry.name}`);
    const url = assertGr8Url(buildFeedUrl(host));
    const xml = await fetchTextWithRetry(ctx, url, {
      redirect: 'error',
      timeoutMs: FEED_TIMEOUT_MS,
      headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/xml, text/xml' },
    }, RETRY_POLICY);
    return parseGr8Feed(xml, host, entry.name);
  },
};
