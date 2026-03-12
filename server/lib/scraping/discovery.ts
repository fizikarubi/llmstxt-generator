/**
 * URL discovery for a site.
 *
 * 1. **Sitemap** (preferred): fetch sitemap XML, extract URLs, filter to scope.
 * 2. **BFS fallback**: follow links from root, 3 levels deep.
 */
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';
import { Context } from '../context';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const asArray = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/**
 * Matches path segments that look like locale codes: "en", "fr", "pt-br", "zh-cn".
 * Many i18n frameworks (Next.js, Nuxt, Docusaurus) prefix routes with a locale
 * segment, e.g. `/fr/docs/intro`. We detect these so we can avoid mixing
 * translations of the same page in the discovery results.
 */
const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/;
const EXCLUDED_PATHS = ['/login', '/signup', '/register', '/account', '/auth', '/search'];
const EXCLUDED_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.zip', '.xml'];
const SITEMAP_CONCURRENCY = 5;
const BFS_CONCURRENCY = 50;
const BFS_MAX_DEPTH = 3;

// ─── Scope & Utilities ───────────────────────────────────────────────────────

/**
 * Boundary for which URLs are "in scope" during discovery.
 * Built once from the entry URL, then passed to every filter function.
 *
 * Given entry URL `https://www.example.com/docs/getting-started`:
 *   origin         → "https://www.example.com"
 *   strippedOrigin → "https://example.com"
 *   pathname       → "/docs"
 *   locale         → null
 *   href           → "https://www.example.com/docs/getting-started"
 */
interface DiscoveryScope {
  /** Full origin — "https://www.example.com" */
  origin: string;
  /** Origin without "www." for same-origin comparison — "https://example.com" */
  strippedOrigin: string;
  /** Path prefix all discovered URLs must start with — "/docs" (empty for root) */
  pathname: string;
  /** Locale segment from the path — "fr" from "/fr/guides", or null */
  locale: string | null;
  /** Complete entry URL — "https://www.example.com/docs/getting-started" */
  href: string;
}

/** Removes "www." prefix — stripWww("https://www.example.com") → "https://example.com" */
const stripWww = (origin: string): string => origin.replace(/^(https?:\/\/)www\./, '$1');

/**
 * Builds a scope from the entry URL to constrain what gets discovered.
 * Extracts the path prefix and detects any locale segment.
 *
 * buildDiscoveryScope(new URL("https://example.com/fr/docs"))
 *   → { origin: "https://example.com", pathname: "/fr/docs", locale: "fr", ... }
 */
const buildDiscoveryScope = (root: URL): DiscoveryScope => {
  const pathname = root.pathname === '/' ? '' : root.pathname.replace(/\/$/, '');
  // Detect a locale prefix in the entry URL's path so we can stay within one
  // language during discovery. For "/fr/docs/intro" this finds "fr".
  // If the entry URL has no locale segment (e.g. "/docs/intro"), locale is null
  // and we'll later reject URLs that *add* a locale to avoid cross-language dupes.
  const segments = pathname.split('/').filter(Boolean);
  const locale =
    segments.find((s) => LOCALE_RE.test(s.toLowerCase()))?.toLowerCase() ?? null;

  return {
    origin: root.origin,
    strippedOrigin: stripWww(root.origin),
    pathname,
    locale,
    href: root.href,
  };
};

/**
 * Checks if a URL belongs to the same site, ignoring "www." differences.
 *
 * isSameOrigin(scope, "https://www.example.com/about") → true  (scope is example.com)
 * isSameOrigin(scope, "https://other.com/page")        → false
 */
const isSameOrigin = (scope: DiscoveryScope, url: string): boolean => {
  try {
    return stripWww(new URL(url).origin) === scope.strippedOrigin;
  } catch {
    return false;
  }
};

