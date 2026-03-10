/**
 * URL discovery for site crawls.
 *
 * ## Flow overview
 *
 * 1. **Sitemap discovery** (preferred): Try to fetch sitemap XML and extract URLs.
 *    Candidate locations are tried in priority order:
 *    - URLs from robots.txt `Sitemap:` directives (authoritative; sitemap can live anywhere)
 *    - Subpath sitemap (`/docs/sitemap.xml`) when the user entered a subpath
 *    - Root sitemap (`/sitemap.xml`)
 *    Deduplication prevents fetching the same URL twice (e.g. robots.txt often
 *    points at `/sitemap.xml`).
 *
 * 2. **BFS fallback**: If no sitemap yields URLs, crawl by following links from
 *    the root. One depth level at a time; 3 levels max.
 *    Slower but works on sites without a sitemap.
 *
 * ## maxPages cap
 *
 * Both strategies respect the user-configured `maxPages` limit. Discovered URLs
 * are over-provisioned at 3x `maxPages` to account for pages that will be
 * dropped by robots.txt checks, failed fetches, or thin-content filtering
 * later in the pipeline. The final deduplication pass in the usecase layer
 * enforces the exact cap.
 *
 * ## www stripping
 *
 * Sitemaps often list URLs as `https://www.example.com/...` while users enter
 * `example.com` (or vice versa). We treat `www.` and bare domain as the same
 * origin so we don't reject every sitemap URL and fall back to BFS unnecessarily.
 */
import * as cheerio from 'cheerio';
import Bottleneck from 'bottleneck';
import { XMLParser } from 'fast-xml-parser';
import type { LoggerContext } from '@/server/lib/logger';
import { USER_AGENT, CRAWL_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';

// `ignoreAttributes: false` keeps XML attributes like `priority` in sitemap entries.
// `attributeNamePrefix: ''` avoids the default `@_` prefix so we can access attrs directly.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
});

/**
 * Canonicalize a raw href (possibly relative) into an absolute URL suitable for
 * deduplication. Strips hash fragments and query strings so that e.g.
 * `/docs/api#auth` and `/docs/api?ref=nav` both resolve to the same canonical
 * URL. Trailing slashes are also removed (`/docs/` → `/docs`) to prevent
 * duplicate entries for the same page.
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
const EXCLUDED_PATHS = [
  '/login',
  '/signup',
  '/register',
  '/account',
  '/auth',
  '/search',
];
// Binary and non-HTML resources that can't be meaningfully extracted as text.
const EXCLUDED_EXTS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.zip',
  '.xml',
];

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

/**
 * Build a crawl scope from the entry URL. If the user enters
 * `example.com/en/docs`, we detect "en" as the target locale and `/en/docs`
 * as the path prefix so we only discover pages under that subtree in that
 * language.
 */
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
const stripWww = (origin: string): string =>
  origin.replace(/^(https?:\/\/)www\./, '$1');

const isSameOrigin = (url: string, ctx: CrawlScope): boolean => {
  try {
    return stripWww(new URL(url).origin) === stripWww(ctx.origin);
  } catch {
    return false;
  }
};

/**
 * Ensure the URL falls under the root's path prefix. When a user provides a
 * subpath like `example.com/docs`, we only want pages under `/docs/...`, not
 * unrelated pages like `/blog/...` that might appear in the sitemap.
 * If the root is the site root (empty pathname), all same-origin pages qualify.
 */
const matchesPathPrefix = (url: string, ctx: CrawlScope): boolean => {
  if (!ctx.pathname) return true;
  try {
    const urlPath = new URL(url).pathname;
    return urlPath === ctx.pathname || urlPath.startsWith(ctx.pathname + '/');
  } catch {
    return false;
  }
};

