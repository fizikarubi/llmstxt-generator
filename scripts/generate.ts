/**
 * CLI pipeline: discover → summarize → assemble
 *
 * Usage:
 *   npm run generate discover <url> [--max-pages N]
 *   npm run generate summarize <discover_file.json> --api-key <key>  [--concurrency N]
 *   npm run generate assemble  <summarize_file.json> --api-key <key>
 *
 * Each step writes a JSON file (e.g. discover_a1b2.json) that feeds the next.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Bottleneck from 'bottleneck';
import { newContext } from '@/server/lib/context';
import { discoverUseCase } from '@/server/usecases/discover';
import { summarizeBatchUseCase } from '@/server/usecases/summarize-batch';
import { assembleUseCase } from '@/server/usecases/assemble';
import type { DiscoverResponse, PageSummary, SiteInfo } from '@/shared/types';

const BATCH_SIZE = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => randomBytes(4).toString('hex');

const writeJson = (prefix: string, data: unknown): string => {
  const name = `${prefix}_${uid()}.json`;
  const path = resolve(name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`wrote ${path}`);
  return path;
};

const readJson = <T>(filePath: string): T =>
  JSON.parse(readFileSync(resolve(filePath), 'utf-8')) as T;

const parseFlag = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
};

// ─── Commands ────────────────────────────────────────────────────────────────

const discover = async (args: string[]) => {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: npm run generate discover <url> [--max-pages N]');
    process.exit(1);
  }
  const maxPages = parseFlag(args, '--max-pages');
  const ctx = newContext();
  const result = await discoverUseCase.run(ctx, {
    url,
    ...(maxPages != null && { maxPages: Number(maxPages) }),
  });
  writeJson('discover', result);
};

const summarize = async (args: string[]) => {
  const file = args.find((a) => !a.startsWith('--'));
  const apiKey = parseFlag(args, '--api-key') ?? process.env.ANTHROPIC_API_KEY;
  if (!file || !apiKey) {
    console.error(
      'Usage: npm run generate summarize <discover_file.json> --api-key <key>',
    );
    console.error('       (or set ANTHROPIC_API_KEY env var)');
    process.exit(1);
  }
  const concurrency = Number(parseFlag(args, '--concurrency') ?? '2');
  const { urls, site } = readJson<DiscoverResponse>(file);

  const ctx = newContext();
  const limiter = new Bottleneck({ maxConcurrent: concurrency, minTime: 500 });
  const pages: PageSummary[] = [];
  const failures: { url: string; error: string }[] = [];

  // Chunk URLs into batches
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    batches.push(urls.slice(i, i + BATCH_SIZE));
  }

  let batchesDone = 0;
  const totalBatches = batches.length;

  const promises = batches.map((batch) =>
    limiter.schedule(async () => {
      try {
        const result = await summarizeBatchUseCase.run(ctx, {
          urls: batch,
          apiKey,
          site,
        });
        pages.push(...result.results);
        failures.push(...result.failures);
        for (const f of result.failures) {
          console.error(`  FAIL ${f.url}: ${f.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const url of batch) {
          failures.push({ url, error: msg });
        }
        console.error(`  BATCH FAIL (${batch.length} pages): ${msg}`);
      }
      batchesDone++;
      const pagesDone = Math.min(batchesDone * BATCH_SIZE, urls.length);
      if (batchesDone % 2 === 0 || batchesDone === totalBatches) {
        console.log(`  progress: ${pagesDone}/${urls.length}`);
      }
    }),
  );

  await Promise.allSettled(promises);

  console.log(`summarized ${pages.length}/${urls.length} (${failures.length} failures)`);
  writeJson('summarize', { pages, failures, site, entryUrl: urls[0] });
};

interface SummarizeOutput {
  pages: PageSummary[];
  failures: { url: string; error: string }[];
  site: SiteInfo;
  entryUrl: string;
}

const assemble = async (args: string[]) => {
  const file = args.find((a) => !a.startsWith('--'));
  const apiKey = parseFlag(args, '--api-key') ?? process.env.ANTHROPIC_API_KEY;
  if (!file || !apiKey) {
    console.error(
      'Usage: npm run generate assemble <summarize_file.json> --api-key <key>',
    );
    console.error('       (or set ANTHROPIC_API_KEY env var)');
    process.exit(1);
  }

  const { pages, site, entryUrl } = readJson<SummarizeOutput>(file);
  const ctx = newContext();

  const { llmsTxt } = await assembleUseCase.run(ctx, {
    pages,
    entryUrl,
    site,
    apiKey,
  });

  writeJson('assemble', { llmsTxt });
};

// ─── Main ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  discover,
  summarize,
  assemble,
};

if (!command || !commands[command]) {
  console.error('Usage: npm run generate <discover|summarize|assemble> [args]');
  process.exit(1);
}

commands[command](args).catch((err) => {
  console.error(err);
  process.exit(1);
});
