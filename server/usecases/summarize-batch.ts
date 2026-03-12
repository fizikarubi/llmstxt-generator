import type { UseCase } from '@/server/lib/usecase';
import type {
  SummarizeBatchRequest,
  SummarizeBatchResponse,
  PageInfo,
} from '@/shared/types';
import { AppError, getErrorMessage, getErrorStatus } from '@/server/lib/errors';
import {
  fetchHtml,
  extractText,
  extractDescription,
  isSpaShell,
} from '@/server/lib/scraping/html';
import { probeMdUrl } from '@/server/lib/scraping/probe-md';
import { createClient, summarizePageBatch } from '@/server/lib/llm';

export const summarizeBatchUseCase: UseCase<
  SummarizeBatchRequest,
  SummarizeBatchResponse
> = {
  run: async (ctx, input) => {
    if (!input.urls?.length || !input.apiKey || !input.site) {
      throw new AppError('urls, apiKey, and site are required', 400);
    }

    // Fetch all pages in parallel
    const fetchResults = await Promise.allSettled(
      input.urls.map(async (url) => {
        const [result, mdUrl] = await Promise.all([fetchHtml(ctx, url), probeMdUrl(url)]);

        if (isSpaShell(result.html)) {
          throw new AppError('Page appears to be a JavaScript app shell', 422);
        }

        const text = extractText(result.html);
        const pageInfo: PageInfo = {
          pageUrl: result.url,
          mdUrl,
          description: extractDescription(result.html),
        };
        return { pageInfo, textContent: text };
      }),
    );

    const pages: { pageInfo: PageInfo; textContent: string }[] = [];
    const failures: { url: string; error: string }[] = [];

    for (let i = 0; i < fetchResults.length; i++) {
      const r = fetchResults[i];
      if (r.status === 'fulfilled') {
        pages.push(r.value);
      } else {
        failures.push({ url: input.urls[i], error: getErrorMessage(r.reason) });
      }
    }

    if (pages.length === 0) {
      return { results: [], failures };
    }

    const client = createClient(input.apiKey);

    let results;
    try {
      results = await summarizePageBatch(ctx, client, pages, input.site);
    } catch (err) {
      throw new AppError(`LLM: ${getErrorMessage(err)}`, getErrorStatus(err));
    }

    ctx.logger.info(
      {
        requested: input.urls.length,
        summarized: results.length,
        failed: failures.length,
      },
      'batch summarized',
    );

    return { results, failures };
  },
};
