import * as cheerio from 'cheerio';
import retry from 'async-retry';
import type { SiteInfo } from '@/shared/types';
import { AppError } from '@/server/lib/errors';
import { withTrace } from '@/server/lib/logger';
import { Context } from '@/server/lib/context';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './consts';

// ─── Fetching ────────────────────────────────────────────────────────────────

export interface FetchResult {
  url: string;
  html: string;
}

/** Read the response body with a separate timeout (the fetch signal only covers headers). */
const readBodyWithTimeout = async (res: Response, ms: number): Promise<string> => {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new AppError('Body read timed out', 408)), ms);
  });

  try {
    return await Promise.race([res.text(), timeoutPromise]);
  } finally {
    // Prevent memory leaks by clearing the timer once the race is over
    clearTimeout(timeoutId!);
  }
};
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
 *
 * Retries once on transient failures (5xx, timeouts, network errors).
 */
export const fetchHtml = (ctx: Context, url: string): Promise<FetchResult> =>
  withTrace(ctx, 'fetchHtml', { url }, () =>
    retry(
      async (bail) => {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'follow',
        });

        if (!res.ok) {
          const err = new AppError(`Fetching ${url} returned ${res.status}`, res.status);
          // Only retry on 5xx — 4xx errors are permanent
          if (res.status < 500) bail(err);
          throw err;
        }

        const finalOrigin = new URL(res.url).origin;
        const inputOrigin = new URL(url).origin;
        if (finalOrigin !== inputOrigin) {
          bail(new AppError(`URL redirected to a different site: ${finalOrigin}`, 400));
          throw new Error('unreachable'); // bail() throws but TS doesn't know
        }

        const contentType = res.headers.get('content-type') ?? '';

        if (!contentType.includes('text/html')) {
          bail(new AppError(`Non-HTML content type: ${contentType}`, 400));
          throw new Error('unreachable');
        }

        const html = await readBodyWithTimeout(res, FETCH_TIMEOUT_MS);
        return { url: res.url, html };
      },
      { retries: 1, minTimeout: 500 },
    ),
  );

// ─── Extraction ──────────────────────────────────────────────────────────────

const SEPARATORS = [' | ', ' - ', ' – ', ' · ', ' • '];
const DESCRIPTION_MAX_CHARS = 250;

const cleanDescription = (raw: string): string => {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= DESCRIPTION_MAX_CHARS) return trimmed;
  const cutoff = trimmed.slice(0, DESCRIPTION_MAX_CHARS);
  const lastDot = cutoff.lastIndexOf('.');
  return lastDot > 100 ? trimmed.slice(0, lastDot + 1) : cutoff.trimEnd() + '…';
};

/**
 * Extract the site name from a <title> tag by taking the part *before* the
 * first separator. e.g. "Next.js | The React Framework" → "Next.js"
 */
const extractSiteName = (raw: string): string => {
  for (const sep of SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx > 0) return raw.slice(0, idx).trim();
  }
  return raw;
};

const extractDescriptionFromDom = ($: cheerio.CheerioAPI): string => {
  const raw =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('main p, article p').first().text().trim();
  return raw ? cleanDescription(raw) : '';
};

/**
 * Extract site-level metadata from the homepage HTML. Called once per run.
 */
export const extractSiteInfo = (html: string, url: URL): SiteInfo => {
  const $ = cheerio.load(html);

  const titleTag = $('title').first().text().trim();
  const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim();
  const h1 = $('h1').first().text().trim();

  const name = ogSiteName || extractSiteName(titleTag) || h1 || url.hostname;
  const description = extractDescriptionFromDom($);

  return { name, description };
};

/**
 * Strip non-content elements and return the visible text of the main content area.
 */
export const extractText = (html: string): string => {
  const $ = cheerio.load(html);
  $(
    'script, style, nav, footer, iframe, noscript, aside, form, [role="complementary"], [role="banner"], [aria-hidden="true"]',
  ).remove();
  // Remove top-level page headers but preserve <header> inside <article>/<main>
  // which often contains the article title, date, and author info.
  $('body > header, [role="main"] ~ header').remove();
  const main = $('main, article, [role="main"]');
  const target = main.length ? main : $('body');
  return target.text().replace(/\s+/g, ' ').trim();
};

const MIN_VISIBLE_TEXT_LENGTH = 100;

/**
 * Returns true if the HTML has too little visible text to be a server-rendered
 * page (likely a JS-only SPA shell or empty page).
 */
export const isSpaShell = (html: string): boolean =>
  extractText(html).length < MIN_VISIBLE_TEXT_LENGTH;

/**
 * Extract the meta description from raw HTML.
 */
export const extractDescription = (html: string): string => {
  const $ = cheerio.load(html);
  return extractDescriptionFromDom($);
};
