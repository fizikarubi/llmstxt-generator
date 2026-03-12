import { describe, it, expect } from 'vitest';
import type { AppState, PageSummary } from '@/shared/types';
import { reducer, type Action } from '../reducer';

const makePage = (n: number): PageSummary => ({
  meta: { pageUrl: `https://example.com/p${n}`, mdUrl: null, description: '' },
  title: `Page ${n}`,
  summary: `Summary ${n}`,
  isSupplementary: false,
});

const summarizingState = (overrides = {}): AppState => ({
  status: 'summarizing',
  progress: {
    pages: [],
    failures: [],
    completed: 0,
    total: 5,
    discoveryMethod: 'sitemap',
    rateLimited: false,
    ...overrides,
  },
});

describe('reducer', () => {
  // ── Phase transitions ────────────────────────────────────────────────────

  it('START_DISCOVER_PHASE → discovering', () => {
    const state = reducer({ status: 'idle' }, { type: 'START_DISCOVER_PHASE' });
    expect(state.status).toBe('discovering');
  });

  it('START_SUMMARIZE_PHASE → summarizing with correct initial progress', () => {
    const state = reducer(
      { status: 'discovering' },
      { type: 'START_SUMMARIZE_PHASE', total: 10, discoveryMethod: 'bfs' },
    );
    expect(state.status).toBe('summarizing');
    if (state.status === 'summarizing') {
      expect(state.progress.total).toBe(10);
      expect(state.progress.discoveryMethod).toBe('bfs');
      expect(state.progress.pages).toEqual([]);
      expect(state.progress.failures).toEqual([]);
      expect(state.progress.completed).toBe(0);
      expect(state.progress.rateLimited).toBe(false);
    }
  });

  it('START_ASSEMBLE_PHASE → assembling', () => {
    const state = reducer(summarizingState(), { type: 'START_ASSEMBLE_PHASE' });
    expect(state.status).toBe('assembling');
  });

  it('COMPLETE → complete with data', () => {
    const state = reducer(
      { status: 'assembling' },
      {
        type: 'COMPLETE',
        llmsTxt: '# Test',
        stats: { summarized: 5, elapsedMs: 1000 },
        failures: [],
        rateLimited: false,
      },
    );
    expect(state.status).toBe('complete');
    if (state.status === 'complete') {
      expect(state.llmsTxt).toBe('# Test');
      expect(state.stats.summarized).toBe(5);
      expect(state.failures).toEqual([]);
      expect(state.rateLimited).toBe(false);
    }
  });

  it('COMPLETE stores rateLimited flag', () => {
    const state = reducer(
      { status: 'assembling' },
      {
        type: 'COMPLETE',
        llmsTxt: '# Test',
        stats: { summarized: 3, elapsedMs: 500 },
        failures: [{ url: 'https://example.com/x', error: '429' }],
        rateLimited: true,
      },
    );
    expect(state.status).toBe('complete');
    if (state.status === 'complete') {
      expect(state.rateLimited).toBe(true);
    }
  });

  it('ERROR → error with message', () => {
    const state = reducer({ status: 'discovering' }, { type: 'ERROR', message: 'boom' });
    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.message).toBe('boom');
    }
  });

  it('RESET → idle', () => {
    const state = reducer({ status: 'error', message: 'x' }, { type: 'RESET' });
    expect(state.status).toBe('idle');
  });

  // ── Summarize batch actions ──────────────────────────────────────────────

  it('SUMMARIZE_BATCH_DONE adds page and increments completed', () => {
    const page = makePage(1);
    const state = reducer(summarizingState(), {
      type: 'SUMMARIZE_BATCH_DONE',
      page,
    });
    if (state.status === 'summarizing') {
      expect(state.progress.pages).toEqual([page]);
      expect(state.progress.completed).toBe(1);
    }
  });

  it('SUMMARIZE_BATCH_DONE is a no-op when not summarizing', () => {
    const state = reducer(
      { status: 'idle' },
      {
        type: 'SUMMARIZE_BATCH_DONE',
        page: makePage(1),
      },
    );
    expect(state.status).toBe('idle');
  });

  it('SUMMARIZE_BATCH_FAILED adds failure and increments completed', () => {
    const state = reducer(summarizingState(), {
      type: 'SUMMARIZE_BATCH_FAILED',
      url: 'https://example.com/x',
      error: 'timeout',
    });
    if (state.status === 'summarizing') {
      expect(state.progress.failures).toEqual([
        { url: 'https://example.com/x', error: 'timeout' },
      ]);
      expect(state.progress.completed).toBe(1);
    }
  });

  // ── Rate-limit action ──────────────────────────────────────────────────

  it('RATE_LIMITED sets progress.rateLimited to true', () => {
    const state = reducer(summarizingState(), { type: 'RATE_LIMITED' });
    expect(state.status).toBe('summarizing');
    if (state.status === 'summarizing') {
      expect(state.progress.rateLimited).toBe(true);
    }
  });

  it('RATE_LIMITED is a no-op when not summarizing', () => {
    const state = reducer({ status: 'idle' }, { type: 'RATE_LIMITED' });
    expect(state.status).toBe('idle');
  });

  // ── Unknown action ─────────────────────────────────────────────────────

  it('returns same state for unknown action type', () => {
    const state = { status: 'idle' as const };
    const result = reducer(state, { type: 'UNKNOWN' } as unknown as Action);
    expect(result).toBe(state);
  });

  // ── Sequential action replay ─────────────────────────────────────────

  it('handles full lifecycle sequence', () => {
    const actions: Action[] = [
      { type: 'START_DISCOVER_PHASE' },
      { type: 'START_SUMMARIZE_PHASE', total: 2, discoveryMethod: 'sitemap' },
      { type: 'SUMMARIZE_BATCH_DONE', page: makePage(1) },
      { type: 'SUMMARIZE_BATCH_DONE', page: makePage(2) },
      { type: 'START_ASSEMBLE_PHASE' },
      {
        type: 'COMPLETE',
        llmsTxt: '# Test',
        stats: { summarized: 2, elapsedMs: 500 },
        failures: [],
        rateLimited: false,
      },
    ];

    const final = actions.reduce<AppState>((s, a) => reducer(s, a), { status: 'idle' });
    expect(final.status).toBe('complete');
    if (final.status === 'complete') {
      expect(final.stats.summarized).toBe(2);
    }
  });
});
