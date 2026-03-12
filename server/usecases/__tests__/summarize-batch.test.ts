import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from '@/server/lib/context';
import { summarizeBatchUseCase } from '../summarize-batch';

vi.mock('@/server/lib/scraping/html', () => ({
  fetchHtml: vi.fn(),
  extractText: vi.fn(),
  extractDescription: vi.fn(),
  isSpaShell: vi.fn(),
}));

vi.mock('@/server/lib/scraping/probe-md', () => ({
  probeMdUrl: vi.fn(),
}));

vi.mock('@/server/lib/llm', () => ({
  createClient: vi.fn().mockReturnValue({}),
  summarizePageBatch: vi.fn(),
}));

import {
  fetchHtml,
  extractText,
  extractDescription,
  isSpaShell,
} from '@/server/lib/scraping/html';
import { probeMdUrl } from '@/server/lib/scraping/probe-md';
import { summarizePageBatch } from '@/server/lib/llm';

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

describe('summarizeBatchUseCase', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('throws 400 when urls is empty', async () => {
    const ctx = makeCtx();
    await expect(
      summarizeBatchUseCase.run(ctx, {
        urls: [],
        apiKey: 'sk-test',
        site: { name: 'Example', description: '' },
      }),
    ).rejects.toThrow('urls, apiKey, and site are required');
  });

  it('throws 400 when apiKey is missing', async () => {
    const ctx = makeCtx();
    await expect(
      summarizeBatchUseCase.run(ctx, {
        urls: ['https://example.com/page'],
        apiKey: '',
        site: { name: 'Example', description: '' },
      }),
    ).rejects.toThrow('urls, apiKey, and site are required');
  });

  it('returns summarized pages on success', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/docs',
      html: '<html><body><p>Doc content</p></body></html>',
    });
    vi.mocked(probeMdUrl).mockResolvedValue(null);
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractText).mockReturnValue('Doc content');
    vi.mocked(extractDescription).mockReturnValue('A doc page');
    vi.mocked(summarizePageBatch).mockResolvedValue([
      {
        meta: {
          pageUrl: 'https://example.com/docs',
          mdUrl: null,
          description: 'A doc page',
        },
        title: 'Documentation',
        summary: 'The documentation page.',
        isSupplementary: false,
      },
    ]);

    const ctx = makeCtx();
    const result = await summarizeBatchUseCase.run(ctx, {
      urls: ['https://example.com/docs'],
      apiKey: 'sk-test',
      site: { name: 'Example', description: '' },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Documentation');
    expect(result.failures).toHaveLength(0);
  });

  it('records per-page fetch failures and continues with remaining pages', async () => {
    vi.mocked(fetchHtml).mockImplementation(async (_ctx, url: string) => {
      if (url.includes('broken')) throw new Error('Connection refused');
      return { url, html: '<html><body><p>Content</p></body></html>' };
    });
    vi.mocked(probeMdUrl).mockResolvedValue(null);
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractText).mockReturnValue('Content');
    vi.mocked(extractDescription).mockReturnValue('');
    vi.mocked(summarizePageBatch).mockResolvedValue([
      {
        meta: { pageUrl: 'https://example.com/good', mdUrl: null, description: '' },
        title: 'Good Page',
        summary: 'Works fine.',
        isSupplementary: false,
      },
    ]);

    const ctx = makeCtx();
    const result = await summarizeBatchUseCase.run(ctx, {
      urls: ['https://example.com/good', 'https://example.com/broken'],
      apiKey: 'sk-test',
      site: { name: 'Example', description: '' },
    });

    expect(result.results).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].url).toBe('https://example.com/broken');
    expect(result.failures[0].error).toContain('Connection refused');
  });

  it('returns empty results when all pages fail to fetch', async () => {
    vi.mocked(fetchHtml).mockRejectedValue(new Error('Network error'));
    vi.mocked(probeMdUrl).mockResolvedValue(null);

    const ctx = makeCtx();
    const result = await summarizeBatchUseCase.run(ctx, {
      urls: ['https://example.com/a', 'https://example.com/b'],
      apiKey: 'sk-test',
      site: { name: 'Example', description: '' },
    });

    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
    // summarizePageBatch should not be called when no pages succeed
    expect(summarizePageBatch).not.toHaveBeenCalled();
  });

  it('marks SPA shell pages as failures', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/spa',
      html: '<div id="root"></div>',
    });
    vi.mocked(probeMdUrl).mockResolvedValue(null);
    vi.mocked(isSpaShell).mockReturnValue(true);

    const ctx = makeCtx();
    const result = await summarizeBatchUseCase.run(ctx, {
      urls: ['https://example.com/spa'],
      apiKey: 'sk-test',
      site: { name: 'Example', description: '' },
    });

    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('JavaScript app shell');
  });

  it('includes mdUrl when probe finds a .md version', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/docs',
      html: '<html><body><p>Content</p></body></html>',
    });
    vi.mocked(probeMdUrl).mockResolvedValue('https://example.com/docs.md');
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractText).mockReturnValue('Content');
    vi.mocked(extractDescription).mockReturnValue('');
    vi.mocked(summarizePageBatch).mockImplementation(async (_ctx, _client, pages) => {
      return pages.map((p) => ({
        meta: p.pageInfo,
        title: 'Docs',
        summary: 'Doc page.',
        isSupplementary: false,
      }));
    });

    const ctx = makeCtx();
    const result = await summarizeBatchUseCase.run(ctx, {
      urls: ['https://example.com/docs'],
      apiKey: 'sk-test',
      site: { name: 'Example', description: '' },
    });

    expect(result.results[0].meta.mdUrl).toBe('https://example.com/docs.md');
  });

  it('wraps LLM errors in AppError', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({
      url: 'https://example.com/docs',
      html: '<html><body><p>Content</p></body></html>',
    });
    vi.mocked(probeMdUrl).mockResolvedValue(null);
    vi.mocked(isSpaShell).mockReturnValue(false);
    vi.mocked(extractText).mockReturnValue('Content');
    vi.mocked(extractDescription).mockReturnValue('');
    vi.mocked(summarizePageBatch).mockRejectedValue(new Error('Rate limit exceeded'));

    const ctx = makeCtx();
    await expect(
      summarizeBatchUseCase.run(ctx, {
        urls: ['https://example.com/docs'],
        apiKey: 'sk-test',
        site: { name: 'Example', description: '' },
      }),
    ).rejects.toThrow('LLM: Rate limit exceeded');
  });
});
