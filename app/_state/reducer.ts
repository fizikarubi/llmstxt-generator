import type {
  AppState,
  CrawlStats,
  DiscoveryMethod,
  PageFailure,
  PageSummary,
} from '@/shared/types';

export type Action =
  | { type: 'START_DISCOVER' }
  | {
      type: 'START_SUMMARIZE_PAGES';
      total: number;
      discoveryMethod: DiscoveryMethod;
    }
  | { type: 'SUMMARIZE_PAGE_DONE'; page: PageSummary }
  | { type: 'SUMMARIZE_PAGE_FAILED'; url: string; error: string; retrying: boolean }
  | { type: 'SUMMARIZE_PAGE_RETRYING'; url: string }
  | { type: 'SUMMARIZE_PAGE_RETRY_SUCCESS'; url: string; page: PageSummary }
  | { type: 'SUMMARIZE_PAGE_RETRY_EXHAUSTED'; url: string }
  | { type: 'START_ASSEMBLE' }
  | {
      type: 'COMPLETE';
      llmsTxt: string;
      stats: CrawlStats;
      failures: PageFailure[];
    }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' };

export const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'START_DISCOVER':
      return { status: 'discovering' };
    case 'START_SUMMARIZE_PAGES':
      return {
        status: 'summarizing',
        progress: {
          pages: [],
          failures: [],
          completed: 0,
          total: action.total,
          discoveryMethod: action.discoveryMethod,
        },
      };
    case 'SUMMARIZE_PAGE_DONE': {
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
    case 'SUMMARIZE_PAGE_FAILED': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          failures: [
            ...p.failures,
            { url: action.url, error: action.error, retrying: action.retrying },
          ],
          completed: p.completed + 1,
        },
      };
    }
    case 'SUMMARIZE_PAGE_RETRYING': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          failures: p.failures.map((f) =>
            f.url === action.url ? { ...f, retrying: true } : f,
          ),
        },
      };
    }
    case 'SUMMARIZE_PAGE_RETRY_SUCCESS': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          pages: [...p.pages, action.page],
          failures: p.failures.filter((f) => f.url !== action.url),
        },
      };
    }
    case 'SUMMARIZE_PAGE_RETRY_EXHAUSTED': {
      if (state.status !== 'summarizing') return state;
      const p = state.progress;
      return {
        status: 'summarizing',
        progress: {
          ...p,
          failures: p.failures.map((f) =>
            f.url === action.url ? { ...f, retrying: false } : f,
          ),
        },
      };
    }
    case 'START_ASSEMBLE':
      return { status: 'assembling' };
    case 'COMPLETE':
      return {
        status: 'complete',
        llmsTxt: action.llmsTxt,
        stats: action.stats,
        failures: action.failures,
      };
    case 'ERROR':
      return { status: 'error', message: action.message };
    case 'RESET':
      return { status: 'idle' };
    default:
      return state;
  }
};
