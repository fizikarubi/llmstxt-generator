import Anthropic from '@anthropic-ai/sdk';
import { withTrace } from '@/server/lib/logger';
import type { SiteInfo, PageInfo, PageSummary } from '@/shared/types';
import { Context } from './context';

const MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZE_MAX_TOKENS = 100;

/**
 * Budget for the final llms.txt assembly call.
 *
 * We estimate ~SUMMARIZE_MAX_TOKENS (100) output tokens per page summary plus
 * ~1 000 tokens of overhead (H1, blockquote, section headers). Claude Haiku
 * 4.5 caps output at 64k tokens, so the practical ceiling is roughly
 * 64 000 / 100 ≈ 640 pages. Beyond that the output will be truncated by the
 * model — the UI warns users to stay under 600 pages for this reason.
 */
const MODEL_MAX_OUTPUT_TOKENS = 64_000;

const assembleMaxTokens = (pageCount: number): number => {
  const raw = pageCount * SUMMARIZE_MAX_TOKENS + 1000;
  return Math.min(raw, MODEL_MAX_OUTPUT_TOKENS);
};

export const createClient = (apiKey: string): Anthropic =>
  new Anthropic({ apiKey, maxRetries: 2 });

const extractResponseText = (response: Anthropic.Message): string =>
  response.content[0].type === 'text' ? response.content[0].text : '';

/**
 * Ask the LLM to classify and summarize a single page.
 *
 * Input text is truncated to 6000 chars (~1.5k tokens) to keep per-page
 * costs low and stay well within the context window. Output is capped at
 * 250 tokens — enough for a title, one-sentence summary, and a boolean.
 */
export const summarizePage = async (
  ctx: Context,
  client: Anthropic,
  pageInfo: PageInfo,
  textContent: string,
  site: SiteInfo,
): Promise<PageSummary> =>
  withTrace(ctx, 'summarizePage', { url: pageInfo.pageUrl }, async () => {
    const siteContext = [
      `Site: "${site.name}"`,
      site.description ? `Description: "${site.description}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: SUMMARIZE_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `You are summarizing a web page for an llms.txt file.

${siteContext}
Page URL: ${pageInfo.pageUrl}

Page content:
${textContent.slice(0, 6_000)}

Produce a JSON object with EXACTLY these fields:
- "title": A clean, descriptive title for this page (no site name prefixes).
- "summary": A single, concise sentence describing the page's content for an LLM.
- "isSupplementary": boolean (true ONLY if this is secondary/skippable info like changelogs, legal, about us, pricing, or community links. False for docs, guides, code, and tutorials).

Respond with ONLY valid JSON, no markdown fences.`,
        },
      ],
    });

    const raw = extractResponseText(response)
      .replace(/^```(?:json)?\s*|\s*```$/g, '')
      .trim();
    const parsed = JSON.parse(raw);

    return {
      meta: pageInfo,
      title: parsed.title,
      summary: parsed.summary,
      isSupplementary: parsed.isSupplementary,
    };
  });

/**
 * Summarize a batch of pages in a single LLM call.
 *
 * The system message carries the static instructions (with cache_control so
 * Anthropic caches it across calls) and the user message carries the numbered
 * page list. Output is a JSON array matched back to input order.
 */
export const summarizePageBatch = async (
  ctx: Context,
  client: Anthropic,
  pages: { pageInfo: PageInfo; textContent: string }[],
  site: SiteInfo,
): Promise<PageSummary[]> =>
  withTrace(ctx, 'summarizePageBatch', { count: pages.length }, async () => {
    const siteContext = [
      `Site: "${site.name}"`,
      site.description ? `Description: "${site.description}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Build the numbered page list for the user message
    const pageList = pages
      .map((p, i) => {
        const content = p.textContent.slice(0, 6_000);
        return `=== PAGE ${i + 1} ===\nURL: ${p.pageInfo.pageUrl}\n\n${content}`;
      })
      .join('\n\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: Math.min(SUMMARIZE_MAX_TOKENS * pages.length, MODEL_MAX_OUTPUT_TOKENS),
      system: [
        {
          type: 'text' as const,
          text: `You are summarizing web pages for an llms.txt file.

${siteContext}

For each page provided, produce a JSON object with EXACTLY these fields:
- "title": A clean, descriptive title for this page (no site name prefixes).
- "summary": A single, concise sentence describing the page's content for an LLM.
- "isSupplementary": boolean (true ONLY if this is secondary/skippable info like changelogs, legal, about us, pricing, or community links. False for docs, guides, code, and tutorials).

Your output MUST be a JSON array with one object per page, in the same order as the input pages.
Respond with ONLY valid JSON, no markdown fences.

Example input:
=== PAGE 1 ===
URL: https://example.com/docs/intro
Getting started with Example...

=== PAGE 2 ===
URL: https://example.com/changelog
v2.0 - Added new features...

Example output:
[{"title":"Introduction","summary":"Getting started guide for Example.","isSupplementary":false},{"title":"Changelog","summary":"Release history and version changes.","isSupplementary":true}]`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: pageList,
        },
      ],
    });

    const raw = extractResponseText(response)
      .replace(/^```(?:json)?\s*|\s*```$/g, '')
      .trim();
    const parsed: Array<{ title: string; summary: string; isSupplementary: boolean }> =
      JSON.parse(raw);

    if (parsed.length !== pages.length) {
      throw new Error(
        `Batch response length mismatch: expected ${pages.length}, got ${parsed.length}`,
      );
    }

    return parsed.map((item, i) => ({
      meta: pages[i].pageInfo,
      title: item.title,
      summary: item.summary,
      isSupplementary: item.isSupplementary,
    }));
  });

