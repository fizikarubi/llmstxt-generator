import { NextRequest, NextResponse } from 'next/server';
import { newContext } from '@/server/lib/context';
import { withTrace } from '@/server/lib/logger';
import { assembleUseCase } from '@/server/usecases/assemble';
import type { AssembleRequest } from '@/shared/types';
import { getErrorMessage, getErrorStatus } from '@/server/lib/errors';

export const runtime = 'nodejs';

export const POST = async (req: NextRequest) => {
  const ctx = newContext();
  try {
    const body: AssembleRequest = await req.json();
    const result = await withTrace(
      ctx,
      'assemble',
      { entryUrl: body.entryUrl },
      () => assembleUseCase.run(ctx, body),
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: getErrorStatus(err) },
    );
  }
};
