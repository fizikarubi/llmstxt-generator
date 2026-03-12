// ─── Config ───────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  /** Cap on how many sub-pages to process. `null` = unlimited (bounded only by
   *  what the discovery phase finds). Exposed in the UI so users can do quick
   *  test runs with a small number before committing to a full crawl. */
  maxPages: number | null;
  /** How many summarization batches to run in parallel. Higher = faster but
   *  uses more API quota; lower = gentler on rate limits but takes more time. */
  concurrency: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  maxPages: null,
  concurrency: 10,
};

// ─── Extracted site data (from the site's homepage, once per crawl) ──────────

export interface SiteInfo {
  /** Project / company name. Resolved from og:site_name → <title> → hostname. */
  name: string;
  /** Meta description from the homepage. Seeds the llms.txt blockquote. */
  description: string;
}

// ─── Extracted page data (per page) ──────────────────────────────────────────

export interface PageInfo {
  /** Final URL after following redirects. */
  pageUrl: string;
  /** URL of a `.md` version of this page, if the site serves one. */
  mdUrl: string | null;
  /** Page's meta description. */
  description: string;
}

// ─── LLM-enriched page data ──────────────────────────────────────────────────
//
// PageSummary extends PageInfo with LLM-generated classification. This is the
// unit of data that flows from the summarize phase into the assemble phase.
// The lean shape (title, summary, isSupplementary) enables fast parallel
// tagging; the assembler invents H2 sections from full context.

export interface PageSummary {
  meta: PageInfo;

  /** LLM-generated page title (no site-name prefix). Becomes the link text
   *  in the llms.txt entry: `- [title](url): summary`. */
  title: string;

  /** 1-2 sentence description of the page for LLM consumers. Becomes the
   *  text after the colon in each llms.txt entry. */
  summary: string;

  /** True if this page is secondary/skippable (changelog, legal, about,
   *  pricing, community). The assembler places all such pages under
   *  "## Optional" at the end of the llms.txt. */
  isSupplementary: boolean;
}

// ─── API request / response types ─────────────────────────────────────────────

export interface DiscoverRequest {
  url: string;
  maxPages?: number;
}

export type DiscoveryMethod = 'sitemap' | 'bfs';

export interface DiscoverResponse {
  urls: string[];
  site: SiteInfo;
  method: DiscoveryMethod;
}

export interface SummarizeBatchRequest {
  urls: string[];
  apiKey: string;
  site: SiteInfo;
}

export interface SummarizeBatchResponse {
  results: PageSummary[];
  failures: { url: string; error: string }[];
}

export interface AssembleRequest {
  pages: PageSummary[];
  entryUrl: string;
  site: SiteInfo;
  apiKey: string;
}

export interface AssembleResponse {
  llmsTxt: string;
}

// ─── UI state machine ─────────────────────────────────────────────────────────

export interface CrawlStats {
  summarized: number;
  elapsedMs: number;
}

export interface PageFailure {
  url: string;
  error: string;
  retrying?: boolean;
}

export interface SummarizeProgress {
  pages: PageSummary[];
  failures: PageFailure[];
  completed: number;
  total: number;
  discoveryMethod: DiscoveryMethod;
}

export type AppState =
  | { status: 'idle' }
  | { status: 'discovering' }
  | { status: 'summarizing'; progress: SummarizeProgress }
  | { status: 'assembling' }
  | {
      status: 'complete';
      llmsTxt: string;
      stats: CrawlStats;
      failures: PageFailure[];
    }
  | { status: 'error'; message: string };
