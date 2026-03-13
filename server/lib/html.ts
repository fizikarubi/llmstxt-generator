/**
 * HTML parsing and text extraction — pure functions, no network I/O.
 *
 * Assumptions: content lives in `<main>`/`<article>` (fall back to `<body>`),
 * pages with < 100 visible chars are SPA shells, descriptions are truncated
 * at 250 chars on a word boundary.
 */
import * as cheerio from 'cheerio';
import type { SiteInfo } from '@/shared/types';

// ─── Extraction ──────────────────────────────────────────────────────────────

const DESCRIPTION_MAX_CHARS = 250;

/** Normalize whitespace and truncate at a word boundary. */
const cleanDescription = (raw: string): string => {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= DESCRIPTION_MAX_CHARS) return trimmed;
  const lastSpace = trimmed.lastIndexOf(' ', DESCRIPTION_MAX_CHARS);
  const breakpoint = lastSpace > 0 ? lastSpace : DESCRIPTION_MAX_CHARS;
  return trimmed.slice(0, breakpoint) + '…';
};

/**
 * Description cascade (most authoritative first):
 *   1. meta[name="description"] — author-curated, most reliable summary
 *   2. og:description            — social-sharing fallback, usually equivalent
 *   3. First <p> in main/article — last resort when meta tags are absent
 */
const extractDescriptionFromDom = ($: cheerio.CheerioAPI): string => {
  const raw =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('main p, article p').first().text().trim();
  return raw ? cleanDescription(raw) : '';
};

/**
 * Extract site-level metadata from the homepage HTML. Called once per run.
 *
 * Name priority (most specific to least):
 *   1. og:site_name — explicitly set by the author as the site's brand name
 *   2. <title>      — usually includes the site name, may have page-specific suffixes
 *   3. <h1>         — often the page heading, not always the site name
 *   4. hostname     — bare-minimum fallback when the page has no semantic markup
 */
const extractSiteInfo = (html: string, url: URL): SiteInfo => {
  const $ = cheerio.load(html);

  const titleTag = $('title').first().text().trim();
  const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim();
  const h1 = $('h1').first().text().trim();

  const name = ogSiteName || titleTag || h1 || url.hostname;
  const description = extractDescriptionFromDom($);

  return { name, description };
};

/**
 * Strip non-content elements and return visible text from the main content area.
 *
 * Removed tags and why:
 *   script/style/noscript — code & styling, never user-visible prose
 *   nav/footer/aside      — site-wide chrome, duplicated across every page
 *   iframe                — embedded third-party content, not the page's own text
 *   form                  — input fields & labels, not article content
 *   [role="complementary"]— ARIA sidebars (ads, related links)
 *   [role="banner"]       — site-wide header banner, not page content
 *   [aria-hidden="true"]  — explicitly hidden from assistive tech, skip it
 *   body > header / sibling headers — site-level headers outside <main>, not article content
 *
 * Content strategy: prefer <main>/<article>/[role="main"]; fall back to <body>
 * only when none of those landmarks exist.
 */
const extractText = (html: string): string => {
  const $ = cheerio.load(html);
  $(
    'script, style, nav, footer, iframe, noscript, aside, form, [role="complementary"], [role="banner"], [aria-hidden="true"]',
  ).remove();
  $('body > header, [role="main"] ~ header').remove();
  const main = $('main, article, [role="main"]');
  const target = main.length ? main : $('body');
  return target.text().replace(/\s+/g, ' ').trim();
};

const MIN_VISIBLE_TEXT_LENGTH = 100;

/** True if the page has too little visible text < 100 (likely a JS-only SPA shell). */
const isSpaShell = (html: string): boolean =>
  extractText(html).length < MIN_VISIBLE_TEXT_LENGTH;

/** Extract the meta description from raw HTML. */
const extractDescription = (html: string): string => {
  const $ = cheerio.load(html);
  return extractDescriptionFromDom($);
};

export const html = { extractSiteInfo, extractText, isSpaShell, extractDescription };
