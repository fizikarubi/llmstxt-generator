import retry from 'async-retry';

const RETRY_OPTS = {
  retries: 3,
  minTimeout: 200,
  factor: 2,
  maxTimeout: 5_000,
  randomize: true,
} as const;

/** Discriminated union: either the parsed JSON payload or an error with status. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

/** POST JSON to an internal API route. Never throws — HTTP errors are returned as `{ ok: false }`. */
export const postApi = async <T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<ApiResult<T>> => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: json.error ?? `HTTP ${res.status}`,
      status: res.status,
    };
  }

  return { ok: true, data: (await res.json()) as T };
};

export const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

/** POST with automatic retry. Non-retryable status codes bail immediately; retryable ones back off. */
export const postApiWithRetry = async <T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> =>
  retry(async (bail) => {
    const result = await postApi<T>(path, body, signal);
    if (result.ok) return result.data;

    if (!isRetryableStatus(result.status)) {
      bail(new Error(result.error));
      return undefined as never;
    }
    throw new Error(result.error);
  }, RETRY_OPTS);
