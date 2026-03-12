import pino from 'pino';
import { getErrorMessage } from './errors';
import { Context } from 'vm';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export type Logger = Pick<typeof logger, 'info' | 'warn' | 'error' | 'debug'>;

export type LoggerContext = { logger: Logger };

export const withTrace = async <T>(
  ctx: Context,
  label: string,
  args: object,
  fn: () => Promise<T>,
): Promise<T> => {
  ctx.logger.info({ label, args, phase: 'START' });
  try {
    const result = await fn();
    ctx.logger.info({ label, phase: 'END' });
    return result;
  } catch (err) {
    ctx.logger.error({ label, err: getErrorMessage(err), phase: 'ERROR' });
    throw err;
  }
};
