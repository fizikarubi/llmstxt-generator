import { NextRequest, NextResponse } from 'next/server';
import { newContext } from '@/server/lib/context';
import { withTrace } from '@/server/lib/logger';
import { discoverUseCase } from '@/server/usecases/discover';
import type { DiscoverRequest } from '@/shared/types';
import { getErrorMessage, getErrorStatus } from '@/server/lib/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = async (req: NextRequest) => {
  const ctx = newContext();
  try {
    const body: DiscoverRequest = await req.json();
    const result = await withTrace(ctx, 'discover', { url: body.url }, () =>
      discoverUseCase.run(ctx, body),
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: getErrorStatus(err) },
    );
  }
};
