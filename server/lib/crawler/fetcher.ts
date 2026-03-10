import type { LoggerContext } from '@/server/lib/logger';
import { AppError } from '@/server/lib/errors';
import { USER_AGENT, CRAWL_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';

export interface FetchResult {
  url: string;
  html: string;
}

/**
 * Fetch a single page, following redirects, and return the final URL + HTML.
 *
 * The returned `url` is `res.url` (the post-redirect location), not the
 * original input. This matters because the pipeline uses the final URL for
 * section classification and deduplication — a redirect from `/old-page` to
 * `/new-page` should be attributed to `/new-page`.
 *
 * Non-HTML responses (e.g. PDFs served without the right extension) are
 * rejected here so callers don't have to guard against them.
 */
export const fetchPage = (ctx: LoggerContext, url: string): Promise<FetchResult> =>
  withTrace(ctx, 'fetchPage', { url }, async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new AppError(`Fetching ${url} returned ${res.status}`, res.status);
    }

    const finalOrigin = new URL(res.url).origin;
    const inputOrigin = new URL(url).origin;
    if (finalOrigin !== inputOrigin) {
      throw new AppError(`URL redirected to a different site: ${finalOrigin}`, 400);
    }

    const contentType = res.headers.get('content-type') ?? '';

    if (!contentType.includes('text/html')) {
      throw new AppError(`Non-HTML content type: ${contentType}`, 400);
    }

    const html = await Promise.race([
      res.text(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new AppError('Body read timed out', 408)),
          CRAWL_TIMEOUT_MS,
        ),
      ),
    ]);
    return { url: res.url, html };
  });
