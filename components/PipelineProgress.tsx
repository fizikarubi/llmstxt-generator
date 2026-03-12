'use client';

import { useMemo, useState } from 'react';
import type { AppState } from '@/shared/types';

type LoadingState = Extract<
  AppState,
  { status: 'discovering' | 'summarizing' | 'assembling' }
>;

interface Props {
  state: LoadingState;
  onCancel: () => void;
}

const RetryingItem = ({ url }: { url: string }) => (
  <div className="flex items-start gap-2 text-xs">
    <span className="mt-0.5 animate-pulse text-amber-400">↻</span>
    <div className="min-w-0 flex-1">
      <p className="truncate text-amber-400/70">{url}</p>
    </div>
    <span className="shrink-0 text-amber-400/50">retrying…</span>
  </div>
);

const FailedItem = ({ url, error }: { url: string; error: string }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div key={url} className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-2 text-left"
      >
        <span className="mt-0.5 text-red-400">✗</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-red-400/70">{url}</p>
        </div>
        <span className="mt-0.5 shrink-0 text-zinc-600">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <p className="ml-5 mt-1 break-words rounded bg-red-950/40 px-2 py-1 text-red-400/60">
          {error}
        </p>
      )}
    </div>
  );
};

const PipelineProgress = ({ state, onCancel }: Props) => {
  const progress = state.status === 'summarizing' ? state.progress : null;
  const pct = progress ? Math.round((progress.completed / progress.total) * 100) : 0;

  const { retrying, failed } = useMemo(() => {
    const retrying: { url: string }[] = [];
    const failed: { url: string; error: string }[] = [];
    if (progress) {
      for (const f of progress.failures) {
        (f.retrying ? retrying : failed).push(f);
      }
    }
    return { retrying, failed };
  }, [progress]);

  const statusParts = [
    retrying.length > 0 ? `${retrying.length} retrying` : '',
    failed.length > 0 ? `${failed.length} failed` : '',
  ].filter(Boolean);
  const label =
    state.status === 'discovering'
      ? 'Discovering pages…'
      : state.status === 'assembling'
        ? 'Assembling llms.txt…'
        : `Summarizing pages (${progress!.completed}/${progress!.total})${statusParts.length > 0 ? ` · ${statusParts.join(', ')}` : ''}`;

  const barWidth =
    state.status === 'discovering'
      ? '5%'
      : state.status === 'assembling'
        ? '100%'
        : `${pct}%`;

  const allItems = progress
    ? [
        ...retrying.map((f) => ({ type: 'retrying' as const, url: f.url })),
        ...failed.map((f) => ({
          type: 'failed' as const,
          url: f.url,
          error: f.error,
        })),
        ...[...progress.pages].reverse().map((page) => ({ type: 'ok' as const, page })),
      ]
    : [];

  const isBfs = progress?.discoveryMethod === 'bfs';

  return (
    <div className="w-full max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-white">{label}</p>
          {progress && (
            <p className="text-xs text-zinc-500">
              {isBfs
                ? 'No sitemap found — pages were discovered via link crawling.'
                : 'Found sitemap — using URLs from there.'}
            </p>
          )}
        </div>
        <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>

      <div className="h-1 w-full rounded-full bg-zinc-800">
        <div
          className={`h-1 rounded-full transition-all duration-300 ${
            state.status === 'assembling' ? 'animate-pulse bg-blue-400' : 'bg-white'
          }`}
          style={{ width: barWidth }}
        />
      </div>

      {allItems.length > 0 && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          {allItems.map((item) =>
            item.type === 'retrying' ? (
              <RetryingItem key={item.url} url={item.url} />
            ) : item.type === 'ok' ? (
              <div
                key={item.page.meta.pageUrl}
                className="flex items-start gap-2 text-xs"
              >
                <span className="mt-0.5 text-green-400">✓</span>
                <div className="min-w-0">
                  <p className="truncate text-zinc-300">{item.page.title}</p>
                  <p className="truncate text-zinc-600">{item.page.meta.pageUrl}</p>
                </div>
                {item.page.isSupplementary && (
                  <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500">
                    Optional
                  </span>
                )}
              </div>
            ) : (
              <FailedItem key={item.url} url={item.url} error={item.error} />
            ),
          )}
        </div>
      )}
    </div>
  );
};

export default PipelineProgress;
