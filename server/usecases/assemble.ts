import type { UseCase } from '@/server/lib/usecase';
import type { AssembleRequest, AssembleResponse } from '@/shared/types';
import { AppError } from '@/server/lib/errors';
import { createClient, assembleWithLlm } from '@/server/lib/llm';

export const assembleUseCase: UseCase<AssembleRequest, AssembleResponse> = {
  run: async (ctx, input) => {
    if (!input.pages?.length || !input.entryUrl || !input.site || !input.apiKey) {
      throw new AppError('pages, entryUrl, site, and apiKey are required', 400);
    }

    const llmsTxt = await assembleWithLlm(
      ctx,
      createClient(input.apiKey),
      input.entryUrl,
      input.site,
      input.pages,
    );

    ctx.logger.info(
      { entryUrl: input.entryUrl, pageCount: input.pages.length },
      'assembly complete',
    );

    return { llmsTxt };
  },
};