/**
 * Turns a raw `<a href="...">` value into a clean absolute URL for deduplication.
 * HTML links can be relative ("../about"), absolute ("/docs"), or full URLs.
 * `new URL(raw, base)` resolves them against the page they were found on.
 * Then strips hash, query params, and trailing slashes so duplicates collapse.
 *
 * resolveLink("../about", "https://example.com/docs/intro") → "https://example.com/about"
 * resolveLink("/docs/api/", "https://example.com")          → "https://example.com/docs/api"
 * resolveLink("mailto:hi@x.com", "https://example.com")     → null
 */
const resolveLink = (raw: string, base: string): string | null => {
  try {
    const u = new URL(raw, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    u.search = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/'))
      u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
};

/**
 * Decides whether a URL should be included in discovery results.
 * Rejects URLs that are outside the path prefix, have excluded extensions/paths,
 * contain pagination params, or belong to a different locale.
 *
 * isCandidate(docsScope, "https://example.com/docs/api")     → true
 * isCandidate(docsScope, "https://example.com/blog/post")    → false (outside /docs)
 * isCandidate(docsScope, "https://example.com/docs/file.pdf") → false (excluded ext)
 * isCandidate(docsScope, "https://example.com/login")         → false (excluded path)
 */
const isCandidate = (scope: DiscoveryScope, url: string): boolean => {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }

  if (/[?&]page=\d/.test(url)) return false;
  if (EXCLUDED_EXTS.some((e) => path.endsWith(e))) return false;
  if (EXCLUDED_PATHS.some((e) => path === e || path.startsWith(`${e}/`))) return false;
  if (scope.pathname && !path.startsWith(scope.pathname)) return false;

  // Locale Dedup: Reject cross-locale links
  const segments = path.split('/').filter(Boolean);
  const localeIndex = segments.findIndex((s) => LOCALE_RE.test(s));

  if (localeIndex !== -1) {
    const urlLocale = segments[localeIndex];
    if (scope.locale && urlLocale !== scope.locale) return false;

    // If our scope has no locale, ignore localized sub-paths that map back to root
    if (!scope.locale) {
      const strippedPath = '/' + segments.filter((_, i) => i !== localeIndex).join('/');
      if (!scope.pathname || strippedPath.startsWith(scope.pathname)) return false;
    }
  }

  return true;
};

/** Filters URLs through `isCandidate` and caps the result to `maxPages * 3` (over-fetches to allow for dedup later). */
const filterAndCap = (
  scope: DiscoveryScope,
  urls: string[],
  maxPages: number | null,
): string[] => {
  const filtered = urls.filter((u) => isCandidate(scope, u));
  return maxPages != null ? filtered.slice(0, maxPages * 3) : filtered;
};

// ─── Sitemap parsing ─────────────────────────────────────────────────────────

type SitemapResult = { kind: 'index' | 'urlset'; urls: string[] };

/**
 * Fetches a single sitemap XML and parses it.
 * Returns 'index' if it's a sitemap index (contains links to other sitemaps),
 * or 'urlset' if it directly lists page URLs. Returns null on failure.
 */
const fetchAndParseSitemap = async (
  scope: DiscoveryScope,
  url: string,
): Promise<SitemapResult | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    const parsed = parser.parse(await res.text());

    if (parsed?.sitemapindex?.sitemap) {
      return {
        kind: 'index',
        urls: asArray(parsed.sitemapindex.sitemap)
          .map((s: any) => s.loc ?? '')
          .filter((u) => u && isSameOrigin(scope, u)),
      };
    }

    if (parsed?.urlset?.url) {
      return {
        kind: 'urlset',
        urls: asArray(parsed.urlset.url)
          .map((u: any) => u.loc ?? '')
          .filter((u) => u && isSameOrigin(scope, u)),
      };
    }
  } catch {
    // Ignore fetch/parse errors on individual sitemaps
  }
  return null;
};

/**
 * Tries to discover pages via sitemap XML files.
 * Checks robots.txt sitemaps + well-known locations concurrently,
 * then expands any sitemap indexes into their sub-sitemaps.
 * Returns [] if no sitemaps are found or parseable.
 */
