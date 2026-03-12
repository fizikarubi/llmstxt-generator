/**
 * llms.txt generation pipeline.
 *
 * Drives the three-phase process from the client side:
 *
 *   1. **Discover** – POST `/api/discover` to find all page URLs for a site
 *      (via sitemap or BFS crawl). This phase does NOT retry on failure;
 *      errors are surfaced immediately to the user.
 *
 *   2. **Summarize** – POST `/api/summarize-batch` for batches of URLs.
 *      URLs are chunked into groups of BATCH_SIZE and processed concurrently
 *      using Bottleneck for rate-limiting. Each batch is retried as a whole
 *      with exponential back-off; non-retryable HTTP status codes (4xx except
 *      429) bail immediately. The UI is kept in sync via dispatch actions:
 *        - `SUMMARIZE_BATCH_DONE`   – page summarized successfully
 *        - `SUMMARIZE_BATCH_FAILED` – page failed (batch-level or per-page)
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
 *   the reducer (see `./reducer.ts`). The pipeline never reads state —
 *   it only writes via dispatch.
 */

import Bottleneck from 'bottleneck';
import retry from 'async-retry';
import type {
  PipelineConfig,
  PageSummary,
  PageFailure,
  DiscoverResponse,
  SummarizeBatchResponse,
  AssembleResponse,
  SiteInfo,
} from '@/shared/types';
import type { Action } from './reducer';
import { postApi, postApiWithRetry, isRetryableStatus } from './api';

const SUMMARIZE_BATCH_SIZE = 20;
const SUMMARIZE_MIN_TIME_MS = 200;

const RETRY_OPTS = {
  retries: 3,
  minTimeout: 200,
  factor: 2,
  maxTimeout: 5_000,
  randomize: true,
} as const;

// ─── Summarize phase ────────────────────────────────────────────────────────

/** Split an array into chunks of `size`. */
const chunk = <T>(arr: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

/**
 * Summarize a batch of URLs via the batch endpoint with retry.
 *
 * On success, dispatches SUMMARIZE_BATCH_DONE per page and SUMMARIZE_BATCH_FAILED
 * for any per-page failures reported by the server. On total batch failure
 * (after retries), all URLs in the batch are marked as failed.
 */
const summarizeBatch = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<{ pages: PageSummary[]; failures: PageFailure[] }> => {
  if (signal.aborted) return { pages: [], failures: [] };

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];
  let hasFailedOnce = false;

  try {
    const result = await retry(
      async (bail) => {
        const r = await postApi<SummarizeBatchResponse>(
          '/api/summarize-batch',
          { urls, apiKey, site },
          signal,
        );
        if (r.ok) return r.data;
        if (!isRetryableStatus(r.status)) {
          bail(new Error(r.error));
          return undefined as never;
        }
        throw new Error(r.error);
      },
      {
        ...RETRY_OPTS,
        onRetry: (err: Error, attempt: number) => {
          if (attempt === 1) {
            hasFailedOnce = true;
            for (const url of urls)
              dispatch({
                type: 'SUMMARIZE_BATCH_FAILED',
                url,
                error: err.message,
                retrying: true,
              });
          } else {
            for (const url of urls) dispatch({ type: 'SUMMARIZE_BATCH_RETRYING', url });
          }
        },
      },
    );

    if (signal.aborted) return { pages: [], failures: [] };

    for (const page of result.results) {
      if (hasFailedOnce) {
        dispatch({ type: 'SUMMARIZE_BATCH_RETRY_SUCCESS', url: page.meta.pageUrl, page });
      } else {
        dispatch({ type: 'SUMMARIZE_BATCH_DONE', page });
      }
      pages.push(page);
    }
    for (const f of result.failures) {
      dispatch({
        type: 'SUMMARIZE_BATCH_FAILED',
        url: f.url,
        error: f.error,
        retrying: false,
      });
      failures.push({ url: f.url, error: f.error });
    }
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return { pages: [], failures: [] };

    const error = (err as Error).message || 'Batch request failed';
    for (const url of urls) {
      if (hasFailedOnce) {
        dispatch({ type: 'SUMMARIZE_BATCH_RETRY_EXHAUSTED', url });
      } else {
        dispatch({
          type: 'SUMMARIZE_BATCH_FAILED',
          url,
          error,
          retrying: false,
        });
      }
      failures.push({ url, error });
    }
  }

  return { pages, failures };
};

/**
 * Summarize all discovered URLs in batches.
 *
 * Chunks URLs into groups of BATCH_SIZE and processes them concurrently
 * via Bottleneck. Each batch is retried as a whole on failure; there is
 * no per-page fallback.
 */
const summarizeAll = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  concurrency: number,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<{ pages: PageSummary[]; failures: PageFailure[] }> => {
  const limiter = new Bottleneck({
    maxConcurrent: concurrency,
    minTime: SUMMARIZE_MIN_TIME_MS,
  });

  signal.addEventListener('abort', () => {
    limiter.stop({ dropWaitingJobs: true });
  });

  const batches = chunk(urls, SUMMARIZE_BATCH_SIZE);
  const promises = batches.map((batch) =>
    limiter.schedule(() => summarizeBatch(batch, apiKey, site, signal, dispatch)),
  );

  const results = await Promise.allSettled(promises);

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    pages.push(...result.value.pages);
    failures.push(...result.value.failures);
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
export const runPipeline = async (
  url: string,
  config: PipelineConfig,
  apiKey: string,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<void> => {
  const startMs = Date.now();

  try {
    dispatch({ type: 'START_DISCOVER_PHASE' });

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
      type: 'START_SUMMARIZE_PHASE',
      total: urls.length,
      discoveryMethod: method,
    });
    const { pages, failures } = await summarizeAll(
      urls,
      apiKey,
      site,
      config.concurrency,
      signal,
      dispatch,
    );

    if (signal.aborted) return;

    if (pages.length === 0) {
      dispatch({ type: 'ERROR', message: 'No pages could be summarized' });
      return;
    }

    dispatch({ type: 'START_ASSEMBLE_PHASE' });
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
