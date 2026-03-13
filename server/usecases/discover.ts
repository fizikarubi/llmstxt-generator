import type { UseCase } from '@/server/lib/usecase';
import type { DiscoverRequest, DiscoverResponse, DiscoveryMethod } from '@/shared/types';
import { AppError } from '@/server/lib/errors';
import { fetcher } from '@/server/lib/fetcher';
import { html } from '@/server/lib/html';
import { discovery } from '@/server/lib/discovery';
import { withTrace } from '../lib/logger';

const BFS_MAX_DEPTH = 2;

const parseEntryUrl = (raw: string): URL => {
  try {
    const parsed = new URL(raw);
    return new URL(parsed.origin + parsed.pathname);
  } catch {
    throw new AppError('Invalid URL', 400);
  }
};

const deduplicateUrls = (
  candidates: string[],
  url: string,
  isAllowed: (url: string) => boolean,
  maxPages: number | null,
): string[] => {
  const seen = new Set<string>();
  const filtered = candidates.filter((u) => {
    if (seen.has(u) || u === url) return false;
    seen.add(u);
    return isAllowed(u);
  });
  return maxPages != null ? filtered.slice(0, maxPages) : filtered;
};

/** Discover all page URLs for a site via sitemap (preferred) or BFS crawl.
 *  Validates the root page, respects robots.txt, and extracts site metadata. */
export const discoverUseCase: UseCase<DiscoverRequest, DiscoverResponse> = {
  run: (ctx, input) =>
    withTrace(ctx, 'discoverUseCase', input, async () => {
      const entryUrl = parseEntryUrl(input.url);
      const maxPages = input.maxPages ?? null;

      // 1. respect robots.txt
      const robots = await fetcher.fetchRobots(ctx, entryUrl);
      if (!robots.isAllowed(entryUrl.href)) {
        throw new AppError('robots.txt disallows crawling this site', 403);
      }

      // 2. reject spa
      const entryPage = await fetcher.fetchHtml(ctx, entryUrl.href);
      if (html.isSpaShell(entryPage.html)) {
        throw new AppError(
          'This page appears to be a JavaScript app — its HTML contains no server-rendered content',
          422,
        );
      }

      // 3. get site info
      let siteHtml = entryPage.html;
      if (entryUrl.pathname !== '/') {
        try {
          const rootPage = await fetcher.fetchHtml(ctx, entryUrl.origin + '/');
          siteHtml = rootPage.html;
        } catch {
          ctx.logger.warn(
            { entryUrl: entryUrl.href },
            'could not fetch root page for site info, falling back to homepage HTML',
          );
        }
      }
      const site = html.extractSiteInfo(siteHtml, entryUrl);

      // 4. fetch urls via sitemap / bfs
      let discoveredUrls = [];
      let method: DiscoveryMethod = 'sitemap';
      discoveredUrls = await discovery.discoverFromSitemap(
        ctx,
        entryUrl,
        maxPages,
        robots.sitemaps,
      );
      if (discoveredUrls.length == 0) {
        method = 'bfs';
        discoveredUrls = await discovery.discoverFromBfs(
          ctx,
          entryUrl,
          BFS_MAX_DEPTH,
          // Over-fetch by 30% so we still hit maxPages after robots/dedup filtering
          maxPages ? Math.floor(maxPages * 1.3) : null,
        );
      }

      if (discoveredUrls.length === 0) {
        throw new AppError('No pages found — site may require JavaScript to render', 404);
      }

      const urls = deduplicateUrls(
        discoveredUrls,
        entryUrl.href,
        robots.isAllowed,
        maxPages,
      );

      return { urls, site, method };
    }),
};
