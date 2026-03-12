import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from '@/server/lib/context';
import { assembleUseCase } from '../assemble';

vi.mock('@/server/lib/llm', () => ({
  createClient: vi.fn().mockReturnValue({}),
  assembleWithLlm: vi.fn(),
}));

import { assembleWithLlm } from '@/server/lib/llm';

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

const makePage = (n: number) => ({
  meta: { pageUrl: `https://example.com/p${n}`, mdUrl: null, description: '' },
  title: `Page ${n}`,
  summary: `Summary ${n}`,
  isSupplementary: false,
});

describe('assembleUseCase', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns assembled llms.txt on success', async () => {
    vi.mocked(assembleWithLlm).mockResolvedValue('# Example\n> A great site');

    const ctx = makeCtx();
    const result = await assembleUseCase.run(ctx, {
      pages: [makePage(1), makePage(2)],
      entryUrl: 'https://example.com',
      site: { name: 'Example', description: 'A great site' },
      apiKey: 'sk-test',
    });

    expect(result.llmsTxt).toBe('# Example\n> A great site');
  });

  it('throws 400 when pages is empty', async () => {
    const ctx = makeCtx();
    await expect(
      assembleUseCase.run(ctx, {
        pages: [],
        entryUrl: 'https://example.com',
        site: { name: 'Example', description: '' },
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow('pages, entryUrl, site, and apiKey are required');
  });

  it('throws 400 when entryUrl is missing', async () => {
    const ctx = makeCtx();
    await expect(
      assembleUseCase.run(ctx, {
        pages: [makePage(1)],
        entryUrl: '',
        site: { name: 'Example', description: '' },
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow('pages, entryUrl, site, and apiKey are required');
  });

  it('throws 400 when apiKey is missing', async () => {
    const ctx = makeCtx();
    await expect(
      assembleUseCase.run(ctx, {
        pages: [makePage(1)],
        entryUrl: 'https://example.com',
        site: { name: 'Example', description: '' },
        apiKey: '',
      }),
    ).rejects.toThrow('pages, entryUrl, site, and apiKey are required');
  });
});
