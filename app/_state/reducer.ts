import type {
  AppState,
  CrawlStats,
  DiscoveryMethod,
  PageFailure,
  PageSummary,
} from '@/shared/types';

export type Action =
  // Phase 1: transition to discovering state
  | { type: 'START_DISCOVER_PHASE' }
  // Phase 2: discovery done, begin summarizing N pages
  | {
      type: 'START_SUMMARIZE_PHASE';
      total: number;
      discoveryMethod: DiscoveryMethod;
    }
  // A single batch completed — add its summary to results
  | { type: 'SUMMARIZE_BATCH_DONE'; page: PageSummary }
  // A batch failed — record the error
  | { type: 'SUMMARIZE_BATCH_FAILED'; url: string; error: string }
  // Phase 3: all summaries collected, begin final assembly
  | { type: 'START_ASSEMBLE_PHASE' }
  // Pipeline complete — store the generated llms.txt and stats
  | {
      type: 'COMPLETE';
      llmsTxt: string;
      stats: CrawlStats;
      failures: PageFailure[];
      rateLimited: boolean;
    }
  // A 429 was received — flag the summarize phase as rate-limited
  | { type: 'RATE_LIMITED' }
  // Unrecoverable error at any phase
  | { type: 'ERROR'; message: string }
  // User cancelled or wants to start over
  | { type: 'RESET' };

export const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'START_DISCOVER_PHASE':
      return { status: 'discovering' };
    case 'START_SUMMARIZE_PHASE':
      return {
        status: 'summarizing',
        progress: {
          pages: [],
          failures: [],
          completed: 0,
          total: action.total,
          discoveryMethod: action.discoveryMethod,
          rateLimited: false,
        },
      };
    case 'SUMMARIZE_BATCH_DONE': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          pages: [...p.pages, action.page],
          completed: p.completed + 1,
        },
      };
    }
    case 'SUMMARIZE_BATCH_FAILED': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          failures: [...p.failures, { url: action.url, error: action.error }],
          completed: p.completed + 1,
        },
      };
    }
    case 'RATE_LIMITED': {
      if (state.status !== 'summarizing') return state;
      return {
        status: 'summarizing',
        progress: { ...state.progress, rateLimited: true },
      };
    }
    case 'START_ASSEMBLE_PHASE':
      return { status: 'assembling' };
    case 'COMPLETE':
      return {
        status: 'complete',
        llmsTxt: action.llmsTxt,
        stats: action.stats,
        failures: action.failures,
        rateLimited: action.rateLimited,
      };
    case 'ERROR':
      return { status: 'error', message: action.message };
    case 'RESET':
      return { status: 'idle' };
    default:
      return state;
  }
};
