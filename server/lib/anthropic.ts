/**
 * LLM calls for page summarization and llms.txt assembly.
 *
 * - **Claude Haiku 4.5**: chosen for cost and speed — summarization and
 *   assembly are high-volume, low-complexity tasks where Haiku's quality
 *   is sufficient. Upgrading to Sonnet would improve output but roughly
 *   10x the cost per page.
 *
 * - **Batch summarization**: pages are sent to the LLM in batches rather
 *   than one-at-a-time. This amortizes the system prompt overhead and
 *   enables prompt caching (`cache_control: ephemeral`), but means a
 *   single malformed page can fail the whole batch. The caller handles
 *   retries at the batch level.
 *
 * - **6k char content cap**: each page's text is truncated to ~6 000 chars
 *   before being sent. This keeps input tokens bounded and ensures batches
 *   fit comfortably within the context window. Most docs pages are well
 *   under this limit; very long pages lose tail content but the summary
 *   typically depends on the opening sections anyway.
 *
 * - **64k output token ceiling**: Haiku 4.5 caps output at 64k tokens.
 *   At ~100 tokens per page summary, this supports ~640 pages per assembly
 *   call. The UI warns users to stay under 600 pages for this reason.
 *
 */
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

const extractResponseText = (response: Anthropic.Message): string =>
  response.content[0].type === 'text' ? response.content[0].text : '';

/**
 * Summarize pages in a single LLM call.
 *
 * The system message carries the static instructions (with cache_control so
 * Anthropic caches it across calls) and the user message carries the numbered
 * page list. Output is a JSON array matched back to input order.
 */
const summarizePages = async (
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

const assemblePageSummaries = async (
  ctx: Context,
  client: Anthropic,
  entryUrl: string,
  site: SiteInfo,
  pages: PageSummary[],
): Promise<string> =>
  withTrace(ctx, 'assembleWithLlm', { entryUrl, pageCount: pages.length }, async () => {
    const flatList = formatFlatPageList(pages);
    const maxTokens = assembleMaxTokens(pages.length);
    const nameHint = site.name || new URL(entryUrl).hostname;

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: `You are generating an llms.txt file for a project.
Site URL: ${entryUrl}
Detected site name (may just be a hostname — use only as a hint): ${nameHint}
${site.description ? `Site description: ${site.description}` : ''}

Below is a flat list of all the pages on this site, along with a brief summary. Some are marked with [SUPPLEMENTARY].

${flatList}

Generate a complete llms.txt file strictly following this spec:

1. An H1 header with the project's proper name. Infer the correct casing and name from the page titles, URLs, and content. The detected site name above is only a hint and may be inaccurate — prefer evidence from the pages themselves.
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

export const anthropic = {
  summarizePages,
  assemblePageSummaries,
};