const formatFlatPageList = (pages: PageSummary[]): string =>
  pages
    .map((p) => {
      const linkUrl = p.meta.mdUrl ?? p.meta.pageUrl;
      const flag = p.isSupplementary ? ' [SUPPLEMENTARY]' : '';
      return `- [${p.title}](${linkUrl}): ${p.summary}${flag}`;
    })
    .join('\n');

export const assembleWithLlm = async (
  ctx: Context,
  client: Anthropic,
  entryUrl: string,
  site: SiteInfo,
  pages: PageSummary[],
): Promise<string> =>
  withTrace(ctx, 'assembleWithLlm', { entryUrl, pageCount: pages.length }, async () => {
    const flatList = formatFlatPageList(pages);
    const maxTokens = assembleMaxTokens(pages.length);
    const projectName = site.name || new URL(entryUrl).hostname;

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: `You are generating an llms.txt file for the project: ${projectName}.
Site URL: ${entryUrl}
${site.description ? `Site description: ${site.description}` : ''}

Below is a flat list of all the pages on this site, along with a brief summary. Some are marked with [SUPPLEMENTARY].

${flatList}

Generate a complete llms.txt file strictly following this spec:

1. An H1 header with the project name: # ${projectName}
2. A blockquote starting with "> " containing a concise 1-2 sentence summary of the project based on the site description.
3. If there are crucial caveats about this project, add them as plain text immediately after the blockquote.
4. Review the unflagged pages and group them logically using H2 headers (##). Invent section names that best fit the data (e.g. "## Core Concepts", "## API Reference", "## Tutorials", etc.). Do not create too many small sections; group them reasonably.
5. CRITICAL: Take every single page marked "[SUPPLEMENTARY]" and place them together under a single "## Optional" header at the very end of the file.
6. Under each H2, list the pages exactly as formatted: - [Title](url): Description
7. Remove the "[SUPPLEMENTARY]" text from your final output.

Rules:
- Do NOT use H3 or deeper headers.
- Every page from the list must appear exactly once in your output.

Respond with ONLY the raw llms.txt markdown content. No conversational intro, no markdown fences (\`\`\`).`,
        },
      ],
    });

    const response = await stream.finalMessage();
    return extractResponseText(response).trim();
  });