/**
 * Detect and reject localized duplicates of the same content.
 *
 * Many sites serve identical pages under `/en/pricing`, `/fr/pricing`, `/de/pricing`, etc.
 * Including all locales would bloat the output with redundant content.
 *
 * Two modes:
 * 1. Root has a locale (e.g. `/en/docs`): keep only pages matching that locale,
 *    reject any URL whose locale segment differs (e.g. `/fr/docs/api` is rejected).
 * 2. Root has no locale (e.g. `/docs`): any URL containing a locale segment that
 *    maps to content within our path prefix is treated as a localized duplicate
 *    (e.g. `/fr/docs/api` is a dup of `/docs/api`).
 */
const isLocalizedDuplicate = (url: string, ctx: CrawlScope): boolean => {
  try {
    const urlPath = new URL(url).pathname;
    const segments = urlPath.split('/').filter(Boolean);

    const localeIdx = segments.findIndex((s) => LOCALE_RE.test(s.toLowerCase()));
    if (localeIdx === -1) return false;

    const urlLocale = segments[localeIdx].toLowerCase();

    if (ctx.locale) {
      return urlLocale !== ctx.locale;
    }

    // Strip the locale segment and check if the remaining path falls under our prefix.
    // If it does, this is a translated version of a page we'd already crawl at the
    // non-localized path, so treat it as a duplicate.
    const pathWithoutLocale =
      '/' +
      [...segments.slice(0, localeIdx), ...segments.slice(localeIdx + 1)].join('/');
    return pathWithoutLocale.startsWith(ctx.pathname) || ctx.pathname === '';
  } catch {
    return false;
  }
};

/** Reject URLs that are unlikely to contain useful prose: auth pages, binary files, paginated lists. */
const isExcluded = (url: string): boolean => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (EXCLUDED_PATHS.some((e) => path === e || path.startsWith(e + '/')))
      return true;
    if (EXCLUDED_EXTS.some((e) => path.endsWith(e))) return true;
    // Paginated list pages (e.g. /blog?page=3) add noise without unique content.
    if (/[?&]page=\d/.test(url)) return true;
    return false;
  } catch {
    return false;
  }
};

/** Combined gate: a URL is a candidate only if it passes all three independent filters. */
const isCandidate = (loc: string, ctx: CrawlScope): boolean =>
  !isExcluded(loc) && matchesPathPrefix(loc, ctx) && !isLocalizedDuplicate(loc, ctx);

// ─── Sitemap parsing ─────────────────────────────────────────────────────────
//
// Sitemaps come in two flavors:
//   1. Sitemap index — a list of child sitemap URLs (<sitemapindex><sitemap><loc>…)
//   2. URL set — a flat list of page URLs with optional <priority> hints
//
// We handle both, following one level of indirection for indexes.

interface SitemapUrl {
  loc: string;
  priority?: number; // 0.0–1.0 from the sitemap; higher = more important to the site
}

type SitemapResult =
  | { kind: 'index'; sitemaps: string[] }
  | { kind: 'urlset'; urls: SitemapUrl[] };

/**
 * Parse a sitemap XML string. Returns a discriminated union so callers know
 * whether they got a sitemap index (needs further fetching) or a URL set
 * (ready to filter). fast-xml-parser returns single items as objects rather
 * than arrays, so we normalize both cases.
 */
const parseSitemap = (xml: string, ctx: CrawlScope): SitemapResult | null => {
  try {
    const parsed = parser.parse(xml);

    const sitemapIndex = parsed?.sitemapindex?.sitemap;
    if (sitemapIndex) {
      const items = Array.isArray(sitemapIndex) ? sitemapIndex : [sitemapIndex];
      return {
        kind: 'index',
        sitemaps: items
          .map((s: { loc?: string }) => s.loc ?? '')
          .filter((loc) => loc && isSameOrigin(loc, ctx)),
      };
    }

    const urlset = parsed?.urlset?.url;
    if (!urlset) return null;
    const items = Array.isArray(urlset) ? urlset : [urlset];
    return {
      kind: 'urlset',
      urls: items
        .map((u: { loc?: string; priority?: string | number }) => ({
          loc: u.loc ?? '',
          // Default to 0.5 (mid-range) when no priority is specified, matching the
          // sitemap protocol's default. This keeps unprioritized pages in the middle
          // of the ranking rather than dropping them to the bottom.
          priority: u.priority ? Number(u.priority) : 0.5,
        }))
        .filter((u) => u.loc && isSameOrigin(u.loc, ctx)),
    };
  } catch {
    return null;
  }
};

