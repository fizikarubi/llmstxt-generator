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
 *      using p-queue for rate-limiting. Each batch is a single attempt — no
 *      retries. A 429 from any batch aborts the entire queue so no further
 *      batches start. The UI is kept in sync via dispatch actions:
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
 *   - Clears the p-queue so no new batches start.
 *   - Returns silently without dispatching an ERROR action.
 *
 * State management:
 *   All UI state transitions are driven by dispatching `Action` objects into
 *   the reducer (see `./reducer.ts`). The pipeline never reads state —
 *   it only writes via dispatch.
 */

import PQueue from 'p-queue';
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
import { postApi, postApiWithRetry } from './api';

const SUMMARIZE_BATCH_SIZE = 20;
const SUMMARIZE_MIN_TIME_MS = 500;

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
 * Summarize a batch of URLs via the batch endpoint (single attempt).
 *
 * No retries — each batch either succeeds or fails once. A 429 response
 * aborts the shared rateLimitController so all queued batches are cancelled
 * immediately. On success, dispatches SUMMARIZE_BATCH_DONE per page and
 * SUMMARIZE_BATCH_FAILED for any per-page failures. On total batch failure,
 * all URLs in the batch are marked as failed.
 */
const summarizeBatch = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
  rateLimitController: AbortController,
): Promise<{ pages: PageSummary[]; failures: PageFailure[] }> => {
  if (signal.aborted) return { pages: [], failures: [] };

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];

  try {
    const r = await postApi<SummarizeBatchResponse>(
      '/api/summarize-batch',
      { urls, apiKey, site },
      signal,
    );

    if (r.ok) {
      for (const page of r.data.results) {
        dispatch({ type: 'SUMMARIZE_BATCH_DONE', page });
        pages.push(page);
      }
      for (const f of r.data.failures) {
        dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url: f.url, error: f.error });
        failures.push({ url: f.url, error: f.error });
      }
      return { pages, failures };
    }

    // 429 → flag rate-limit and abort all queued batches
    if (r.status === 429) {
      dispatch({ type: 'RATE_LIMITED' });
      rateLimitController.abort();
    }

    // Unrecoverable billing/auth errors → stop immediately and surface to user
    if (r.status === 400 && /credit balance/i.test(r.error)) {
      for (const url of urls) {
        dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url, error: r.error });
        failures.push({ url, error: r.error });
      }
      rateLimitController.abort();
      return { pages, failures };
    }

    // Any error — mark all URLs as failed
    for (const url of urls) {
      dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url, error: r.error });
      failures.push({ url, error: r.error });
    }
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return { pages: [], failures: [] };

    const error = (err as Error).message || 'Batch request failed';
    for (const url of urls) {
      dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url, error });
      failures.push({ url, error });
    }
  }

  return { pages, failures };
};

/**
 * Summarize all discovered URLs in batches.
 *
 * Chunks URLs into groups of BATCH_SIZE and processes them concurrently
 * via p-queue. Each batch is a single attempt — no retries. A 429 from
 * any batch aborts all queued batches via a shared AbortController.
 */
const summarizeAll = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  concurrency: number,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<{ pages: PageSummary[]; failures: PageFailure[]; rateLimited: boolean }> => {
  const limiter = new PQueue({
    concurrency,
    intervalCap: 1,
    interval: SUMMARIZE_MIN_TIME_MS,
  });
  const rateLimitController = new AbortController();

  signal.addEventListener('abort', () => {
    limiter.clear();
  });

  const batches = chunk(urls, SUMMARIZE_BATCH_SIZE);
  const promises = batches.map((batch) =>
    limiter
      .add(
        () => summarizeBatch(batch, apiKey, site, signal, dispatch, rateLimitController),
        { signal: rateLimitController.signal },
      )
      .catch(() => ({ pages: [] as PageSummary[], failures: [] as PageFailure[] })),
  );

  const results = await Promise.allSettled(promises);

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    pages.push(...result.value.pages);
    failures.push(...result.value.failures);
  }

  return { pages, failures, rateLimited: rateLimitController.signal.aborted };
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
    const { pages, failures, rateLimited } = await summarizeAll(
      urls,
      apiKey,
      site,
      config.concurrency,
      signal,
      dispatch,
    );

    if (signal.aborted) return;

    if (pages.length === 0) {
      const billingFailure = failures.find((f) => /credit balance/i.test(f.error));
      const message = billingFailure
        ? 'Your Anthropic API credit balance is too low. Please add credits and try again.'
        : rateLimited
          ? `Rate-limited by the API \u2014 all ${failures.length} pages failed. Try lowering concurrency.`
          : `All ${failures.length} pages failed to summarize. Check the error details and try again.`;
      dispatch({ type: 'ERROR', message });
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
      rateLimited,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    dispatch({
      type: 'ERROR',
      message: (err as Error).message ?? 'Something went wrong',
    });
  }
};
