import type { Context } from '@/server/lib/context';

export type UseCase<TInput, TOutput> = {
  run: (ctx: Context, input: TInput) => Promise<TOutput>;
};
