# Architecture

llms.txt generator — crawl any website and produce a spec-compliant [llms.txt](https://llmstxt.org) file using Claude for summarization. Works with server-rendered HTML sites; JavaScript-only SPAs are detected and skipped during both discovery and summarization.

## High-level flow

The app uses a **fan-out architecture** to avoid serverless function timeouts. Instead of one long-running function, the work is split across three short-lived endpoints orchestrated by the client:

1. **Discover** — crawl the site via sitemap (preferred) or BFS fallback with 50 concurrent fetches, max depth 3. Check robots.txt, filter, deduplicate, and normalize URLs. Over-provisions by 3x to account for pages lost to filtering.
2. **Summarize** — chunk discovered URLs into batches of 20 and fan out up to 10 concurrent requests to a serverless function. Each function invocation fetches the pages' HTML, extracts text with cheerio, and summarizes the entire batch via Claude Haiku in a single LLM call. A 429 from any batch aborts remaining batches; the pipeline continues to assemble with whatever pages succeeded.
3. **Assemble** — aggregate all page summaries and send them to Claude in one call. The LLM groups pages into logical H2 sections and places supplementary pages under `## Optional`. Haiku's 64k output token limit caps practical output at ~600 pages.

```
User enters URL + API key
     │
     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Browser Pipeline  (app/_state/pipeline.ts)                       │
│ idle → discovering → summarizing → assembling → done             │
│                                                                  │
│ ┌──────────┐     ┌───────────────┐     ┌──────────┐              │
│ │ Discover │────►│ Summarize ×N  │────►│ Assemble │              │
│ └──────────┘     └───────────────┘     └──────────┘              │
│              ⤫ abortable at any phase                            │
└──────┼───────────────────┼───────────────────┼───────────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
 ┌────────────┐    ┌───────────────┐    ┌─────────────┐
 │ /api/      │    │ /api/         │    │ /api/       │
 │ discover   │    │ summarize     │    │ assemble    │
 ├────────────┤    ├───────────────┤    ├─────────────┤
 │ robots.txt │    │ extract text  │    │ all page    │
 │ sitemap or │    │ from URL      │    │ summaries   │
 │ BFS crawl  │    │ Haiku batch   │    │ → Haiku     │
 │            │    │ summarize     │    │ → llms.txt  │
 │ → urls[]   │    │               │    └─────────────┘
 └────────────┘    │ batch: 20     │
                   │ concurrency:10│
                   │ 429 → partial │
                   │               │
                   │ → summaries[] │
                   └───────────────┘
```

Each serverless function completes within its timeout (discover: 60s, summarize: 15s, assemble: 60s). No SSE or streaming is needed — the client tracks progress by counting resolved promises from step 2.

## Project structure

```
app/
├── page.tsx                    # Top-level UI, useReducer state machine
├── layout.tsx
├── _state/
│   ├── pipeline.ts         # Client-side pipeline (discover → summarize → assemble)
│   ├── reducer.ts              # State machine reducer + action types
│   └── __tests__/
│       ├── pipeline.test.ts
│       ├── reducer.test.ts
│       └── api.test.ts
├── api/
│   ├── discover/route.ts       # Endpoint 1: URL discovery
│   ├── summarize-batch/route.ts # Endpoint 2: batch summarize
│   └── assemble/route.ts       # Endpoint 3: final assembly

components/
├── UrlInput.tsx                # URL + API key form, maxPages slider
├── PipelineProgress.tsx           # Progress bar + page list
└── OutputPreview.tsx           # Editable output, copy/download

server/
├── lib/
│   ├── llm.ts                  # Claude API wrapper (summarizePageBatch, assembleWithLlm)
│   ├── logger.ts               # Pino logger with trace ID mixin
│   ├── errors.ts               # AppError class + helpers
│   ├── usecase.ts              # UseCase<TInput, TOutput> interface
│   ├── context.ts              # Request context (trace ID)
│   └── crawler/
│       ├── index.ts            # Crawler facade (re-exports all functions)
│       ├── discover.ts         # URL discovery (sitemap + BFS fallback)
│       ├── fetcher.ts          # Single-page HTTP fetch
│       ├── robots.ts           # robots.txt parser
│       ├── extract.ts          # HTML metadata extraction (SiteInfo + PageMeta)
│       └── probe-md.ts         # .md URL detection per llms.txt spec
└── usecases/
    ├── discover.ts             # DiscoverUseCase
    ├── summarize.ts            # SummarizeUseCase
    └── assemble.ts             # AssembleUseCase

shared/
└── types.ts                    # All shared types (API contracts, UI state)
```

## Three endpoints

### `POST /api/discover`

Finds crawlable URLs for a given site.

- **Input:** `{ url, maxPages? }`
- **Steps:** check robots.txt → discover URLs via sitemap.xml (preferred) or BFS link crawling → filter by robots + deduplicate → cap at `maxPages`
- **Returns:** `{ urls: string[], site: SiteInfo }`
- **Timeout:** `maxDuration = 60` (sitemap fetch + BFS can take 30s+ for large sites)

### `POST /api/summarize-batch`

Fetches a batch of pages and generates LLM summaries in a single call.

- **Input:** `{ urls: string[], apiKey, site: SiteInfo }`
- **Steps:** fetch each page's HTML → strip nav/footer/scripts with cheerio, extract main content text → extract `PageInfo` → call Claude Haiku 4.5 once with all pages batched together → return classified summaries
- **Returns:** `{ results: PageSummary[], failures: { url, error }[] }`
- **Timeout:** ~15s (HTTP fetches + one batched Claude call)

### `POST /api/assemble`

Takes all page summaries and produces the final llms.txt.

- **Input:** `{ pages: PageSummary[], entryUrl, site: SiteInfo, apiKey }`
- **Steps:** call Claude with flat page list (including [SUPPLEMENTARY] flags) → generates H1, blockquote, invents H2 sections from content, places all supplementary pages under ## Optional
- **Returns:** `{ llmsTxt: string }`
- **Timeout:** `maxDuration = 60` (single Claude call, but output generation for large page counts can take 30-60s)

## Client state machine

The UI is driven by a `useReducer` state machine in `app/page.tsx`:

```
idle ──► discovering ──► summarizing ──► assembling ──► complete
              │               │               │
              └───────────────┴───────────────┴──► error

any loading state ──► idle  (via cancel / AbortController)
```

| State         | UI                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------- |
| `idle`        | URL input form + API key field                                                            |
| `discovering` | Spinner, progress bar at 5%                                                               |
| `summarizing` | Progress bar (completed/total), scrolling list of results; amber rate-limit banner on 429 |
| `assembling`  | Pulsing progress bar at 100%                                                              |
| `complete`    | Editable textarea, copy/download buttons, stats; rate-limit notice if pages were skipped  |
| `error`       | Error message with "Try again" link                                                       |

## Concurrency and timeouts

**Client-side fan-out:** Step 2 batches URLs into groups of 20 (`SUMMARIZE_BATCH_SIZE`) and fans out via a concurrency limiter (`concurrency=10`, `minTime=200ms`) in `app/_state/pipeline.ts`. Each batch is a single attempt (no retries). A 429 from any batch aborts remaining queued batches via a shared AbortController; already-in-flight batches complete. The pipeline continues to assemble with whatever pages succeeded and shows a rate-limit banner.

**Cancellation:** An `AbortController` is created per submission. Calling cancel aborts all in-flight fetches and drops all queued jobs immediately.

**Crawl timeout** (in `server/lib/crawler/consts.ts`): all HTTP requests during discovery use a single `CRAWL_TIMEOUT_MS = 5000` timeout.

**BFS concurrency:** 50 concurrent fetches (`BFS_CONCURRENCY`) with max depth 3.

## URL discovery (`server/lib/crawler/discover.ts`)

Two strategies, tried in order:

1. **Sitemap** — fetch `/sitemap.xml`, parse entries, follow sitemap index files (up to 5 children). Entries are ranked by `<priority>` and `<lastmod>` then capped at `maxPages × 3`.
2. **BFS** — if no sitemap is found, crawl links breadth-first from the root URL up to depth 3, with 50 concurrent fetches. Cap at `maxPages × 3`.

The 3× over-provision accounts for pages filtered out later (robots, deduplication, shell pages).

## LLM integration (`server/lib/llm.ts`)

Two functions, both using Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) via the `@anthropic-ai/sdk`:

