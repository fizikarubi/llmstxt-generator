# llmstxt-generator

A web app that generates spec-compliant [llms.txt](https://llmstxt.org) files automatically. Give it a URL, and it crawls the site, summarizes every page with Claude, and assembles a structured llms.txt output. Handles sites with 500+ pages in ~200 seconds. Works with server-rendered HTML sites — JavaScript-only SPAs are detected and skipped.

**Live app:** [llmstxt-generator-eta.vercel.app](https://llmstxt-generator-eta.vercel.app/)

## Demo

https://github.com/user-attachments/assets/941a2839-7537-4b26-afc6-1526ff417972

## Architecture

The browser orchestrates three short-lived serverless endpoints in sequence — no Redis, no queue, no workers:

1. **Discover** — crawl the site via sitemap (preferred) or BFS fallback with 50 concurrent fetches, max depth 3. Filter, deduplicate, and normalize URLs.
2. **Summarize** — chunk discovered URLs into batches of 20 and fan out concurrent requests (configurable, default 10) to a serverless function. Each batch fetches pages, extracts text, and summarizes them via Claude Haiku in a single LLM call. Failed batches retry with exponential backoff + jitter.
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
      ▼                   ▼                     ▼
┌───────────┐    ┌─────────────────┐    ┌────────────────┐
│ sitemap OR│    │ extract text    │    │ Haiku groups   │
│ BFS crawl │    │ from URL        │    │ all summaries  │
│           │    │ Haiku batch     │    │ (64K token max)│
│ → URLs[]  │    │ summarize       │    │                │
└───────────┘    │                 │    │ → llms.txt     │
                 │ 10 concurrent   │    └────────────────┘
                 │ retry + backoff │
                 │                 │
                 │ → Summary[]     │
                 └─────────────────┘
```

### Key highlights

- **Client-side orchestration** — the browser coordinates the entire pipeline via a `useReducer` state machine (6 states, ~12 action types), keeping the backend fully stateless
- **Concurrency control** — rate-limited fan-out (configurable concurrency + minTime throttle) with per-batch retry via async-retry and exponential backoff with jitter
- **Partial failure tolerance** — uses `Promise.allSettled` so a crawl succeeds even if some pages fail; only errors if zero pages return
- **Abort propagation** — a single `AbortController` cancels in-flight fetches, drains the job queue, and cleanly exits retries
- **Shared TypeScript contracts** — request/response types defined once in `shared/types.ts`, imported by both client and server, with discriminated unions ensuring exhaustive state handling
- **Structured observability** — every request gets a UUID trace ID via Pino; `withTrace` wraps async functions with automatic START/END/ERROR logging

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
- **Concurrency:** rate-limited fan-out + async-retry
- **Crawling:** cheerio, robots-parser, fast-xml-parser
- **Styling:** Tailwind CSS
- **Testing:** Vitest
- **Hosting:** Vercel (serverless)

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, endpoints, state machine, concurrency model
- [LLMSTXT_SPEC.md](LLMSTXT_SPEC.md) — the llms.txt specification reference
