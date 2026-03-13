import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AppState,
  DiscoverResponse,
  SummarizeBatchResponse,
  AssembleResponse,
  PageSummary,
} from '@/shared/types';
import { DEFAULT_CONFIG } from '@/shared/types';
import type { Action } from '../reducer';
import { reducer } from '../reducer';
import { runPipeline } from '../pipeline';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makePage = (n: number): PageSummary => ({
  meta: {
    pageUrl: `https://example.com/page-${n}`,
    mdUrl: null,
    description: `Page ${n} description`,
  },
  title: `Page ${n}`,
  summary: `Summary for page ${n}`,
  isSupplementary: false,
});

const DISCOVER_OK: DiscoverResponse = {
  urls: ['https://example.com/a', 'https://example.com/b'],
  site: { name: 'Example', description: 'Test' },
  method: 'sitemap',
};

const ASSEMBLE_OK: AssembleResponse = { llmsTxt: '# Example\n> Test' };

const makeBatchOk = (...pages: PageSummary[]): SummarizeBatchResponse => ({
  summaries: pages,
  failures: [],
});

/**
 * Collect every dispatch call into an array so we can replay them through the
 * reducer and inspect the final state (or any intermediate state).
 */
const collectActions = () => {
  const actions: Action[] = [];
  const dispatch = (a: Action) => actions.push(a);
  return { actions, dispatch };
};

const replayState = (actions: Action[]): AppState =>
  actions.reduce<AppState>((s, a) => reducer(s, a), { status: 'idle' });

