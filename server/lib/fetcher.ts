/**
 * HTTP fetching, robots.txt parsing, and .md URL probing.
 *
 * - **Cross-origin redirects are rejected**: if a fetch follows a redirect
 *   to a different origin we bail rather than silently fetching from a different
 *   site. This prevents scope creep (e.g. login redirects, CDN domains)
 *   but means sites that legitimately redirect across origins need the
 *   final URL as input.
 *
 * - **robots.txt failure = allow-all**: per the spec a missing robots.txt
 *   means no restrictions. We extend this to network errors and 5xx — blocking
 *   the entire run for a transient server error is overly conservative.
 *
 * - **.md probing uses HEAD requests**: the llms.txt spec says sites should
 *   serve markdown at `<url>.md`. We probe with HEAD to avoid downloading
 *   large files. Two candidates are tried: `<url>.md` and
 *   `<url>/index.html.md` (for extensionless paths).
 */
import robotsParser from 'robots-parser';
import { AppError } from '@/server/lib/errors';
import { withTrace } from '@/server/lib/logger';
import { Context } from '@/server/lib/context';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './consts';

interface FetchResult {
  url: string;
  html: string;
}
/**
 * Fetch a single page, following redirects, and return the final URL + HTML.
 *
 * The returned `url` is the post-redirect location.
 * Rejects non-HTML responses and cross-origin redirects.
 */
const fetchHtml = (ctx: Context, url: string): Promise<FetchResult> =>
  withTrace(ctx, 'fetchHtml', { url }, async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new AppError(`Fetching ${url} returned ${res.status}`, res.status);
    }

    if (new URL(res.url).origin !== new URL(url).origin) {
      throw new AppError(
        `URL redirected to a different site: ${new URL(res.url).origin}`,
        400,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      throw new AppError(`Non-HTML content type: ${contentType}`, 400);
    }

    return { url: res.url, html: await res.text() };
  });

/**
 * Probe whether a `.md` version of a page exists.
 *
 * Per the llms.txt spec, sites should provide clean markdown versions of pages
 * at the same URL with `.md` appended. For URLs without a file extension
 * (e.g. `/docs/api`), we also try `index.html.md` as a fallback.
 *
 * Uses HEAD requests to avoid downloading full content.
 * Returns the first `.md` URL that responds with 200, or null.
 */
const probeMarkdownUrls = async (url: string): Promise<string | null> => {
  const candidates: string[] = [];

  const parsed = new URL(url);
  const path = parsed.pathname;

  const hasExtension = /\.[a-z]+$/i.test(path.split('/').pop() ?? '');

  candidates.push(url.replace(/\/$/, '') + '.md');

  if (!hasExtension) {
    const base = url.replace(/\/$/, '');
    candidates.push(base + '/index.html.md');
  }

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (res.ok) return candidate;
    } catch {
      // timeout or network error — try next candidate
    }
  }

  return null;
};

/** Thin wrapper so the rest of the pipeline doesn't depend on robots-parser internals. */
interface RobotsChecker {
  isAllowed: (url: string) => boolean;
  /** Sitemap URLs declared via `Sitemap:` directives in robots.txt. */
  sitemaps: string[];
}

/**
 * Fetch and parse the site's robots.txt, returning a checker the pipeline uses
 * to filter out disallowed URLs before fetching them.
 *
 * Graceful degradation:
 * - If the fetch fails (network error, timeout) or returns a non-200, we
 *   default to allow-all. Per the robots.txt spec, a missing file means no
 *   restrictions. A 5xx may indicate a temporary issue, but blocking the
 *   entire run for a transient server error would be overly conservative.
 * - `robots.isAllowed()` returns `true | false | undefined`; we treat
 *   `undefined` (no matching rule) as allowed via the `!== false` check.
 */
const fetchRobots = (ctx: Context, entryUrl: URL): Promise<RobotsChecker> =>
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

export const fetcher = { fetchHtml, probeMarkdownUrls, fetchRobots };
