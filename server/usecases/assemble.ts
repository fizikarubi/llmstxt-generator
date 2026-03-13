import type { UseCase } from '@/server/lib/usecase';
import type { AssembleRequest, AssembleResponse } from '@/shared/types';
import { AppError, getErrorMessage, getErrorStatus } from '@/server/lib/errors';
import { withTrace } from '@/server/lib/logger';
import { anthropic } from '@/server/lib/anthropic';
import Anthropic from '@anthropic-ai/sdk';

/** Combine all page summaries into the final llms.txt output via LLM. */
export const assembleUseCase: UseCase<AssembleRequest, AssembleResponse> = {
  run: (ctx, input) =>
    withTrace(
      ctx,
      'assembleUseCase',
      { entryUrl: input.entryUrl, pageCount: input.pages?.length },
      async () => {
        if (!input.pages?.length || !input.entryUrl || !input.site || !input.apiKey) {
          throw new AppError('pages, entryUrl, site, and apiKey are required', 400);
        }
        const client = new Anthropic({ apiKey: input.apiKey, maxRetries: 2 });
        let llmsTxt;
        try {
          llmsTxt = await anthropic.assemblePageSummaries(
            ctx,
            client,
            input.entryUrl,
            input.site,
            input.pages,
          );
        } catch (err) {
          throw new AppError(`Anthropic: ${getErrorMessage(err)}`, getErrorStatus(err));
        }

        return { llmsTxt };
      },
    ),
};