/**
 * Apply candidate filters, sort by sitemap priority (highest first), and cap
 * at `maxPages * 3`. The 3x over-provision accounts for pages that will later
 * be dropped by robots.txt checks, failed fetches, or thin-content filtering
 * in the pipeline — we want enough headroom to still hit `maxPages` at the end.
 *
 * When `maxPages` is `null` (no limit), the full filtered list is returned.
 */
const filterAndRank = (
  urls: SitemapUrl[],
  ctx: CrawlScope,
  maxPages: number | null,
): string[] => {
  const sorted = urls
    .filter((u) => isCandidate(u.loc, ctx))
    .sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5));
  return (maxPages != null ? sorted.slice(0, maxPages * 3) : sorted).map(
    (u) => u.loc,
  );
};

// ─── Discovery strategies ────────────────────────────────────────────────────
//
// Two strategies, tried in order:
//   1. Sitemap — fast, structured, includes priority hints. Preferred when available.
//   2. BFS crawl — fallback for sites without a sitemap. Slower but works anywhere.

/**
 * Discover pages via sitemap XML. Candidate sitemap locations are tried in
 * priority order:
 *
 *   1. URLs declared in robots.txt `Sitemap:` directives — the source of truth;
 *      a sitemap can be named anything and hosted at any path.
 *   2. Subpath sitemap (`/docs/sitemap.xml`) — most relevant scope when the
 *      user provided a subpath like `example.com/docs`.
 *   3. Root sitemap (`/sitemap.xml`) — the standard default location.
 *
 * If we find a sitemap index, we follow one level of indirection and merge URLs
 * from up to 5 child sitemaps. We cap at 5 to keep discovery fast — large sites
 * may have dozens of sub-sitemaps but the first few typically cover the most
 * important pages.
 *
 * Returns early on the first successful sitemap to avoid double-counting pages
 * that appear in both locations.
 */
