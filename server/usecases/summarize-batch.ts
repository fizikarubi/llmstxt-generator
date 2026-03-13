import type { UseCase } from '@/server/lib/usecase';
import type {
  SummarizeBatchRequest,
  SummarizeBatchResponse,
  PageInfo,
} from '@/shared/types';
import { AppError, getErrorMessage } from '@/server/lib/errors';
import { fetcher } from '@/server/lib/fetcher';
import { html } from '@/server/lib/html';
import { withTrace } from '@/server/lib/logger';
import { anthropic } from '@/server/lib/anthropic';
import Anthropic from '@anthropic-ai/sdk';

/** Fetch a batch of pages and summarize them in a single LLM call.
 *  Returns partial results — individual fetch failures don't block the batch. */
export const summarizeBatchUseCase: UseCase<
  SummarizeBatchRequest,
  SummarizeBatchResponse
> = {
  run: (ctx, input) =>
    withTrace(
      ctx,
      'summarizeBatchUseCase',
      { urlCount: input.urls?.length },
      async () => {
        if (!input.urls?.length || !input.apiKey || !input.site) {
          throw new AppError('urls, apiKey, and site are required', 400);
        }

        // 1. Fetch all pages in parallel
        const fetchT0 = Date.now();
        const fetchResults = await Promise.allSettled(
          input.urls.map(async (url) => {
            const [result, mdUrl] = await Promise.all([
              fetcher.fetchHtml(ctx, url),
              fetcher.probeMarkdownUrls(url),
            ]);

            if (html.isSpaShell(result.html)) {
              throw new AppError('Page appears to be a JavaScript app shell', 422);
            }

            const text = html.extractText(result.html);
            const pageInfo: PageInfo = {
              pageUrl: result.url,
              mdUrl,
              description: html.extractDescription(result.html),
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

        ctx.logger.info(
          { fetched: pages.length, failed: failures.length, fetchElapsedMs: Date.now() - fetchT0 },
          'summarizeBatch: page fetches complete',
        );

        if (pages.length === 0) {
          return { summaries: [], failures };
        }

        // 2. summarize the page using llm
        const llmT0 = Date.now();
        const client = new Anthropic({ apiKey: input.apiKey, maxRetries: 2, timeout: 60_000 });
        let summaries;
        try {
          summaries = await anthropic.summarizePages(ctx, client, pages, input.site);
        } catch (err) {
          ctx.logger.error({ err: getErrorMessage(err), llmElapsedMs: Date.now() - llmT0 }, 'summarizeBatch: LLM call failed');
          // LLM failed — return fetch failures + mark all fetched pages as failed too
          for (const p of pages) {
            failures.push({ url: p.pageInfo.pageUrl, error: `Anthropic: ${getErrorMessage(err)}` });
          }
          return { summaries: [], failures };
        }

        return { summaries, failures };
      },
    ),
};
