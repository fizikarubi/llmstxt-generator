'use client';

import { useState } from 'react';
import type { CrawlConfig } from '@/shared/types';

interface Props {
  onSubmit: (url: string, config: CrawlConfig, apiKey: string) => void;
  disabled: boolean;
}

const UrlInput = ({ onSubmit, disabled }: Props) => {
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxPages, setMaxPages] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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

    onSubmit(url, { maxPages }, apiKey.trim());
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
            min={0}
            max={1000}
            step={10}
            value={maxPages ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMaxPages(v === 0 ? null : v);
            }}
            className="w-full accent-white"
          />
          <p className="text-xs text-zinc-500">
            Drag to 0 for no limit. Each page uses one API call.
          </p>
          {(maxPages === null || maxPages > 600) && (
            <p className="text-xs text-amber-400">
              We recommend keeping pages under 600. The final llms.txt is
              assembled by Claude Haiku 4.5 (64k max output tokens, ~100
              tokens per page summary). If the output exceeds this limit, the
              result will be truncated.
            </p>
          )}
        </div>
      )}
    </form>
  );
};

export default UrlInput;