const discoverFromSitemap = async (
  ctx: CrawlScope,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<string[]> => {
  const sitemapUrls = [
    ...robotsSitemaps.filter((loc) => isSameOrigin(loc, ctx)),
    ...(ctx.pathname ? [`${ctx.origin}${ctx.pathname}/sitemap.xml`] : []),
    `${ctx.origin}/sitemap.xml`,
  ];
  const seen = new Set<string>();
  const deduped = sitemapUrls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  for (const sitemapUrl of deduped) {
    try {
      const res = await fetch(sitemapUrl, {
        signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const result = parseSitemap(xml, ctx);
      if (!result) continue;

      if (result.kind === 'index') {
        const allUrls: SitemapUrl[] = [];
        for (const loc of result.sitemaps.slice(0, 5)) {
          try {
            const subRes = await fetch(loc, {
              signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
            });
            if (!subRes.ok) continue;
            const subXml = await subRes.text();
            const sub = parseSitemap(subXml, ctx);
            if (sub?.kind === 'urlset') allUrls.push(...sub.urls);
          } catch {
            // Individual sub-sitemaps may 404 or timeout; continue with what we have.
          }
        }
        return filterAndRank(allUrls, ctx, maxPages);
      }

      return filterAndRank(result.urls, ctx, maxPages);
    } catch {
      // Sitemap doesn't exist or is malformed — try the next location.
    }
  }
  return [];
};

const BFS_CONCURRENCY = 10;

/**
 * Breadth-first link crawl starting from the root URL.
 *
 * Processes one depth level at a time: fetch all pages in the current queue,
 * extract `<a>` hrefs from their HTML, and enqueue newly discovered links for
 * the next depth. This level-by-level approach ensures pages closer to the
 * root (typically more important) are found before deeper pages.
 *
 * Key invariants:
 * - `visited` tracks every URL we've ever resolved, preventing cycles and
 *   duplicate fetches across all depth levels.
 * - `found` only includes URLs that actually returned valid HTML (not just
 *   discovered links), so the count reflects real crawlable pages.
 * - The `cap` (3x maxPages) over-provisions for the same reason as sitemap
 *   ranking: later pipeline stages will filter some pages out.
 * - Link extraction is skipped at the final depth level since those links
 *   would go into a queue that never gets processed.
 */
const discoverFromBfs = async (
  ctx: CrawlScope,
  maxDepth: number,
  maxPages: number | null,
  logger: LoggerContext['logger'],
): Promise<string[]> => {
  const limiter = new Bottleneck({ maxConcurrent: BFS_CONCURRENCY });
  const visited = new Set<string>();
  const found: string[] = [];
  const cap = maxPages != null ? maxPages * 3 : Infinity;

  /**
   * Resolve a raw href against its base page URL, returning the canonical form
   * only if it's a new, same-origin candidate. The `visited` check here
   * (rather than at enqueue time) prevents races where concurrent fetches on
   * the same depth level discover the same link.
   */
  const tryResolve = (raw: string, base: string): string | null => {
    const resolved = resolveHref(raw, base);
    if (!resolved || visited.has(resolved) || !isSameOrigin(resolved, ctx))
      return null;
    if (!isCandidate(resolved, ctx)) return null;
    return resolved;
  };

  let queue = [ctx.href];
  visited.add(ctx.href);
  logger.info({ label: 'bfs', phase: 'START', root: ctx.href, maxDepth, cap });

  for (
    let depth = 0;
    depth <= maxDepth && queue.length > 0 && found.length < cap;
    depth++
  ) {
    logger.info({
      label: 'bfs',
      depth,
      queueSize: queue.length,
      foundSoFar: found.length,
    });
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

            // Only extract outgoing links if we haven't hit the max depth —
            // no point building a queue we'll never process.
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

    logger.info({
      label: 'bfs',
      depth,
      fetched,
      failed,
      skipped,
      found: found.length,
      nextQueueSize: nextQueue.length,
    });

    queue = nextQueue;
  }

  logger.info({ label: 'bfs', phase: 'END', totalFound: found.length });
  return found;
};

// ─── Public API ──────────────────────────────────────────────────────────────

// 3 levels of link-following is usually enough to reach most content pages
// without spending too long on very deep site structures.
const BFS_MAX_DEPTH = 3;

/**
 * Discover crawlable URLs for a site.
 *
 * Sitemap first (fast, structured, priority-ranked); BFS link crawl as fallback.
 * Both strategies respect `maxPages` — results are over-provisioned at 3x to
 * account for pages dropped later by robots.txt, failed fetches, or thin content.
 * The usecase layer applies the final exact cap after deduplication.
 *
 * See module JSDoc for full flow overview, sitemap priority, and www stripping.
 */
export const discoverUrls = (
  ctx: LoggerContext,
  entryUrl: URL,
  maxPages: number | null,
  robotsSitemaps: string[],
): Promise<{ urls: string[]; method: 'sitemap' | 'bfs' }> =>
  withTrace(ctx, 'discoverUrls', { root: entryUrl.href, maxPages }, async () => {
    const rootCtx = buildCrawlScope(entryUrl);
    const sitemapUrls = await discoverFromSitemap(rootCtx, maxPages, robotsSitemaps);
    if (sitemapUrls.length > 0)
      return { urls: sitemapUrls, method: 'sitemap' as const };
    const bfsUrls = await discoverFromBfs(
      rootCtx,
      BFS_MAX_DEPTH,
      maxPages,
      ctx.logger,
    );
    return { urls: bfsUrls, method: 'bfs' as const };
  });
