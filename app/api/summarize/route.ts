import { NextRequest, NextResponse } from 'next/server';
import { newContext } from '@/server/lib/context';
import { withTrace } from '@/server/lib/logger';
import { summarizeUseCase } from '@/server/usecases/summarize';
import type { SummarizeRequest } from '@/shared/types';
import { getErrorMessage, getErrorStatus } from '@/server/lib/errors';

export const POST = async (req: NextRequest) => {
  const ctx = newContext();
  try {
    const body: SummarizeRequest = await req.json();
    const result = await withTrace(ctx, 'summarize', { url: body.url }, () =>
      summarizeUseCase.run(ctx, body),
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: getErrorStatus(err) },
    );
  }
};
