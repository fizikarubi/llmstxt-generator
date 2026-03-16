/**
 * URL discovery via two strategies: sitemap parsing and breadth-first crawling.
 *
 * Both strategies are scoped by a `DiscoveryScope` built from the root URL.
 * The scope constrains discovery to same-origin pages under the root's path prefix
 * (e.g. root `example.com/docs/intro` scopes to `/docs/**`).
 *
 * ## Strategies
 *
 * **Sitemap** — parses `robots.txt`-declared sitemaps plus conventional locations
 * (`/sitemap.xml`, `/<prefix>/sitemap.xml`). Only flat `<urlset>` sitemaps are
 * supported; `<sitemapindex>` entries are skipped.
 *
 * **BFS** — crawls from the root outward, extracting `<a href>` links at each
 * depth level. Concurrency is capped at 20 in-flight fetches with a rate limit
 * of 20 requests per second to avoid overwhelming target servers. Each depth
 * level caps queued URLs to `remaining × 1.3` to avoid over-fetching. Caller
 * controls `maxDepth` and `maxPages`.
 *
 * ## Filtering rules (shared by both strategies)
 *
 * All URLs pass through `isCandidate`, which enforces:
 * - **Same origin** — `www.` is stripped so `www.example.com ≡ example.com`;
 *   other subdomains are out of scope.
 * - **Path prefix** — only URLs under the root's path are kept.
 * - **HTML only** — non-HTML extensions (`.pdf`, `.png`, …) are rejected;
 *   extensionless paths and known HTML extensions (`.html`, `.php`, …) pass.
 * - **Excluded paths** — `/login`, `/signup`, `/auth`, etc. are always skipped.
 * - **No pagination** — URLs containing `?page=N` are dropped.
 *
 * Path comparisons are case-insensitive; original casing is preserved in output.
 */
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';
import { Context } from './context';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const asArray = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

const EXCLUDED_PATHS = ['/login', '/signup', '/register', '/account', '/auth', '/search'];
/** Extensions that are known to be HTML pages. URLs with no extension also pass. */
const HTML_EXTS = new Set(['.html', '.htm', '.php', '.asp', '.aspx', '.jsp']);

/** True when `path` equals `prefix` or is a child of it (e.g. prefix="/docs" matches "/docs/api" but not "/docs-v2"). */
const isUnderPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Removes "www." prefix — stripWww("https://www.example.com") → "https://example.com" */
const stripWww = (origin: string): string => origin.replace(/^(https?:\/\/)www\./, '$1');

/**
 * Boundary for which URLs are "in scope" during discovery.
 * Built once from the entry URL, then passed to every filter function.
 *
 * Given entry URL `https://www.example.com/docs/getting-started`:
 *   origin         → "https://www.example.com"
 *   strippedOrigin → "https://example.com"
 *   pathname       → "/docs"
 *   href           → "https://www.example.com/docs/getting-started"
 */
interface DiscoveryScope {
  /** Full origin — "https://www.example.com" */
  origin: string;
  /** Origin without "www." for same-origin comparison — "https://example.com" */
  strippedOrigin: string;
  /** Path prefix for filtering — "/docs" (empty for root). */
  pathname: string;
  /** Complete entry URL — "https://www.example.com/docs/getting-started" */
  href: string;
}

const buildDiscoveryScope = (root: URL): DiscoveryScope => {
  const pathname = root.pathname === '/' ? '' : root.pathname.replace(/\/$/, '');

  return {
    origin: root.origin,
    strippedOrigin: stripWww(root.origin),
    pathname,
    href: root.href,
  };
};

/** Quick origin-only check for sitemap XML pointers (not page URLs). */
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
 * Single gatekeeper: decides whether a URL belongs in the discovered set.
 *
 * **Priority:** precision over recall — aggressively filters to avoid fetching
 * non-content pages (auth walls, binary files, paginated listings) even if it
 * means occasionally dropping a valid page.
 *
 * Checks (in order, short-circuits on first failure):
 *   1. Same origin (www-normalized)
 *   2. No `?page=N` pagination params
 *   3. Extension is HTML or absent (rejects `.pdf`, `.png`, etc.)
 *   4. Not an excluded path (`/login`, `/auth`, etc.)
 *   5. Under the root's path prefix
 *
 * **Assumptions:**
 * - Extensionless URLs are HTML (true for most modern frameworks).
 * - The hardcoded exclude list covers common non-content paths; site-specific
 *   excludes are not supported.
 */
const isCandidate = (scope: DiscoveryScope, url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // 1. origin check
  if (stripWww(parsed.origin) !== scope.strippedOrigin) return false;

  const path = parsed.pathname.toLowerCase();

  // 2. page check
  if (/[?&]page=\d/.test(url)) return false;

  // 3. extension check
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex > path.lastIndexOf('/')) {
    // Path has a file extension — only allow known HTML extensions
    if (!HTML_EXTS.has(path.slice(dotIndex))) return false;
  }

  // 4. path check
  if (EXCLUDED_PATHS.some((e) => path === e || path.startsWith(`${e}/`))) return false;

  // 5. prefix check
  const prefix = scope.pathname.toLowerCase();
  if (prefix && !isUnderPrefix(path, prefix)) return false;

  return true;
};

