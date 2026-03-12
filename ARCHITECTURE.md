# Architecture

llms.txt generator — crawl any website and produce a spec-compliant [llms.txt](https://llmstxt.org) file using Claude for summarization.

## High-level flow

The app uses a **fan-out architecture** to avoid serverless function timeouts. Instead of one long-running function, the work is split across three short-lived endpoints orchestrated by the client.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Client (app/page.tsx)                                               │
│                                                                      │
│  1. POST /api/discover     ──►  { urls: string[] }                   │
│                                                                      │
│  2. POST /api/summarize-batch ──► { results, failures }    ×N        │
│     (fan-out, batchSize=20, concurrency=10)                          │
│     progress bar = completed / total                                 │
│                                                                      │
│  3. POST /api/assemble     ──►  { llmsTxt: string }                  │
│     (single call with all page summaries)                            │
└──────────────────────────────────────────────────────────────────────┘
```

Each serverless function completes in under 30 seconds. No SSE or streaming is needed — the client tracks progress by counting resolved promises from step 2.

## Project structure

```
app/
├── page.tsx                    # Top-level UI, useReducer state machine
├── layout.tsx
├── _state/
│   ├── orchestrator.ts         # Client-side pipeline (discover → summarize → assemble)
│   ├── reducer.ts              # State machine reducer + action types
│   └── __tests__/
│       └── orchestrator.test.ts
├── api/
│   ├── discover/route.ts       # Endpoint 1: URL discovery
│   ├── summarize-batch/route.ts # Endpoint 2: batch summarize
│   └── assemble/route.ts       # Endpoint 3: final assembly

components/
├── UrlInput.tsx                # URL + API key form, maxPages slider
├── CrawlProgress.tsx           # Progress bar + page list
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

| State         | UI                                                        |
| ------------- | --------------------------------------------------------- |
| `idle`        | URL input form + API key field                            |
| `discovering` | Spinner, progress bar at 5%                               |
| `summarizing` | Progress bar (completed/total), scrolling list of results |
| `assembling`  | Pulsing progress bar at 100%                              |
| `complete`    | Editable textarea, copy/download buttons, stats           |
| `error`       | Error message with "Try again" link                       |

## Concurrency and timeouts

**Client-side fan-out:** Step 2 batches URLs into groups of 20 (`SUMMARIZE_BATCH_SIZE`) and fans out via Bottleneck (`concurrency=10`, `minTime=200ms`) in `app/_state/orchestrator.ts`. Per-batch retry with `async-retry` (3 attempts, exponential backoff 200ms→5s with jitter).

**Cancellation:** An `AbortController` is created per submission. Calling cancel aborts all in-flight fetches and tells Bottleneck to drop queued jobs immediately.

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

Integration tests in `app/_state/__tests__/orchestrator.test.ts` cover the full pipeline: discovery failures, summarize retries/exhaustion, assemble errors, abort handling, and happy-path completion.
