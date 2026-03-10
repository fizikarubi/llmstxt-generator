import { USER_AGENT, CRAWL_TIMEOUT_MS } from './consts';

/**
 * Probe whether a `.md` version of a page exists.
 *
 * Per the llms.txt spec, sites should provide clean markdown versions of pages
 * at the same URL with `.md` appended. For URLs without a file extension
 * (e.g. `/docs/api`), we also try `index.html.md` as recommended by the spec.
 *
 * Uses HEAD requests with a short timeout to avoid slowing down the pipeline.
 * Returns the `.md` URL if one responds with 200, otherwise null.
 */
export const probeMdUrl = async (url: string): Promise<string | null> => {
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
        signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (res.ok) return candidate;
    } catch {
      // timeout or network error — try next candidate
    }
  }

  return null;
};
