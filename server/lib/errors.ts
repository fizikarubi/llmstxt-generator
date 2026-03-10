export class AppError extends Error {
  constructor(
    message: string,
    public status: number = 500,
  ) {
    super(message);
  }
}

export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err) ?? 'unknown error';
};

export const getErrorStatus = (err: unknown): number =>
  err != null &&
  typeof err === 'object' &&
  'status' in err &&
  typeof err.status === 'number'
    ? err.status
    : 500;
