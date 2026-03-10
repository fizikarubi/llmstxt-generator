import { logger } from '@/server/lib/logger';

export type Context = { logger: typeof logger };

export const newContext = () => ({
  logger: logger.child({ trace_id: crypto.randomUUID() }),
});
