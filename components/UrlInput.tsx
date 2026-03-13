'use client';

import { useState } from 'react';
import type { PipelineConfig } from '@/shared/types';

interface Props {
  onSubmit: (url: string, config: PipelineConfig, apiKey: string) => void;
  disabled: boolean;
}

const UrlInput = ({ onSubmit, disabled }: Props) => {
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxPages, setMaxPages] = useState<number | null>(200);
  const [concurrency, setConcurrency] = useState(10);
  const [showSettings, setShowSettings] = useState(true);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError('Claude API key is required');
      return;
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      setError('Enter a valid http/https URL');
      return;
    }

    onSubmit(url, { maxPages, concurrency }, apiKey.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-3">
      <div className="space-y-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setError('');
            setApiKey(e.target.value);
          }}
          placeholder="Claude API key (sk-ant-...)"
          disabled={disabled}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-500 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setError('');
              setUrl(e.target.value);
            }}
            placeholder="https://example.com"
            disabled={disabled}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-500 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={disabled || !url || !apiKey}
            className="rounded-lg bg-white px-5 py-3 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:opacity-40"
          >
            Generate
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Works with server-rendered HTML sites. JavaScript-only SPAs are detected and
        skipped.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="button"
        onClick={() => setShowSettings((s) => !s)}
        className="text-xs text-zinc-500 hover:text-zinc-300"
      >
        {showSettings ? '▲' : '▼'} Settings
      </button>

      {showSettings && (
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <label className="flex items-center justify-between text-sm text-zinc-300">
            <span>Max pages</span>
            <span className="font-mono text-white">{maxPages ?? 'All'}</span>
          </label>
          <input
            type="range"
            min={1}
            max={1001}
            step={10}
            value={maxPages ?? 1001}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMaxPages(v >= 1001 ? null : v);
            }}
            disabled={disabled}
            className="w-full accent-white disabled:opacity-50"
          />
          <p className="text-xs text-zinc-500">
            Drag all the way right for no limit. Each page uses one API call.
          </p>
          <p
            className={`text-xs ${maxPages === null || maxPages > 600 ? 'text-amber-400' : 'text-zinc-500'}`}
          >
            We recommend staying under 600 pages — Haiku&apos;s 64k max output tokens may
            truncate larger results.
          </p>

          <label className="flex items-center justify-between text-sm text-zinc-300">
            <span>Concurrency</span>
            <span className="font-mono text-white">{concurrency}</span>
          </label>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            disabled={disabled}
            className="w-full accent-white disabled:opacity-50"
          />
          <p className="text-xs text-zinc-500">
            How many pages are sent to Claude for summarization at the same time. Higher
            values speed up generation but may hit API rate limits. Lower values are
            slower but more reliable if you're on a limited API plan.
          </p>
        </div>
      )}
    </form>
  );
};

export default UrlInput;
