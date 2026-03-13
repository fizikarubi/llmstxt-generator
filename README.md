# llmstxt-generator

A web app that generates spec-compliant [llms.txt](https://llmstxt.org) files automatically. Give it a URL, and it crawls the site, summarizes every page with Claude, and assembles a structured llms.txt output. Handles sites with 500+ pages in ~200 seconds. Works with server-rendered HTML sites — JavaScript-only SPAs are detected and skipped.

**Live app:** [llmstxt-generator-eta.vercel.app](https://llmstxt-generator-eta.vercel.app/)

## Demo

https://github.com/user-attachments/assets/941a2839-7537-4b26-afc6-1526ff417972

## Architecture

The browser orchestrates three short-lived serverless endpoints in sequence — no Redis, no queue, no workers:

1. **Discover** — crawl the site via sitemap (preferred) or BFS fallback with 20 concurrent fetches (rate-limited to 20 req/s), max depth 2. Filter, deduplicate, and normalize URLs.
2. **Summarize** — chunk discovered URLs into batches of 10 and fan out concurrent requests (configurable, default 10) to a serverless function. Each batch fetches pages, extracts text, and summarizes them via Claude Haiku in a single LLM call. A 429 from any batch stops the queue and assembles with whatever pages succeeded.
3. **Assemble** — aggregate all page summaries and send them to Claude in one call to generate the final structured llms.txt. Haiku's 64k output token limit caps practical output at ~600 pages.

```
User enters URL
     │
     ▼
┌────────────────────────────────────────────────────────────┐
│ Browser Pipeline (useReducer state machine)                │
│                                                            │
│ ┌──────────┐    ┌───────────────┐    ┌──────────┐          │
│ │ Discover │───►│ Summarize ×N  │───►│ Assemble │          │
│ └──────────┘    └───────────────┘    └──────────┘          │
│              ⤫ abortable at any phase                      │
└─────┼───────────────────┼───────────────────┼──────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
┌───────────┐    ┌─────────────────┐    ┌────────────────┐
│ sitemap OR│    │ extract text    │    │ Haiku groups   │
│ BFS crawl │    │ from URL        │    │ all summaries  │
│           │    │ Haiku batch     │    │ (64K token max)│
│ → URLs[]  │    │ summarize       │    │                │
└───────────┘    │                 │    │ → llms.txt     │
                 │ 10 concurrent   │    └────────────────┘
                 │ 429 → skip rest │
                 │                 │
                 │ → Summary[]     │
                 └─────────────────┘
```

### Key highlights

- **Stateless backend** — the browser drives the pipeline via `useReducer`; serverless functions are pure request/response with no shared state
- **Graceful degradation** — a 429 from any batch stops the queue and assembles with whatever succeeded; individual page failures don't block the rest
- **Configurable concurrency** — users tune parallelism from the UI; p-queue enforces the limit across batches
- **Cancellable at any phase** — one `AbortController` propagates through fetches, the job queue, and retries
- **Traced requests** — every request gets a UUID; `withTrace` logs START/END/ERROR spans via Pino

For the full system design, state machine, endpoint contracts, and project structure, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Getting started

### Prerequisites

- Node.js 18+
- A [Claude API key](https://console.anthropic.com/)

### Setup

```bash
git clone https://github.com/your-username/llmstxt-generator.git
cd llmstxt-generator
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), enter a website URL and your API key, and generate.

### Deploy

Push to Vercel — no additional configuration needed:

```bash
vercel
```

## Scripts

| Command              | Description                     |
| -------------------- | ------------------------------- |
| `npm run dev`        | Start dev server                |
| `npm run build`      | Production build                |
| `npm test`           | Run tests (Vitest)              |
| `npm run test:watch` | Tests in watch mode             |
| `npm run typecheck`  | Type-check with `tsc --noEmit`  |
| `npm run lint`       | Check formatting (Prettier)     |
| `npm run format`     | Auto-format all files           |
| `npm run generate`   | CLI script to generate llms.txt |

## Tech stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript (full stack, shared types)
- **LLM:** Claude Haiku via `@anthropic-ai/sdk`
- **Concurrency:** rate-limited fan-out via p-queue
- **Crawling:** cheerio, robots-parser, fast-xml-parser
- **Styling:** Tailwind CSS
- **Testing:** Vitest
- **Hosting:** Vercel (serverless)

## Known limitations

- **No resume** — closing the tab loses the crawl; there's no persistent state
- **No caching** — re-crawling the same site starts from scratch every time
- **No SPA support** — JavaScript-rendered pages are detected and skipped; only server-rendered HTML is supported
- **Output length cap** — Haiku's 64k max output token limit caps the final llms.txt at ~600 pages

## Future improvement

### UX

- **Selective crawling** — review discovered URLs and check/uncheck pages before summarization starts
- **URL pattern matching** — glob or regex rules like `/docs/**` or `!/docs/archive/*` for inclusion/exclusion
- **Discovery progress** — show live URL count during the discover phase instead of a static spinner
- **Run history** — persist past generations to localStorage or server so users can revisit without re-crawling

### Output quality

- **Model selection** — choose Haiku (fast/cheap) vs Sonnet (better summaries) for summarization and/or assembly
- **Custom instructions** — user-provided prompt additions for how pages should be summarized or sections organized

### Reliability

- **Smarter rate-limit recovery** — on 429, pause and retry on remaining batches instead of giving up
- **Stateful resume** — persist crawl state to localStorage or a server-side store so users can resume after disconnect

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, endpoints, state machine, concurrency model
- [LLMSTXT_SPEC.md](LLMSTXT_SPEC.md) — the llms.txt specification reference
