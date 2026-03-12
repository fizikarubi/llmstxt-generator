'use client';

import { useRef, useState } from 'react';
import type { AppState } from '@/shared/types';

interface Props {
  state: Extract<AppState, { status: 'complete' }>;
  onReset: () => void;
}

const OutputPreview = ({ state, onReset }: Props) => {
  const [content, setContent] = useState(state.llmsTxt);
  const [copied, setCopied] = useState(false);
  const [showFailures, setShowFailures] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEdited = content !== state.llmsTxt;

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    clearTimeout(copyTimeoutRef.current!);
    setCopied(true);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([content], { type: 'text/plain' })),
      download: 'llms.txt',
    });
    a.click();
  };

  const { summarized, elapsedMs } = state.stats;
  const failed = state.failures.length;

  return (
    <div className="w-full max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">
          <span className="text-white">{summarized}</span> pages ·{' '}
          {failed > 0 && (
            <>
              <button
                onClick={() => setShowFailures(!showFailures)}
                className="text-red-400 underline decoration-red-400/30 hover:decoration-red-400"
              >
                {failed} failed
              </button>{' '}
              ·{' '}
            </>
          )}
          <span className="text-white">{(elapsedMs / 1000).toFixed(1)}s</span>
        </p>
        <button onClick={onReset} className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Start over
        </button>
      </div>

      {state.rateLimited && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-400">
          Rate-limited by the API — some pages were skipped. Try lowering concurrency and
          re-running for complete results.
        </div>
      )}

      {showFailures && state.failures.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-red-900/50 bg-red-950/20 p-3">
          {state.failures.map((f) => (
            <div key={f.url} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0 text-red-400">✗</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-red-400/70">{f.url}</p>
                <p className="truncate text-red-400/50">{f.error}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="h-96 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-4 font-mono text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
        spellCheck={false}
      />

      <div className="flex items-center gap-2">
        <button
          onClick={handleCopy}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          onClick={handleDownload}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
        >
          Download llms.txt
        </button>
        {isEdited && (
          <span className="ml-auto text-xs text-amber-400">
            Edited ·{' '}
            <button
              onClick={() => setContent(state.llmsTxt)}
              className="underline hover:text-amber-300"
            >
              Reset
            </button>
          </span>
        )}
      </div>
    </div>
  );
};

export default OutputPreview;
