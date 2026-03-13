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
 *      concurrency-limited via p-queue. Each batch is a single attempt — no
 *      retries. A 429 from any batch aborts the entire queue so no further
 *      batches start. The UI is kept in sync via dispatch actions:
 *        - `SUMMARIZE_BATCH_DONE`   – page summarized successfully
 *        - `SUMMARIZE_BATCH_FAILED` – page failed (batch-level or per-page)
 *      Partial failures are tolerated — the pipeline continues as long as at
 *      least one page was summarized.
 *
 *   3. **Assemble** – POST `/api/assemble` to combine all page summaries into
 *      the final llms.txt output. This call uses `postApiWithRetry` with
 *      exponential back-off since it is a single critical request.
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
 * Summarize a batch of URLs (single attempt, no retries).
 *
 * - A 429 or billing error aborts all queued batches via `rateLimitController`.
 * - Partial success within a batch is kept (per-page summaries + failures).
 */
const summarizeBatch = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
  rateLimitController: AbortController,
  pages: PageSummary[],
  failures: PageFailure[],
): Promise<void> => {
  if (signal.aborted) {
    return;
  }

  try {
    const r = await postApi<SummarizeBatchResponse>(
      '/api/summarize-batch',
      { urls, apiKey, site },
      signal,
    );

    if (r.ok) {
      for (const page of r.data.summaries) {
        dispatch({ type: 'SUMMARIZE_BATCH_DONE', page });
        pages.push(page);
      }
      for (const f of r.data.failures) {
        dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url: f.url, error: f.error });
        failures.push({ url: f.url, error: f.error });
      }
      return;
    }

    // Any non-ok response → mark all URLs in this batch as failed
    for (const url of urls) {
      dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url, error: r.error });
      failures.push({ url, error: r.error });
    }

    // 429 → abort remaining batches
    if (r.status === 429) {
      dispatch({ type: 'RATE_LIMITED' });
      rateLimitController.abort();
      return;
    }

    // Billing errors → also abort remaining batches
    if (r.status === 400 && /credit balance/i.test(r.error)) {
      rateLimitController.abort();
    }
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
      return;
    }

    const error = (err as Error).message || 'Batch request failed';
    for (const url of urls) {
      dispatch({ type: 'SUMMARIZE_BATCH_FAILED', url, error });
      failures.push({ url, error });
    }
  }
};

const SUMMARIZE_BATCH_SIZE = 10;

/**
 * Summarize all discovered URLs in batches with bounded concurrency.
 *
 * Chunks into groups of BATCH_SIZE, rate-limited via p-queue. A 429 from
 * any batch kills the entire queue (fail-fast). Partial results are always
 * collected so the pipeline can assemble from whatever succeeded.
 */
const summarizeAll = async (
  urls: string[],
  apiKey: string,
  site: SiteInfo,
  concurrency: number,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
): Promise<{ pages: PageSummary[]; failures: PageFailure[]; rateLimited: boolean }> => {
  const limiter = new PQueue({ concurrency });
  const rateLimitController = new AbortController();

  signal.addEventListener('abort', () => {
    limiter.clear();
  });

  const pages: PageSummary[] = [];
  const failures: PageFailure[] = [];

  const batches = chunk(urls, SUMMARIZE_BATCH_SIZE);
  await Promise.all(
    batches.map((batch) =>
      limiter
        .add(
          () =>
            summarizeBatch(
              batch,
              apiKey,
              site,
              signal,
              dispatch,
              rateLimitController,
              pages,
              failures,
            ),
          { signal: rateLimitController.signal },
        )
        // Batch was aborted before it could run — record its URLs as failures
        .catch(() => {
          for (const url of batch) {
            dispatch({
              type: 'SUMMARIZE_BATCH_FAILED',
              url,
              error: 'Skipped (queue aborted)',
            });
            failures.push({ url, error: 'Skipped (queue aborted)' });
          }
        }),
    ),
  );

  return { pages, failures, rateLimited: rateLimitController.signal.aborted };
};

/**
 * Run the full discover → summarize → assemble pipeline.
 *
 *   1. **Discover** — find URLs (single request, fatal on failure)
 *   2. **Summarize** — LLM-summarize pages (batched, partial failure OK)
 *   3. **Assemble** — combine into llms.txt (retries with back-off)
 *
 * Prefers partial output over total failure — assembles whatever pages
 * succeeded. Abort returns silently (no ERROR dispatch).
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

    if (urls.length === 0) {
      dispatch({ type: 'ERROR', message: 'No pages found on this site.' });
      return;
    }

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
          : (failures[0]?.error ?? 'All pages failed to summarize.');
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
