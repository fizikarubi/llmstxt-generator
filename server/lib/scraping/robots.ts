import robotsParser from 'robots-parser';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './consts';
import { withTrace } from '@/server/lib/logger';
import { Context } from '../context';

/** Thin wrapper so the rest of the pipeline doesn't depend on robots-parser internals. */
interface RobotsChecker {
  isAllowed: (url: string) => boolean;
  /** Sitemap URLs declared via `Sitemap:` directives in robots.txt. */
  sitemaps: string[];
}

/**
 * Fetch and parse the site's robots.txt, returning a checker the pipeline uses
 * to filter out disallowed URLs before scraping them.
 *
 * Graceful degradation:
 * - If the fetch fails (network error, timeout) or returns a non-200, we
 *   default to allow-all. Per the robots.txt spec, a missing file means no
 *   restrictions. A 5xx may indicate a temporary issue, but blocking the
 *   entire run for a transient server error would be overly conservative.
 * - `robots.isAllowed()` returns `true | false | undefined`; we treat
 *   `undefined` (no matching rule) as allowed via the `!== false` check.
 */
export const fetchRobots = (ctx: Context, entryUrl: URL): Promise<RobotsChecker> =>
  withTrace(ctx, 'fetchRobots', { root: entryUrl.href }, async () => {
    const robotsUrl = `${entryUrl.origin}/robots.txt`;
    try {
      const res = await fetch(robotsUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = res.ok ? await res.text() : '';
      const robots = robotsParser(robotsUrl, text);
      return {
        isAllowed: (url: string) => robots.isAllowed(url, USER_AGENT) !== false,
        sitemaps: robots.getSitemaps(),
      };
    } catch {
      return { isAllowed: () => true, sitemaps: [] };
    }
  });
