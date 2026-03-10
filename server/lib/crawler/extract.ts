import * as cheerio from 'cheerio';
import type { SiteInfo } from '@/shared/types';

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
 * Extract site-level metadata from the homepage HTML. Called once per crawl.
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
