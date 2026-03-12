import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from '@/server/lib/context';
import { discoverUrls } from '../discovery';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeCtx = () =>
  ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  }) as unknown as Context;

const sitemapXml = (...urls: string[]) => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls.map((u) => `<url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;

const sitemapIndexXml = (...sitemapUrls: string[]) => `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${sitemapUrls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

const htmlPage = (links: string[] = []) =>
  `<html><head></head><body>
    <p>${'Content '.repeat(20)}</p>
    ${links.map((l) => `<a href="${l}">Link</a>`).join('\n')}
  </body></html>`;

const textHtmlHeaders = { 'Content-Type': 'text/html' };

describe('discoverUrls', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Sitemap discovery ──────────────────────────────────────────────────

  it('discovers URLs from sitemap.xml', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml('https://example.com/docs', 'https://example.com/guide'),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.method).toBe('sitemap');
    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).toContain('https://example.com/guide');
  });

  it('follows sitemap index to child sitemaps', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/sitemap.xml') {
        return new Response(sitemapIndexXml('https://example.com/sitemap-docs.xml'), {
          status: 200,
        });
      }
      if (url === 'https://example.com/sitemap-docs.xml') {
        return new Response(
          sitemapXml('https://example.com/docs/intro', 'https://example.com/docs/api'),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.method).toBe('sitemap');
    expect(result.urls).toContain('https://example.com/docs/intro');
    expect(result.urls).toContain('https://example.com/docs/api');
  });

  it('uses robots.txt sitemaps when provided', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/custom-sitemap.xml') {
        return new Response(sitemapXml('https://example.com/page1'), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, [
      'https://example.com/custom-sitemap.xml',
    ]);

    expect(result.method).toBe('sitemap');
    expect(result.urls).toContain('https://example.com/page1');
  });

  it('filters out excluded paths from sitemap', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml(
            'https://example.com/docs',
            'https://example.com/login',
            'https://example.com/signup',
            'https://example.com/account/settings',
            'https://example.com/auth/callback',
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).not.toContain('https://example.com/login');
    expect(result.urls).not.toContain('https://example.com/signup');
    expect(result.urls).not.toContain('https://example.com/account/settings');
    expect(result.urls).not.toContain('https://example.com/auth/callback');
  });

  it('filters out non-HTML extensions from sitemap', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml(
            'https://example.com/docs',
            'https://example.com/file.pdf',
            'https://example.com/image.jpg',
            'https://example.com/photo.png',
            'https://example.com/data.xml',
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).not.toContain('https://example.com/file.pdf');
    expect(result.urls).not.toContain('https://example.com/image.jpg');
    expect(result.urls).not.toContain('https://example.com/photo.png');
  });

  it('caps sitemap results at 3x maxPages', async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `https://example.com/p${i}`);
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(sitemapXml(...urls), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), 10, []);

    expect(result.urls.length).toBeLessThanOrEqual(30);
  });

  it('filters out cross-origin sitemap URLs', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml('https://example.com/docs', 'https://other-site.com/page'),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).not.toContain('https://other-site.com/page');
  });

  it('treats www and non-www as same origin', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml('https://www.example.com/docs', 'https://example.com/guide'),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.urls).toContain('https://www.example.com/docs');
    expect(result.urls).toContain('https://example.com/guide');
  });

  // ── BFS fallback ──────────────────────────────────────────────────────

  it('falls back to BFS when sitemap is not available', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response('Not found', { status: 404 });
      }
      if (url === 'https://example.com/') {
        return new Response(htmlPage(['/docs', '/guide']), {
          status: 200,
          headers: textHtmlHeaders,
        });
      }
      if (url === 'https://example.com/docs' || url === 'https://example.com/guide') {
        return new Response(htmlPage(), { status: 200, headers: textHtmlHeaders });
      }
      return new Response('Not found', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com/'), null, []);

    expect(result.method).toBe('bfs');
    expect(result.urls.length).toBeGreaterThan(0);
  });

  it('respects path prefix scope during BFS', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response('Not found', { status: 404 });
      }
      if (url === 'https://example.com/docs') {
        return new Response(htmlPage(['/docs/intro', '/docs/api', '/blog/post']), {
          status: 200,
          headers: textHtmlHeaders,
        });
      }
      if (url.startsWith('https://example.com/docs/')) {
        return new Response(htmlPage(), { status: 200, headers: textHtmlHeaders });
      }
      return new Response('Not found', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com/docs'), null, []);

    expect(result.method).toBe('bfs');
    // /blog/post should be excluded (outside /docs scope)
    for (const url of result.urls) {
      expect(url).toMatch(/\/docs/);
    }
  });

  it('filters paginated URLs', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml(
            'https://example.com/docs',
            'https://example.com/list?page=2',
            'https://example.com/list?page=3',
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com'), null, []);

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).not.toContain('https://example.com/list?page=2');
  });

  // ── Locale dedup ──────────────────────────────────────────────────────

  it('filters out non-matching locale pages when entry has a locale', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response(
          sitemapXml(
            'https://example.com/en/docs',
            'https://example.com/en/docs/intro',
            'https://example.com/fr/docs',
            'https://example.com/fr/docs/intro',
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(
      ctx,
      new URL('https://example.com/en/docs'),
      null,
      [],
    );

    // Should keep /en/docs URLs (matching locale + path prefix)
    expect(result.urls).toContain('https://example.com/en/docs');
    expect(result.urls).toContain('https://example.com/en/docs/intro');
    // Should reject /fr/docs URLs (different locale)
    expect(result.urls).not.toContain('https://example.com/fr/docs');
    expect(result.urls).not.toContain('https://example.com/fr/docs/intro');
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('returns empty arrays when both sitemap and BFS find nothing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response('Not found', { status: 404 });
    });

    const ctx = makeCtx();
    const result = await discoverUrls(ctx, new URL('https://example.com/'), null, []);

    expect(result.method).toBe('bfs');
    expect(result.urls).toEqual([]);
  });

  it('handles malformed sitemap XML gracefully', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap.xml')) {
        return new Response('<<<invalid xml>>>', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const ctx = makeCtx();
    // Should not throw — falls back to BFS
    const result = await discoverUrls(ctx, new URL('https://example.com/'), null, []);
    expect(result.method).toBe('bfs');
  });
});
