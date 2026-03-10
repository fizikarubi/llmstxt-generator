import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { LoggerContext } from '@/server/lib/logger';
import { withTrace } from '@/server/lib/logger';
import type { SiteInfo, PageInfo, PageSummary } from '@/shared/types';

const MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZE_MAX_TOKENS = 100;

/** Each page can use up to SUMMARIZE_MAX_TOKENS + overhead for the markdown link/URL wrapper. */
const assembleMaxTokens = (pageCount: number): number =>
  pageCount * (SUMMARIZE_MAX_TOKENS + 50) + 1000;

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
  ctx: LoggerContext,
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

const formatFlatPageList = (pages: PageSummary[]): string =>
  pages
    .map((p) => {
      const linkUrl = p.meta.mdUrl ?? p.meta.pageUrl;
      const flag = p.isSupplementary ? ' [SUPPLEMENTARY]' : '';
      return `- [${p.title}](${linkUrl}): ${p.summary}${flag}`;
    })
    .join('\n');

export const assembleWithLlm = async (
  ctx: LoggerContext,
  client: Anthropic,
  entryUrl: string,
  site: SiteInfo,
  pages: PageSummary[],
): Promise<string> =>
  withTrace(
    ctx,
    'assembleWithLlm',
    { entryUrl, pageCount: pages.length },
    async () => {
      const flatList = formatFlatPageList(pages);
      const maxTokens = assembleMaxTokens(pages.length);
      const projectName = site.name || new URL(entryUrl).hostname;

      const response = await client.messages.create({
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

      return extractResponseText(response).trim();
    },
  );