/**
 * Fetches a single sitemap XML and extracts page URLs from it.
 *
 * **Assumption:** only flat `<urlset>` sitemaps are useful — `<sitemapindex>`
 * entries are silently skipped.
 * Returns `[]` on network failure, non-200, or unsupported format.
 */
const fetchSitemapUrls = (ctx: Context, url: string): Promise<string[]> =>
  withTrace(ctx, 'fetchSitemapUrls', { url }, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return [];

      const parsed = parser.parse(await res.text());

      if (parsed?.sitemapindex?.sitemap) return [];

      if (parsed?.urlset?.url) {
        return asArray(parsed.urlset.url)
          .map((u: any) => u.loc ?? '')
          .filter(Boolean);
      }
    } catch {
      // withTrace already logs the error
    }
    return [];
  });

/**
 * Discover pages via sitemap XML
 *
 * - No recursion into `<sitemapindex>` — large sites with nested sitemaps will
 *   return fewer URLs. This keeps runtime bounded and avoids deep XML chains.
 *
 * - Assuming `robots.txt` sitemaps + conventional locations (`/sitemap.xml`,
 *   `/<prefix>/sitemap.xml`) cover the common case.
 *
 */
const discoverFromSitemap = (
  ctx: Context,
  entryUrl: URL,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<string[]> =>
  withTrace(ctx, 'discoverFromSitemap', { maxPages, robotsSitemaps }, async () => {
    const scope = buildDiscoveryScope(entryUrl);
    const entryPath = new URL(scope.href).pathname.replace(/\/$/, '');
    const sitemapUrls = new Set([
      ...robotsSitemaps.filter((u) => isSameOrigin(scope, u)),
      ...(entryPath && entryPath !== '/'
        ? [`${scope.origin}${entryPath}/sitemap.xml`]
        : []),
      `${scope.origin}/sitemap.xml`,
    ]);
    const rawUrls = (
      await Promise.all(Array.from(sitemapUrls).map((url) => fetchSitemapUrls(ctx, url)))
    ).flat();
    const filtered = rawUrls.filter((u) => isCandidate(scope, u));
    const capped = maxPages != null ? filtered.slice(0, maxPages) : filtered;
    return capped;
  });

const BFS_CONCURRENCY = 20;
/**
 * Discover pages via breadth-first crawl
 *
 * - Concurrency is capped at 20 with a rate limit of 20 req/s to avoid
 *   overwhelming the target, but this is a fixed heuristic — no adaptive
 *   back-off or rate-limit detection.
 * - Each depth level is capped at `floor(remaining * 1.3)` URLs to avoid queueing
 *   thousands of fetches when only a few more pages are needed.
 * - `maxDepth` and `maxPages` are the only safety valves; without them the
 *   crawl could be unbounded on large sites.
 * - Handles only HTML pages that contain `<a href>` links to other in-scope pages.
 *   JS-rendered links (SPA navigation) will be missed since we don't execute JS.
 * - The root URL itself is always included in results (it is the BFS seed).
 */
const discoverFromBfs = (
  ctx: Context,
  entryUrl: URL,
  maxDepth: number,
  maxPages: number | null,
): Promise<string[]> =>
  withTrace(ctx, 'discoverFromBfs', { entryUrl, maxDepth, maxPages }, async () => {
    const scope = buildDiscoveryScope(entryUrl);
    const limiter = new PQueue({
      concurrency: BFS_CONCURRENCY,
      intervalCap: 20,
      interval: 1000,
    });
    const visited = new Set<string>([scope.href]);
    const found: string[] = [];
    const cap = maxPages != null ? maxPages : Infinity;

    let queue = [scope.href];

    for (
      let depth = 0;
      depth <= maxDepth && queue.length > 0 && found.length < cap;
      depth++
    ) {
      const nextQueue = new Set<string>();

      const remaining = Math.floor((cap - found.length) * 1.3);
      const batch = queue.length > remaining ? queue.slice(0, remaining) : queue;

      await Promise.allSettled(
        batch.map((url) =>
          limiter.add(async () => {
            if (found.length >= cap) return;
            const res = await fetch(url, {
              headers: { 'User-Agent': USER_AGENT },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });

            if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) {
              return;
            }

            const html = await res.text();
            if (found.length >= cap) return;
            found.push(url);
            if (depth < maxDepth) {
              const $ = cheerio.load(html);
              $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;

                const resolved = resolveLink(href, url);
                if (resolved && !visited.has(resolved) && isCandidate(scope, resolved)) {
                  visited.add(resolved);
                  nextQueue.add(resolved);
                }
              });
            }
          }),
        ),
      );

      queue = Array.from(nextQueue);
    }
    return found;
  });

export const discovery = {
  discoverFromBfs,
  discoverFromSitemap,
};

/** @internal — exported for unit testing only */
export const _internal = {
  stripWww,
  isUnderPrefix,
  isSameOrigin,
  buildDiscoveryScope,
  resolveLink,
  isCandidate,
};
