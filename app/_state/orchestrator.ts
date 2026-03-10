/**
 * Crawl pipeline orchestrator.
 *
 * Drives the three-phase crawl process from the client side:
 *
 *   1. **Discover** – POST `/api/discover` to find all page URLs for a site
 *      (via sitemap or BFS crawl). This phase does NOT retry on failure;
 *      errors are surfaced immediately to the user.
 *
 *   2. **Summarize** – POST `/api/summarize` for every discovered URL.
 *      Pages are summarized concurrently using Bottleneck for rate-limiting
 *      (see `SUMMARIZE_CONCURRENCY` / `SUMMARIZE_MIN_TIME_MS`).
 *      Each page is retried independently with exponential back-off
 *      (`RETRY.maxAttempts`, base delay `RETRY.baseMs`, max delay `RETRY.maxMs`,
 *      factor 2, jitter enabled). Non-retryable HTTP status codes (4xx except
 *      429) bail immediately. The UI is kept in sync via dispatch actions:
 *        - `SUMMARIZE_PAGE_DONE`          – first-try success
 *        - `SUMMARIZE_PAGE_FAILED`        – first failure (may still retry)
 *        - `SUMMARIZE_PAGE_RETRYING`      – subsequent retry attempt
 *        - `SUMMARIZE_PAGE_RETRY_SUCCESS` – succeeded after prior failure
 *        - `SUMMARIZE_PAGE_RETRY_EXHAUSTED` – all retries used up
 *      Partial failures are tolerated — the pipeline continues as long as at
 *      least one page was summarized.
 *
 *   3. **Assemble** – POST `/api/assemble` to combine all page summaries into
 *      the final llms.txt output. This call uses `postApiWithRetry` (same
 *      exponential back-off config) since it is a single request.
 *
 * Abort handling:
 *   The caller passes an `AbortSignal`. On abort the pipeline:
 *   - Passes the signal to every `fetch` call (triggers `AbortError`).
 *   - Tells Bottleneck to drop all waiting jobs.
 *   - Returns silently without dispatching an ERROR action.
 *
 * State management:
 *   All UI state transitions are driven by dispatching `Action` objects into
 *   the reducer (see `./reducer.ts`). The orchestrator never reads state —
 *   it only writes via dispatch.
 */

import Bottleneck from 'bottleneck';
import retry from 'async-retry';
import type {
  CrawlConfig,
  PageSummary,
  PageFailure,
  DiscoverResponse,
  SummarizeResponse,
  AssembleResponse,
  SiteInfo,
} from '@/shared/types';
import type { Action } from './reducer';

const SUMMARIZE_CONCURRENCY = 10;
const SUMMARIZE_MIN_TIME_MS = 2_000;

const RETRY_OPTS = {
  retries: 3,
  minTimeout: 200,
  factor: 2,
  maxTimeout: 5_000,
  randomize: true,
} as const;

// ─── Shared fetch helpers ────────────────────────────────────────────────────

/** Discriminated union: either the parsed JSON payload or an error with status. */
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

