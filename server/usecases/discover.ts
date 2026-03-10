import type { UseCase } from '@/server/lib/usecase';
import type { DiscoverRequest, DiscoverResponse } from '@/shared/types';
import { AppError } from '@/server/lib/errors';
import { fetchRobots } from '@/server/lib/crawler/robots';
import { discoverUrls } from '@/server/lib/crawler/discover';
import { fetchPage } from '@/server/lib/crawler/fetcher';
import { extractSiteInfo, isSpaShell } from '@/server/lib/crawler/extract';

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
  entryHref: string,
  isAllowed: (url: string) => boolean,
  maxPages: number | null,
): string[] => {
  const seen = new Set<string>();
  const filtered = candidates.filter((u) => {
    if (seen.has(u) || u === entryHref) return false;
    seen.add(u);
    return isAllowed(u);
  });
  return maxPages != null ? filtered.slice(0, maxPages) : filtered;
};

export const discoverUseCase: UseCase<DiscoverRequest, DiscoverResponse> = {
  run: async (ctx, input) => {
    const entryUrl = parseEntryUrl(input.url);
    const maxPages = input.maxPages ?? null;

    const robots = await fetchRobots(ctx, entryUrl);

    if (!robots.isAllowed(entryUrl.href)) {
      throw new AppError('robots.txt disallows crawling this site', 403);
    }

    const entryPage = await fetchPage(ctx, entryUrl.href);
    if (isSpaShell(entryPage.html)) {
      throw new AppError(
        'This page appears to be a JavaScript app — its HTML contains no server-rendered content',
        422,
      );
    }
    let siteHtml = entryPage.html;
    if (entryUrl.pathname !== '/') {
      try {
        const rootPage = await fetchPage(ctx, entryUrl.origin + '/');
        siteHtml = rootPage.html;
      } catch {
        ctx.logger.warn(
          { entryUrl: entryUrl.href },
          'could not fetch root page for site info, using entry page',
        );
      }
    }
    const site = extractSiteInfo(siteHtml, entryUrl);
    const discovered = await discoverUrls(ctx, entryUrl, maxPages, robots.sitemaps);

    if (discovered.urls.length === 0) {
      throw new AppError(
        'No pages found — site may require JavaScript to render',
        404,
      );
    }

    const urls = deduplicateUrls(
      discovered.urls,
      entryUrl.href,
      robots.isAllowed,
      maxPages,
    );

    ctx.logger.info(
      {
        entryUrl: entryUrl.href,
        siteName: site.name,
        count: urls.length,
        method: discovered.method,
      },
      'discovery complete',
    );

    return { urls, site, method: discovered.method };
  },
};
