# Architecture

llms.txt generator — crawl any website and produce a spec-compliant [llms.txt](https://llmstxt.org) file using Claude for summarization. Works with server-rendered HTML sites; JavaScript-only SPAs are detected and skipped during both discovery and summarization.

## High-level flow

The app uses a **fan-out architecture** to avoid serverless function timeouts. Instead of one long-running function, the work is split across three short-lived endpoints orchestrated by the client:

1. **Discover** — crawl the site via sitemap (preferred) or BFS fallback with 20 concurrent fetches (rate-limited to 20 req/s), max depth 2. Check robots.txt, filter, deduplicate, and normalize URLs. Over-provisions by 1.3× to account for pages lost to filtering.
2. **Summarize** — chunk discovered URLs into batches of 10 and fan out up to 10 concurrent requests to a serverless function. Each function invocation fetches the pages' HTML, extracts text with cheerio, and summarizes the entire batch via Claude Haiku in a single LLM call. A 429 from any batch aborts remaining batches; the pipeline continues to assemble with whatever pages succeeded.
3. **Assemble** — aggregate all page summaries and send them to Claude in one streaming call. The LLM groups pages into logical H2 sections and places supplementary pages under `## Optional`. Haiku's 64k output token limit caps practical output at ~600 pages.

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
 ├────────────┤    │ -batch        │    ├─────────────┤
 │ robots.txt │    ├───────────────┤    │ all page    │
 │ sitemap or │    │ extract text  │    │ summaries   │
 │ BFS crawl  │    │ from URL      │    │ → Haiku     │
 │            │    │ Haiku batch   │    │ → llms.txt  │
 │ → urls[]   │    │ summarize     │    └─────────────┘
 └────────────┘    │               │
                   │ batch: 10     │
                   │ concurrency:10│
                   │ 429 → partial │
                   │               │
                   │ → summaries[] │
                   └───────────────┘
```

Each serverless function completes within its timeout (discover: 60s, summarize: default, assemble: default). No SSE or streaming to the client — the client tracks progress by counting resolved promises from step 2.

## Project structure

```
app/
├── page.tsx                    # Top-level UI, useReducer state machine
├── layout.tsx
├── _state/
│   ├── pipeline.ts             # Client-side pipeline (discover → summarize → assemble)
│   ├── reducer.ts              # State machine reducer + action types
│   ├── api.ts                  # HTTP client helpers (postApi, postApiWithRetry)
│   └── __tests__/
│       ├── pipeline.test.ts
│       ├── reducer.test.ts
│       └── api.test.ts
├── api/
│   ├── discover/route.ts       # Endpoint 1: URL discovery
│   ├── summarize-batch/route.ts # Endpoint 2: batch summarize
│   └── assemble/route.ts       # Endpoint 3: final assembly

components/
├── UrlInput.tsx                # URL + API key form, concurrency/maxPages sliders
├── PipelineProgress.tsx        # Progress bar + page list
└── OutputPreview.tsx           # Editable output, copy/download

server/
├── lib/
│   ├── anthropic.ts            # Claude API wrapper (summarizePages, assemblePageSumamaries)
│   ├── discovery.ts            # URL discovery (sitemap + BFS fallback)
│   ├── fetcher.ts              # HTTP fetch (fetchHtml, fetchRobots, probeMarkdownUrls)
│   ├── html.ts                 # HTML parsing (extractSiteInfo, extractText, isSpaShell)
│   ├── consts.ts               # USER_AGENT, FETCH_TIMEOUT_MS
│   ├── logger.ts               # Pino logger with trace ID mixin
│   ├── errors.ts               # AppError class + helpers
│   ├── usecase.ts              # UseCase<TInput, TOutput> interface
│   ├── context.ts              # Request context (trace ID)
│   └── __tests__/
│       ├── discovery-pure.test.ts
│       └── html.test.ts
└── usecases/
    ├── discover.ts             # DiscoverUseCase
    ├── summarize-batch.ts      # SummarizeBatchUseCase
    ├── assemble.ts             # AssembleUseCase
    └── __tests__/
        ├── summarize-batch.test.ts
        └── assemble.test.ts

shared/
└── types.ts                    # All shared types (API contracts, UI state)
```

## Three endpoints

### `POST /api/discover`

Finds crawlable URLs for a given site.

- **Input:** `{ url, maxPages? }`
- **Steps:** check robots.txt → SPA detection → extract site info from root page → discover URLs via sitemap.xml (preferred) or BFS link crawling → filter by robots + deduplicate → cap at `maxPages`
- **Returns:** `{ urls: string[], site: SiteInfo, method: 'sitemap' | 'bfs' }`
- **Timeout:** `maxDuration = 60`

### `POST /api/summarize-batch`

Fetches a batch of pages and generates LLM summaries in a single call.

- **Input:** `{ urls: string[], apiKey, site: SiteInfo }`
- **Steps:** fetch each page's HTML + probe for `.md` URLs in parallel → strip nav/footer/scripts with cheerio, extract main content text → reject SPA shells (<100 chars) → call Claude Haiku 4.5 once with all pages batched together → return classified summaries
- **Returns:** `{ summaries: PageSummary[], failures: { url, error }[] }`
- **Timeout:** default (no explicit `maxDuration`)

### `POST /api/assemble`

Takes all page summaries and produces the final llms.txt.

- **Input:** `{ pages: PageSummary[], entryUrl, site: SiteInfo, apiKey }`
- **Steps:** call Claude with flat page list (including [SUPPLEMENTARY] flags) via streaming → generates H1, blockquote, invents H2 sections from content, places all supplementary pages under ## Optional
- **Returns:** `{ llmsTxt: string }`
- **Timeout:** default (no explicit `maxDuration`)

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

**9 action types:** `START_DISCOVER_PHASE`, `START_SUMMARIZE_PHASE`, `SUMMARIZE_BATCH_DONE`, `SUMMARIZE_BATCH_FAILED`, `RATE_LIMITED`, `START_ASSEMBLE_PHASE`, `COMPLETE`, `ERROR`, `RESET`.

## Concurrency and timeouts

**Client-side fan-out:** Step 2 batches URLs into groups of 10 (`SUMMARIZE_BATCH_SIZE`) and fans out via a p-queue concurrency limiter (`concurrency` configurable, default 10) in `app/_state/pipeline.ts`. Each batch is a single attempt (no retries). A 429 from any batch aborts remaining queued batches via a shared AbortController; already-in-flight batches complete. The pipeline continues to assemble with whatever pages succeeded and shows a rate-limit banner.

**Cancellation:** An `AbortController` is created per submission. Calling cancel aborts all in-flight fetches and drops all queued jobs immediately.

**Fetch timeout** (in `server/lib/consts.ts`): all HTTP requests use `FETCH_TIMEOUT_MS = 5000`.

**BFS concurrency:** 20 concurrent fetches, rate-limited to 20 req/s (`BFS_CONCURRENCY`) with max depth 2.

**Assembly retry:** the assemble call uses `postApiWithRetry` with exponential back-off (3 retries, 200ms min timeout, factor 2, 5s max timeout). Retries on 429 or 5xx; bails immediately on other 4xx.

## URL discovery (`server/lib/discovery.ts`)

Two strategies, tried in order:

1. **Sitemap** — fetch robots.txt-declared sitemaps plus conventional locations (`/sitemap.xml`, `/<path-prefix>/sitemap.xml`). Only flat `<urlset>` sitemaps are parsed; `<sitemapindex>` entries are skipped. Filter and cap at `maxPages`.
2. **BFS** — if sitemap yields 0 results, crawl links breadth-first from the root URL up to depth 2, with 20 concurrent fetches (20 req/s). Each depth level caps queued URLs to avoid fetching thousands when only a few pages are needed. Cap at `maxPages × 1.3`.

The 1.3× over-provision (BFS only) accounts for pages filtered out later by robots and deduplication.

**Filtering rules (shared by both strategies):**

- Same origin (www-normalized: `www.example.com ≡ example.com`)
- Path prefix scoping (root `/docs/intro` scopes discovery to `/docs/**`)
- HTML-only extensions (`.html`, `.htm`, `.php`, `.asp`, `.aspx`, `.jsp`) or extensionless paths
- Excluded paths: `/login`, `/signup`, `/register`, `/account`, `/auth`, `/search`
- No pagination (`?page=N` rejected)
- Case-insensitive prefix matching; original casing preserved
- Deduplicated (strips hash, query, trailing slash)

## LLM integration (`server/lib/anthropic.ts`)

Two functions, both using Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) via the `@anthropic-ai/sdk`:

- **`summarizePages`** — batched tagger: takes multiple pages (each with `PageInfo` + extracted text truncated to 6k chars) + `SiteInfo` in a single LLM call. Returns a `PageSummary[]` with title, summary, and isSupplementary per page. The system prompt uses `cache_control: ephemeral` so it's cached across calls.
- **`assemblePageSumamaries`** — receives flat list of all pages (with [SUPPLEMENTARY] flag), invents H2 section names from content, groups logically, and places supplementary pages under ## Optional. Uses streaming (`client.messages.stream().finalMessage()`). Produces the complete llms.txt markdown.

**Token budget & page cap:** The assembly output budget is `pageCount × 100 + 1000` tokens, capped at the model's 64k max output. This means the practical ceiling is ~640 pages — beyond that, the output will be truncated. The UI warns users to stay under 600 pages for this reason.

The user provides their own Claude API key at runtime. It is passed through to each endpoint in the request body and never stored or logged.

## HTML parsing (`server/lib/html.ts`)

- **`extractSiteInfo`** — site name from `og:site_name` → `<title>` → `<h1>` → hostname. Description from `meta[name="description"]` → `og:description` → first `<main|article> p` → truncated to 250 chars.
- **`extractText`** — removes `<script>`, `<style>`, `<nav>`, `<footer>`, `<iframe>`, `<noscript>`, `<aside>`, `<form>`, `[role="complementary"]`, `[role="banner"]`, `<body> > <header>`. Prefers `<main>`, `<article>`, or `[role="main"]`; falls back to `<body>`. Collapses whitespace.
- **`isSpaShell`** — true if `extractText` yields < 100 visible characters.

## HTTP fetching (`server/lib/fetcher.ts`)

- **`fetchHtml`** — follows redirects, rejects non-HTML content types and cross-origin redirects. Returns final URL + HTML body. Timeout: 5s.
- **`fetchRobots`** — graceful degradation: network error/timeout → allow-all. Returns `RobotsChecker` with `isAllowed(url)` + `sitemaps: string[]`.
- **`probeMarkdownUrls`** — HEAD requests to `<url>.md` and (if extensionless) `<url>/index.html.md`. Returns first 200 response URL, else null.

## llms.txt spec compliance

The generated output follows the [llmstxt.org spec](https://llmstxt.org) (see `LLMSTXT_SPEC.md`):

- Exactly one H1 (site name)
- Optional blockquote with site description
- H2 sections as "file lists" of `- [Title](url): description` links
- `## Optional` reserved as last section for secondary/skippable pages (changelog, legal, about, etc.)
- Links use `.md` URLs when available (probed via HEAD during summarization)

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
```

Tests in `app/_state/__tests__/` cover the full pipeline (`pipeline.test.ts`), reducer state transitions (`reducer.test.ts`), and API helpers (`api.test.ts`): discovery failures, summarize failures, rate-limit graceful degradation, assemble errors, abort handling, and happy-path completion.

Tests in `server/lib/__tests__/` cover URL filtering and discovery logic (`discovery-pure.test.ts`) and HTML parsing (`html.test.ts`).

Tests in `server/usecases/__tests__/` cover the summarize-batch and assemble use cases.
