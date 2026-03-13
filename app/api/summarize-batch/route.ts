import { NextRequest, NextResponse } from 'next/server';
import { newContext } from '@/server/lib/context';
import { withTrace } from '@/server/lib/logger';
import { summarizeBatchUseCase } from '@/server/usecases/summarize-batch';
import type { SummarizeBatchRequest } from '@/shared/types';
import { getErrorMessage, getErrorStatus } from '@/server/lib/errors';

export const runtime = 'nodejs';

export const POST = async (req: NextRequest) => {
  const ctx = newContext();
  try {
    const body: SummarizeBatchRequest = await req.json();
    const result = await withTrace(
      ctx,
      'summarize-batch',
      { count: body.urls.length },
      () => summarizeBatchUseCase.run(ctx, body),
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: getErrorStatus(err) },
    );
  }
};
