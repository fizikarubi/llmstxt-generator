/**
 * URL discovery for site crawls.
 *
 * 1. **Sitemap** (preferred): fetch sitemap XML, extract URLs, filter to scope.
 * 2. **BFS fallback**: crawl links from root, 3 levels deep.
 *
 * Both strategies over-provision at 3x `maxPages` to compensate for pages
 * dropped later by robots.txt, failed fetches, or thin-content filtering.
 * The usecase layer enforces the exact cap after deduplication.
 */
import * as cheerio from 'cheerio';
import Bottleneck from 'bottleneck';
import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT, CRAWL_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';
import { Context } from '../context';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
});

/** Normalize a single XML element that may be an object or array into an array. */
const asArray = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/**
 * Canonicalize a raw href (possibly relative) into an absolute URL suitable for
 * deduplication. Strips hash fragments, query strings, and trailing slashes.
 */
const resolveHref = (raw: string, base: string): string | null => {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.search = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
};

// Matches path segments that look like locale codes: "en", "fr", "pt-br", etc.
const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/;

// Auth/account pages rarely contain useful content for an llms.txt file.
const EXCLUDED_PATHS = ['/login', '/signup', '/register', '/account', '/auth', '/search'];
// Binary and non-HTML resources that can't be meaningfully extracted as text.
const EXCLUDED_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.zip', '.xml'];

/**
 * Pre-computed scope boundaries derived from the entry URL. Every URL filter
 * needs the entry's origin, path prefix, and locale — computing them once
 * avoids redundant URL parsing across hundreds of candidate checks.
 */
interface CrawlScope {
  origin: string;
  pathname: string; // normalized: no trailing slash; empty string for site root "/"
  locale: string | null; // e.g. "en" from /en/docs — used to filter out other-locale pages
  href: string;
}

const buildCrawlScope = (root: URL): CrawlScope => {
  const pathname = root.pathname === '/' ? '' : root.pathname.replace(/\/$/, '');
  const segments = pathname.split('/').filter(Boolean);
  const locale =
    segments.find((s) => LOCALE_RE.test(s.toLowerCase()))?.toLowerCase() ?? null;
  return { origin: root.origin, pathname, locale, href: root.href };
};

/**
 * Strip a leading `www.` so `www.example.com` and `example.com` compare equal.
 * Many sites list sitemap URLs with `www.` while users enter the bare domain
 * (or vice versa). Without this, isSameOrigin would reject every sitemap URL
 * and discovery would incorrectly fall back to BFS.
 */
const stripWww = (origin: string): string => origin.replace(/^(https?:\/\/)www\./, '$1');

const isSameOrigin = (scope: CrawlScope, url: string): boolean => {
  try {
    return stripWww(new URL(url).origin) === stripWww(scope.origin);
  } catch {
    return false;
  }
};

/**
 * Combined candidate gate — parses the URL once and checks exclusions,
 * path prefix, and locale dedup in a single pass.
 */
const isCandidate = (scope: CrawlScope, url: string): boolean => {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const lower = path.toLowerCase();

  // Excluded paths & extensions
  if (EXCLUDED_PATHS.some((e) => lower === e || lower.startsWith(e + '/'))) return false;
  if (EXCLUDED_EXTS.some((e) => lower.endsWith(e))) return false;
  if (/[?&]page=\d/.test(url)) return false;

  // Path prefix
  if (scope.pathname && path !== scope.pathname && !path.startsWith(scope.pathname + '/'))
    return false;

  // Locale dedup: reject localized duplicates (e.g. /fr/docs when crawling /en/docs)
  const segments = path.split('/').filter(Boolean);
  const li = segments.findIndex((s) => LOCALE_RE.test(s.toLowerCase()));
  if (li !== -1) {
    const urlLocale = segments[li].toLowerCase();
    if (scope.locale) {
      if (urlLocale !== scope.locale) return false;
    } else {
      const stripped =
        '/' + [...segments.slice(0, li), ...segments.slice(li + 1)].join('/');
      if (stripped.startsWith(scope.pathname) || scope.pathname === '') return false;
    }
  }

  return true;
};

// ─── Sitemap parsing ─────────────────────────────────────────────────────────

type SitemapResult =
  | { kind: 'index'; sitemaps: string[] }
  | { kind: 'urlset'; urls: string[] };

/**
 * Parse a sitemap XML string into either a sitemap index (needs further
 * fetching) or a flat URL list (ready to filter).
 */
const parseSitemap = (scope: CrawlScope, xml: string): SitemapResult | null => {
  try {
    const parsed = parser.parse(xml);

    const sitemapIndex = parsed?.sitemapindex?.sitemap;
    if (sitemapIndex) {
      return {
        kind: 'index',
        sitemaps: asArray(sitemapIndex)
          .map((s: { loc?: string }) => s.loc ?? '')
          .filter((url) => url && isSameOrigin(scope, url)),
      };
    }

    const urlset = parsed?.urlset?.url;
    if (!urlset) return null;
    return {
      kind: 'urlset',
      urls: asArray(urlset)
        .map((u: { loc?: string }) => u.loc ?? '')
        .filter((url) => url && isSameOrigin(scope, url)),
    };
  } catch {
    return null;
  }
};