const discoverFromSitemap = async (
  scope: DiscoveryScope,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<string[]> => {
  const sitemapUrls = new Set([
    ...robotsSitemaps.filter((url) => isSameOrigin(scope, url)),
    ...(scope.pathname ? [`${scope.origin}${scope.pathname}/sitemap.xml`] : []),
    `${scope.origin}/sitemap.xml`,
  ]);

  const results = await Promise.all(
    Array.from(sitemapUrls).map((url) => fetchAndParseSitemap(scope, url)),
  );

  // Collect direct urlset results
  const directUrls = results
    .filter((r): r is SitemapResult => r?.kind === 'urlset')
    .flatMap((r) => r.urls);

  // Expand sitemap indexes concurrently
  const indexUrls = results
    .filter((r): r is SitemapResult => r?.kind === 'index')
    .flatMap((r) => r.urls.slice(0, 5));

  if (indexUrls.length > 0) {
    const subResults = await Promise.all(
      indexUrls.map((subUrl) => fetchAndParseSitemap(scope, subUrl)),
    );
    directUrls.push(
      ...subResults
        .filter((r): r is SitemapResult => r?.kind === 'urlset')
        .flatMap((r) => r.urls),
    );
  }

  return directUrls.length > 0 ? filterAndCap(scope, directUrls, maxPages) : [];
};

// ─── Discovery strategies ────────────────────────────────────────────────────

/**
 * Fallback discovery via breadth-first crawl starting from the entry URL.
 * Fetches each page, extracts `<a href>` links, and follows them up to `maxDepth` levels.
 * Stops early once `maxPages * 3` pages are found.
 */
const discoverFromBfs = async (
  ctx: Context,
  scope: DiscoveryScope,
  maxDepth: number,
  maxPages: number | null,
): Promise<string[]> => {
  const limiter = new PQueue({ concurrency: BFS_CONCURRENCY });
  const visited = new Set<string>([scope.href]);
  const found: string[] = [];
  const cap = maxPages != null ? maxPages * 3 : Infinity;

  let queue = [scope.href];
  ctx.logger.info({ label: 'bfs', phase: 'START', root: scope.href, maxDepth, cap });

  for (
    let depth = 0;
    depth <= maxDepth && queue.length > 0 && found.length < cap;
    depth++
  ) {
    const nextQueue = new Set<string>(); // Using a Set prevents duplicate scheduling in the next depth

    await Promise.all(
      queue.map((url) =>
        limiter.add(async () => {
          if (found.length >= cap) return;

          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': USER_AGENT },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });

            if (!res.ok || !res.headers.get('content-type')?.includes('text/html'))
              return;

            const html = await res.text();
            found.push(url);

            if (depth < maxDepth) {
              const $ = cheerio.load(html);
              $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;

                const resolved = resolveLink(href, url);
                if (
                  resolved &&
                  !visited.has(resolved) &&
                  isSameOrigin(scope, resolved) &&
                  isCandidate(scope, resolved)
                ) {
                  visited.add(resolved);
                  nextQueue.add(resolved);
                }
              });
            }
          } catch {
            // Suppress individual fetch errors during BFS
          }
        }),
      ),
    );

    queue = Array.from(nextQueue);
  }

  ctx.logger.info({ label: 'bfs', phase: 'END', totalFound: found.length });
  return found;
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main entry point: discovers pages on a site.
 * Tries sitemaps first (fast, comprehensive), falls back to BFS crawling if none found.
 */
export const discoverUrls = (
  ctx: Context,
  entryUrl: URL,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<{ urls: string[]; method: 'sitemap' | 'bfs' }> =>
  withTrace(ctx, 'discoverUrls', { root: entryUrl.href, maxPages }, async () => {
    const scope = buildDiscoveryScope(entryUrl);

    const sitemapUrls = await discoverFromSitemap(scope, maxPages, robotsSitemaps);
    if (sitemapUrls.length > 0) return { urls: sitemapUrls, method: 'sitemap' };

    const bfsUrls = await discoverFromBfs(ctx, scope, BFS_MAX_DEPTH, maxPages);
    return { urls: bfsUrls, method: 'bfs' };
  });
