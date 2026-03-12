'use client';

import { useReducer, useRef } from 'react';
import UrlInput from '@/components/UrlInput';
import CrawlProgress from '@/components/CrawlProgress';
import OutputPreview from '@/components/OutputPreview';
import type { AppState, PipelineConfig } from '@/shared/types';
import { reducer } from './_state/reducer';
import { runCrawlPipeline } from './_state/orchestrator';

const Home = () => {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = async (url: string, config: PipelineConfig, apiKey: string) => {
    const abort = new AbortController();
    abortRef.current = abort;
    await runCrawlPipeline(url, config, apiKey, abort.signal, dispatch);
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    dispatch({ type: 'RESET' });
  };

  const isLoading =
    state.status === 'discovering' ||
    state.status === 'summarizing' ||
    state.status === 'assembling';

  return (
    <main className="flex min-h-screen flex-col items-center bg-black px-4 py-16">
      <div className="mb-12 space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          llms.txt generator
        </h1>
        <p className="text-sm text-zinc-500">
          Crawl any website and generate a spec-compliant{' '}
          <a
            href="https://llmstxt.org"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-300"
          >
            llms.txt
          </a>{' '}
          file.
        </p>
      </div>

      {(state.status === 'idle' || isLoading) && (
        <UrlInput onSubmit={handleSubmit} disabled={isLoading} />
      )}

      {isLoading && (
        <div className="mt-8 w-full max-w-2xl">
          <CrawlProgress
            state={state as Exclude<AppState, { status: 'idle' | 'complete' | 'error' }>}
            onCancel={handleCancel}
          />
        </div>
      )}

      {state.status === 'complete' && (
        <OutputPreview state={state} onReset={() => dispatch({ type: 'RESET' })} />
      )}

      {state.status === 'error' && (
        <div className="mt-8 w-full max-w-2xl rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-400">
          {state.message}
          <button
            onClick={() => dispatch({ type: 'RESET' })}
            className="ml-4 underline hover:text-red-300"
          >
            Try again
          </button>
        </div>
      )}
    </main>
  );
};

export default Home;