/** Filter URLs to candidates and cap at 3x maxPages. */
const filterAndCap = (
  scope: CrawlScope,
  urls: string[],
  maxPages: number | null,
): string[] => {
  const filtered = urls.filter((u) => isCandidate(scope, u));
  return maxPages != null ? filtered.slice(0, maxPages * 3) : filtered;
};

// ─── Discovery strategies ────────────────────────────────────────────────────

/**
 * Discover pages via sitemap XML. Tries robots.txt sitemaps, subpath sitemap,
 * then root sitemap. Follows one level of sitemap indexes (up to 5 children).
 * Returns early on the first successful sitemap.
 */
const discoverFromSitemap = async (
  scope: CrawlScope,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<string[]> => {
  const sitemapUrls = [
    ...robotsSitemaps.filter((url) => isSameOrigin(scope, url)),
    ...(scope.pathname ? [`${scope.origin}${scope.pathname}/sitemap.xml`] : []),
    `${scope.origin}/sitemap.xml`,
  ];
  const deduped = [...new Set(sitemapUrls)];

  for (const sitemapUrl of deduped) {
    try {
      const res = await fetch(sitemapUrl, {
        signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const result = parseSitemap(scope, xml);
      if (!result) continue;

      if (result.kind === 'index') {
        const allUrls: string[] = [];
        for (const url of result.sitemaps.slice(0, 5)) {
          try {
            const subRes = await fetch(url, {
              signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
            });
            if (!subRes.ok) continue;
            const subXml = await subRes.text();
            const sub = parseSitemap(scope, subXml);
            if (sub?.kind === 'urlset') allUrls.push(...sub.urls);
          } catch {
            // Individual sub-sitemaps may 404 or timeout; continue with what we have.
          }
        }
        return filterAndCap(scope, allUrls, maxPages);
      }

      return filterAndCap(scope, result.urls, maxPages);
    } catch {
      // Sitemap doesn't exist or is malformed — try the next location.
    }
  }
  return [];
};

const BFS_CONCURRENCY = 50;
/**
 * Breadth-first link crawl starting from the root URL.
 * Processes one depth level at a time, up to `maxDepth` levels.
 */
const discoverFromBfs = async (
  ctx: Context,
  scope: CrawlScope,
  maxDepth: number,
  maxPages: number | null,
): Promise<string[]> => {
  const limiter = new Bottleneck({ maxConcurrent: BFS_CONCURRENCY });
  const visited = new Set<string>();
  const found: string[] = [];
  const cap = maxPages != null ? maxPages * 3 : Infinity;

  const tryResolve = (raw: string, base: string): string | null => {
    const resolved = resolveHref(raw, base);
    if (!resolved || visited.has(resolved) || !isSameOrigin(scope, resolved)) return null;
    if (!isCandidate(scope, resolved)) return null;
    return resolved;
  };

  let queue = [scope.href];
  visited.add(scope.href);
  ctx.logger.info({ label: 'bfs', phase: 'START', root: scope.href, maxDepth, cap });

  for (
    let depth = 0;
    depth <= maxDepth && queue.length > 0 && found.length < cap;
    depth++
  ) {
    const nextQueue: string[] = [];

    let fetched = 0;
    let failed = 0;
    let skipped = 0;

    await Promise.all(
      queue.map((url) =>
        limiter.schedule(async () => {
          if (found.length >= cap) {
            skipped++;
            return;
          }
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': USER_AGENT },
              signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
            });
            fetched++;
            if (!res.ok) return;
            const ct = res.headers.get('content-type') ?? '';
            if (!ct.includes('text/html')) return;

            const html = await res.text();
            found.push(url);
            ctx.logger.info({
              label: 'bfs found',
              url,
              foundSoFar: found.length,
            });

            if (depth < maxDepth) {
              const $ = cheerio.load(html);
              $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                const next = tryResolve(href, url);
                if (next) {
                  visited.add(next);
                  nextQueue.push(next);
                }
              });
            }
          } catch {
            failed++;
          }
        }),
      ),
    );

    queue = nextQueue;
  }

  ctx.logger.info({ label: 'bfs', phase: 'END', totalFound: found.length });
  return found;
};

// ─── Public API ──────────────────────────────────────────────────────────────

const BFS_MAX_DEPTH = 3;

/**
 * Discover crawlable URLs for a site.
 * Sitemap first; BFS link crawl as fallback.
 */
export const discoverUrls = (
  ctx: Context,
  entryUrl: URL,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<{ urls: string[]; method: 'sitemap' | 'bfs' }> =>
  withTrace(ctx, 'discoverUrls', { root: entryUrl.href, maxPages }, async () => {
    const scope = buildCrawlScope(entryUrl);
    const sitemapUrls = await discoverFromSitemap(scope, maxPages, robotsSitemaps);
    if (sitemapUrls.length > 0) return { urls: sitemapUrls, method: 'sitemap' as const };
    const bfsUrls = await discoverFromBfs(ctx, scope, BFS_MAX_DEPTH, maxPages);
    return { urls: bfsUrls, method: 'bfs' as const };
  });