/** Build a mock fetch that routes by URL path suffix. */
const mockFetch = (routes: Record<string, () => Response | Promise<Response>>) =>
  vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.endsWith(pattern)) return handler();
    }
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
    });
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runCrawlPipeline', { timeout: 30_000 }, () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Discovery failures ──────────────────────────────────────────────────

  it('dispatches ERROR when discover returns robots-blocked (403)', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () =>
        jsonResponse({ error: 'robots.txt disallows crawling this site' }, 403),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'robots.txt',
    );
  });

  it('dispatches ERROR when discover returns SPA-shell (422)', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () =>
        jsonResponse({ error: 'This page appears to be a JavaScript app' }, 422),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'JavaScript app',
    );
  });

  it('dispatches ERROR when discover returns no pages (404)', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () =>
        jsonResponse(
          { error: 'No pages found — site may require JavaScript to render' },
          404,
        ),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'No pages found',
    );
  });

  it('dispatches ERROR when discover fetch throws (network failure)', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'Failed to fetch',
    );
  });

  it('dispatches ERROR when discover returns 500', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse({ error: 'Internal server error' }, 500),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toBe(
      'Internal server error',
    );
  });

  // ── Summarize failures ──────────────────────────────────────────────────

  it('reaches complete with partial failures when some pages fail to summarize', async () => {
    const page1 = makePage(1);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () =>
        jsonResponse({
          summaries: [page1],
          failures: [{ url: 'https://example.com/b', error: 'LLM rate limited' }],
        }),
      '/api/assemble': () => jsonResponse(ASSEMBLE_OK),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('complete');
    const complete = state as Extract<AppState, { status: 'complete' }>;
    expect(complete.failures.length).toBe(1);
    expect(complete.stats.summarized).toBe(1);
  });

  it('dispatches ERROR when all pages fail to summarize', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () => jsonResponse({ error: 'Page fetch timeout' }, 400),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toBe(
      'Page fetch timeout',
    );
  });

  it('dispatches SUMMARIZE_BATCH_FAILED for all URLs when batch fails', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () => jsonResponse({ error: 'Timeout' }, 400),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const failedActions = actions.filter((a) => a.type === 'SUMMARIZE_BATCH_FAILED');
    expect(failedActions.length).toBe(2);
  });

  it('marks all URLs as failed when batch returns 500', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () =>
        jsonResponse({ ...DISCOVER_OK, urls: ['https://example.com/a'] }),
      '/api/summarize-batch': () => jsonResponse({ error: 'Temporary error' }, 500),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const state = replayState(actions);
    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toBe(
      'Temporary error',
    );
  });

  // ── 429 rate-limit handling ────────────────────────────────────────────

  it('stops queue globally on 429 and dispatches RATE_LIMITED', async () => {
    globalThis.fetch = mockFetch({
      '/api/discover': () =>
        jsonResponse({ ...DISCOVER_OK, urls: ['https://example.com/a'] }),
      '/api/summarize-batch': () => jsonResponse({ error: 'Rate limited' }, 429),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    expect(actions.some((a) => a.type === 'RATE_LIMITED')).toBe(true);

    const state = replayState(actions);
    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'Rate-limited',
    );
  });

  it('clears pending batches when one batch hits 429', async () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}`);
    let summarizeCalls = 0;

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse({ ...DISCOVER_OK, urls }),
      '/api/summarize-batch': () => {
        summarizeCalls++;
        return jsonResponse({ error: 'Rate limited' }, 429);
      },
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    // Only the in-flight batch(es) should have called the API — pending ones
    // should have been cleared from the queue.
    expect(summarizeCalls).toBeLessThanOrEqual(DEFAULT_CONFIG.concurrency);

    const state = replayState(actions);
    expect(state.status).toBe('error');
  });

  // ── Assemble failures ──────────────────────────────────────────────────

  it('dispatches ERROR when assemble fails with non-retryable error', async () => {
    const page1 = makePage(1);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () => jsonResponse(makeBatchOk(page1)),
      '/api/assemble': () => jsonResponse({ error: 'Invalid API key' }, 401),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'Invalid API key',
    );
  });

  it('dispatches ERROR when assemble fails after retries (500)', async () => {
    const page1 = makePage(1);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () => jsonResponse(makeBatchOk(page1)),
      '/api/assemble': () => jsonResponse({ error: 'LLM unavailable' }, 500),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('error');
    expect((state as Extract<AppState, { status: 'error' }>).message).toContain(
      'LLM unavailable',
    );
  });

  // ── Abort handling ──────────────────────────────────────────────────────

  it('stops cleanly when aborted during discovery', async () => {
    const abort = new AbortController();

    globalThis.fetch = mockFetch({
      '/api/discover': async () => {
        abort.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    });

    const { actions, dispatch } = collectActions();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const state = replayState(actions);
    expect(state.status).not.toBe('error');
  });

  it('stops cleanly when aborted during summarize', async () => {
    const abort = new AbortController();
    const singleUrlDiscover: DiscoverResponse = {
      ...DISCOVER_OK,
      urls: ['https://example.com/a'],
    };

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(singleUrlDiscover),
      '/api/summarize-batch': async () => {
        abort.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    });

    const { actions, dispatch } = collectActions();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const errorActions = actions.filter((a) => a.type === 'ERROR');
    expect(errorActions.length).toBe(0);
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('completes full pipeline with all pages summarized', async () => {
    const page1 = makePage(1);
    const page2 = makePage(2);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse(DISCOVER_OK),
      '/api/summarize-batch': () => jsonResponse(makeBatchOk(page1, page2)),
      '/api/assemble': () => jsonResponse(ASSEMBLE_OK),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );
    const state = replayState(actions);

    expect(state.status).toBe('complete');
    const complete = state as Extract<AppState, { status: 'complete' }>;
    expect(complete.stats.summarized).toBe(2);
    expect(complete.failures.length).toBe(0);
    expect(complete.llmsTxt).toBe('# Example\n> Test');
  });

  // ── Discovery method propagation ───────────────────────────────────────

  it('propagates sitemap discovery method to summarizing state', async () => {
    const page1 = makePage(1);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse({ ...DISCOVER_OK, method: 'sitemap' }),
      '/api/summarize-batch': () => jsonResponse(makeBatchOk(page1)),
      '/api/assemble': () => jsonResponse(ASSEMBLE_OK),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const startSummarize = actions.find((a) => a.type === 'START_SUMMARIZE_PHASE');
    expect(startSummarize).toBeDefined();
    expect(
      (startSummarize as Extract<Action, { type: 'START_SUMMARIZE_PHASE' }>)
        .discoveryMethod,
    ).toBe('sitemap');
  });

  it('propagates bfs discovery method to summarizing state', async () => {
    const page1 = makePage(1);

    globalThis.fetch = mockFetch({
      '/api/discover': () => jsonResponse({ ...DISCOVER_OK, method: 'bfs' }),
      '/api/summarize-batch': () => jsonResponse(makeBatchOk(page1)),
      '/api/assemble': () => jsonResponse(ASSEMBLE_OK),
    });

    const { actions, dispatch } = collectActions();
    const abort = new AbortController();

    await runPipeline(
      'https://example.com',
      DEFAULT_CONFIG,
      'key',
      abort.signal,
      dispatch,
    );

    const startSummarize = actions.find((a) => a.type === 'START_SUMMARIZE_PHASE');
    expect(startSummarize).toBeDefined();
    expect(
      (startSummarize as Extract<Action, { type: 'START_SUMMARIZE_PHASE' }>)
        .discoveryMethod,
    ).toBe('bfs');

    const summarizingState = actions
      .reduce<AppState[]>((states, a) => {
        const prev =
          states.length > 0 ? states[states.length - 1] : { status: 'idle' as const };
        states.push(reducer(prev, a));
        return states;
      }, [])
      .find((s) => s.status === 'summarizing');

    expect(summarizingState?.status).toBe('summarizing');
    if (summarizingState?.status === 'summarizing') {
      expect(summarizingState.progress.discoveryMethod).toBe('bfs');
    }
  });
});
