import type { UseCase } from '@/server/lib/usecase';
import type { SummarizeRequest, SummarizeResponse, PageInfo } from '@/shared/types';
import { AppError, getErrorMessage } from '@/server/lib/errors';
import { fetchPage } from '@/server/lib/crawler/fetcher';
import {
  extractText,
  extractDescription,
  isSpaShell,
} from '@/server/lib/crawler/extract';
import { probeMdUrl } from '@/server/lib/crawler/probe-md';
import { createClient, summarizePage } from '@/server/lib/llm';

export const summarizeUseCase: UseCase<SummarizeRequest, SummarizeResponse> = {
  run: async (ctx, input) => {
    if (!input.url || !input.apiKey || !input.site) {
      throw new AppError('url, apiKey, and site are required', 400);
    }

    let result;
    let mdUrl;
    try {
      [result, mdUrl] = await Promise.all([
        fetchPage(ctx, input.url),
        probeMdUrl(input.url),
      ]);
    } catch (err) {
      throw new AppError(
        `Fetch: ${getErrorMessage(err)}`,
        err instanceof AppError ? err.status : 500,
      );
    }

    if (isSpaShell(result.html)) {
      throw new AppError(
        'Fetch: Page appears to be a JavaScript app shell with no server-rendered content',
        422,
      );
    }
    const text = extractText(result.html);

    const pageInfo: PageInfo = {
      pageUrl: result.url,
      mdUrl,
      description: extractDescription(result.html),
    };

    let page;
    try {
      page = await summarizePage(
        ctx,
        createClient(input.apiKey),
        pageInfo,
        text,
        input.site,
      );
    } catch (err) {
      throw new AppError(
        `LLM: ${getErrorMessage(err)}`,
        err instanceof AppError ? err.status : 500,
      );
    }

    ctx.logger.info(
      {
        url: result.url,
        title: page.title,
        isSupplementary: page.isSupplementary,
      },
      'page summarized',
    );

    return page;
  },
};