- **`summarizePageBatch`** — batched tagger: takes multiple `PageInfo` + extracted text (each truncated to 6k chars) + `SiteInfo` in a single LLM call. Returns a `PageSummary[]` with title, summary, and isSupplementary per page. The system prompt uses `cache_control` so it's cached across calls.
- **`assembleWithLlm`** — receives flat list of all pages (with [SUPPLEMENTARY] flag), invents H2 section names from content, groups logically, and places supplementary pages under ## Optional. Produces the complete llms.txt markdown.

**Token budget & page cap:** The assembly output budget is `pageCount × 100 + 1000` tokens, capped at the model's 64k max output. This means the practical ceiling is ~640 pages — beyond that, the output will be truncated. The UI warns users to stay under 600 pages for this reason.

The user provides their own Claude API key at runtime. It is passed through to each endpoint in the request body and never stored or logged.

## llms.txt spec compliance

The generated output follows the [llmstxt.org spec](https://llmstxt.org) (see `LLMSTXT_SPEC.md`):

- Exactly one H1 (site name)
- Optional blockquote with site description
- H2 sections as "file lists" of `- [Title](url): description` links
- `## Optional` reserved as last section for secondary/skippable pages (changelog, legal, about, etc.)

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
```

Integration tests in `app/_state/__tests__/` cover the full pipeline (`pipeline.test.ts`), reducer state transitions (`reducer.test.ts`), and API helpers (`api.test.ts`): discovery failures, summarize failures, rate-limit graceful degradation, assemble errors, abort handling, and happy-path completion.
