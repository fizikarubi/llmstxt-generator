import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from '@/server/lib/context';
import { discoverUseCase } from '../discover';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/server/lib/scraping/robots', () => ({
  fetchRobots: vi.fn(),
}));

vi.mock('@/server/lib/scraping/discovery', () => ({
  discoverUrls: vi.fn(),
}));

vi.mock('@/server/lib/scraping/html', () => ({
  fetchHtml: vi.fn(),
  extractSiteInfo: vi.fn(),
  isSpaShell: vi.fn(),
}));

import { fetchRobots } from '@/server/lib/scraping/robots';
import { discoverUrls } from '@/server/lib/scraping/discovery';
import { fetchHtml } from '@/server/lib/scraping/html';
import { extractSiteInfo, isSpaShell } from '@/server/lib/scraping/html';

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

const robotsAllowAll = {
  isAllowed: () => true,
  sitemaps: [],
};

const robotsDisallowAll = {
  isAllowed: () => false,
  sitemaps: [],
};

describe('discoverUseCase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns discovered URLs and site info on success', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body><p>Content here that is long enough to pass the SPA check for sure definitely</p></body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({
      name: 'Example',
      description: 'A site',
    });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: ['https://example.com/docs', 'https://example.com/guide'],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, { url: 'https://example.com' });

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.site.name).toBe('Example');
    expect(result.method).toBe('sitemap');
  });

  it('throws 400 for invalid URL', async () => {
    const ctx = makeCtx();
    await expect(discoverUseCase.run(ctx, { url: 'not-a-url' })).rejects.toThrow(
      'Invalid URL',
    );
  });

  it('throws 403 when robots.txt disallows crawling', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsDisallowAll);

    const ctx = makeCtx();
    await expect(
      discoverUseCase.run(ctx, { url: 'https://example.com' }),
    ).rejects.toThrow('robots.txt disallows');
  });

  it('throws 422 when homepage is an SPA shell', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<div id="root"></div>',
    });
    vi.mocked(isSpaShell).mockReturnValue(true);

    const ctx = makeCtx();
    await expect(
      discoverUseCase.run(ctx, { url: 'https://example.com' }),
    ).rejects.toThrow('JavaScript app');
  });

  it('throws 404 when no pages are discovered', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body>Content</body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Example', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({ urls: [], method: 'bfs' });

    const ctx = makeCtx();
    await expect(
      discoverUseCase.run(ctx, { url: 'https://example.com' }),
    ).rejects.toThrow('No pages found');
  });

  it('deduplicates discovered URLs', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body>Content</body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Example', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: [
        'https://example.com/docs',
        'https://example.com/docs', // duplicate
        'https://example.com/guide',
      ],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, { url: 'https://example.com' });

    expect(result.urls).toEqual([
      'https://example.com/docs',
      'https://example.com/guide',
    ]);
  });

  it('excludes the entry URL from results', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body>Content</body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Example', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: ['https://example.com/', 'https://example.com/docs'],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, { url: 'https://example.com/' });

    expect(result.urls).not.toContain('https://example.com/');
    expect(result.urls).toContain('https://example.com/docs');
  });

  it('respects maxPages limit', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body>Content</body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Example', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: Array.from({ length: 50 }, (_, i) => `https://example.com/p${i}`),
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, {
      url: 'https://example.com',
      maxPages: 5,
    });

    expect(result.urls.length).toBe(5);
  });

  it('filters out URLs disallowed by robots.txt', async () => {
    vi.mocked(fetchRobots).mockResolvedValue({
      isAllowed: (url: string) => !url.includes('/private'),
      sitemaps: [],
    });
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/',
      html: '<html><body>Content</body></html>',
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Example', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: ['https://example.com/docs', 'https://example.com/private/secret'],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, { url: 'https://example.com' });

    expect(result.urls).toContain('https://example.com/docs');
    expect(result.urls).not.toContain('https://example.com/private/secret');
  });

  it('fetches root page for site info when entry is a subpath', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    vi.mocked(fetchHtml).mockImplementation(async (_ctx, url: string) => {
      return { url, html: '<html><body>Content for site info</body></html>' };
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Root Site', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: ['https://example.com/docs/intro'],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    await discoverUseCase.run(ctx, { url: 'https://example.com/docs' });

    // fetchHtml should be called twice: once for entry, once for root
    expect(vi.mocked(fetchHtml)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchHtml)).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.com/',
    );
  });

  it('falls back to entry HTML for site info when root fetch fails', async () => {
    vi.mocked(fetchRobots).mockResolvedValue(robotsAllowAll);
    let callNum = 0;
    vi.mocked(fetchHtml).mockImplementation(async (_ctx, url: string) => {
      callNum++;
      if (callNum === 2) throw new Error('Root fetch failed');
      return { url, html: '<html><body>Content</body></html>' };
    });
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractSiteInfo).mockReturnValue({ name: 'Entry Site', description: '' });
    vi.mocked(discoverUrls).mockResolvedValue({
      urls: ['https://example.com/docs/intro'],
      method: 'sitemap',
    });

    const ctx = makeCtx();
    const result = await discoverUseCase.run(ctx, { url: 'https://example.com/docs' });

    // Should still succeed using entry page HTML
    expect(result.site.name).toBe('Entry Site');
  });
});