/** POST JSON to an internal API route. Never throws — HTTP errors are returned as `{ ok: false }`. */
const postApi = async <T>(
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

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

/** POST with automatic retry. Non-retryable status codes bail immediately; retryable ones back off. */
const postApiWithRetry = async <T>(
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

// ─── Summarize phase ────────────────────────────────────────────────────────

type SummarizePageResult =
  | { ok: true; page: PageSummary }
  | { ok: false; failure: PageFailure };

/**
 * Summarize a single page with retry and progress dispatching.
 *
 * Returns `null` when the request was aborted (no action dispatched).
 * On success/failure, dispatches the appropriate retry-aware action so the UI
 * can show per-page retry progress (failed → retrying → recovered / exhausted).
 */
const summarizePage = async (
  pageUrl: string,
  apiKey: string,
  site: SiteInfo,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<SummarizePageResult | null> => {
  if (signal.aborted) return null;

  let lastRetryError = '';
  let hasFailedOnce = false;

  try {
    const page = await retry(
      async (bail) => {
        const result = await postApi<SummarizeResponse>(
          '/api/summarize',
          { url: pageUrl, apiKey, site },
          signal,
        );

        if (result.ok) return result.data;

        if (!isRetryableStatus(result.status)) {
          bail(new Error(result.error));
          return undefined as never;
        }
        throw new Error(result.error);
      },
      {
        ...RETRY_OPTS,
        onRetry: (err: Error, attempt: number) => {
          if (attempt === 1) {
            hasFailedOnce = true;
            dispatch({
              type: 'SUMMARIZE_PAGE_FAILED',
              url: pageUrl,
              error: err.message,
              retrying: true,
            });
          } else {
            dispatch({ type: 'SUMMARIZE_PAGE_RETRYING', url: pageUrl });
          }
          lastRetryError = err.message;
        },
      },
    );

    if (signal.aborted) return null;

    if (hasFailedOnce) {
      dispatch({ type: 'SUMMARIZE_PAGE_RETRY_SUCCESS', url: pageUrl, page });
    } else {
      dispatch({ type: 'SUMMARIZE_PAGE_DONE', page });
    }
    return { ok: true, page };
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return null;

    const error = lastRetryError || (err as Error).message || 'Unknown error';

    if (hasFailedOnce) {
      dispatch({ type: 'SUMMARIZE_PAGE_RETRY_EXHAUSTED', url: pageUrl });
    } else {
      dispatch({
        type: 'SUMMARIZE_PAGE_FAILED',
        url: pageUrl,
        error,
        retrying: false,
      });
    }
    return { ok: false, failure: { url: pageUrl, error } };
  }
};

/**
 * Summarize all discovered URLs concurrently.
 *
 * Uses Bottleneck to enforce `maxConcurrent` and `minTime` between requests,
 * preventing the server (and upstream LLM API) from being overwhelmed.
 * Each URL is processed independently via `summarizePage`; individual failures
 * do not abort the batch. Results are partitioned into successful pages and
 * failures after all promises settle.
 */
const summarizeAll = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<{ pages: PageSummary[]; failures: PageFailure[] }> => {
  const limiter = new Bottleneck({
    maxConcurrent: SUMMARIZE_CONCURRENCY,
    minTime: SUMMARIZE_MIN_TIME_MS,
  });

  signal.addEventListener('abort', () => {
    limiter.stop({ dropWaitingJobs: true });
  });

  const promises = urls.map((pageUrl) =>
    limiter.schedule(() => summarizePage(pageUrl, apiKey, site, signal, dispatch)),
  );

  const results = await Promise.allSettled(promises);

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    if (result.value.ok) pages.push(result.value.page);
    else failures.push(result.value.failure);
  }

  return { pages, failures };
};

// ─── Public pipeline ─────────────────────────────────────────────────────────

/**
 * Run the full discover → summarize → assemble pipeline.
 *
 * This is the single entry point called by the UI. It dispatches actions to
 * drive state transitions and handles abort + error boundaries so the caller
 * only needs to provide an `AbortSignal` and a `dispatch` function.
 */
export const runCrawlPipeline = async (
  url: string,
  config: CrawlConfig,
  apiKey: string,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<void> => {
  const startMs = Date.now();

  try {
    dispatch({ type: 'START_DISCOVER' });

    const discoverResult = await postApi<DiscoverResponse>(
      '/api/discover',
      {
        url,
        ...(config.maxPages != null && { maxPages: config.maxPages }),
      },
      signal,
    );

    if (!discoverResult.ok) {
      dispatch({ type: 'ERROR', message: discoverResult.error });
      return;
    }

    const { urls, site, method } = discoverResult.data;

    dispatch({
      type: 'START_SUMMARIZE_PAGES',
      total: urls.length,
      discoveryMethod: method,
    });
    const { pages, failures } = await summarizeAll(
      urls,
      apiKey,
      site,
      signal,
      dispatch,
    );

    if (signal.aborted) return;

    if (pages.length === 0) {
      dispatch({ type: 'ERROR', message: 'No pages could be summarized' });
      return;
    }

    dispatch({ type: 'START_ASSEMBLE' });
    const { llmsTxt } = await postApiWithRetry<AssembleResponse>(
      '/api/assemble',
      { pages, entryUrl: url, site, apiKey },
      signal,
    );

    dispatch({
      type: 'COMPLETE',
      llmsTxt,
      stats: { summarized: pages.length, elapsedMs: Date.now() - startMs },
      failures,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    dispatch({
      type: 'ERROR',
      message: (err as Error).message ?? 'Something went wrong',
    });
  }
};
