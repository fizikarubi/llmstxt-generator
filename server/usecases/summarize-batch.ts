import type { UseCase } from '@/server/lib/usecase';
import type {
  SummarizeBatchRequest,
  SummarizeBatchResponse,
  PageInfo,
} from '@/shared/types';
import { AppError, getErrorMessage, getErrorStatus } from '@/server/lib/errors';
import { fetcher } from '@/server/lib/fetcher';
import { html } from '@/server/lib/html';
import { withTrace } from '@/server/lib/logger';
import { anthropic } from '@/server/lib/anthropic';
import Anthropic from '@anthropic-ai/sdk';
import PQueue from 'p-queue';

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

        const limiter = new PQueue({ concurrency: 3 });
        // 1. Fetch all pages in parallel
        const fetchResults = await Promise.allSettled(
          input.urls.map((url) =>
            limiter.add(async () => {
              const [result, mdUrl] = await Promise.all([
                fetcher.fetchHtml(ctx, url),
                fetcher.probeMarkdownUrls(url),
              ]);

              if (html.isSpaShell(result.html)) {
                throw new AppError('Page appears to be a JavaScript app shell', 422);
              }

              const textContent = html.extractText(result.html);
              const pageInfo: PageInfo = {
                pageUrl: result.url,
                mdUrl,
                description: html.extractDescription(result.html),
              };
              return { pageInfo, textContent };
            }),
          ),
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
          return { summaries: [], failures };
        }

        // 2. summarize the page using llm
        const client = new Anthropic({
          apiKey: input.apiKey,
          maxRetries: 2,
          timeout: 60_000,
        });
        let summaries;
        try {
          summaries = await anthropic.summarizePages(ctx, client, pages, input.site);
        } catch (err) {
          throw new AppError(`Anthropic: ${getErrorMessage(err)}`, getErrorStatus(err));
        }

        return { summaries, failures };
      },
    ),
};
