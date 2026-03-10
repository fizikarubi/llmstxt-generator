Here is a Markdown-formatted, LLM-friendly summary of the **llms.txt** proposal based on the official website:

# Summary: The `/llms.txt` Proposal

## Overview

**`llms.txt`** is a proposed standard to help Large Language Models (LLMs) easily ingest and understand website content at inference time. It proposes placing a standardized Markdown file at the root of a website (`/llms.txt`) containing concise background information, guidance, and curated links to LLM-friendly documentation.

## The Problem

- **Context Limits:** LLM context windows are often too small to process entire websites.
- **Complex HTML:** Extracting clean information from raw HTML (which includes navigation, ads, and JavaScript) is messy and imprecise.
- **Audience Mismatch:** Websites are designed for human navigation, whereas LLMs benefit from concise, expert-level text consolidated in an accessible format.

## The Two-Part Proposal

1. **The `/llms.txt` File:** Websites should host an `/llms.txt` file at their root. This file acts as a curated index and primer, providing LLMs with necessary context and directing them to further relevant information.
2. **The `.md` Extension:** Webpages containing information useful to LLMs should provide a clean, Markdown-formatted version of the page at the exact same URL, simply by appending `.md` (e.g., `page.html.md` or `index.html.md`).

## Standardized Format Specification

To allow for easy parsing by both classical regex/scripts and LLMs, the `llms.txt` file must be written in Markdown and follow a specific structural order:

1. **Title (Required):** An `H1` (`#`) heading with the name of the project or site.
2. **Summary:** A blockquote (`>`) containing a short summary with key information necessary for understanding the rest of the file.
3. **Details:** Zero or more standard Markdown sections (paragraphs, lists) detailing how to interpret the project or files. (No headings allowed here).
4. **File Lists:** Zero or more `H2` (`##`) headers containing markdown lists of URLs for deeper context.

- **List Format:** `- [Link title](url): Optional notes about the file`
- **The `## Optional` Header:** A reserved `H2` section. Any URLs listed under `## Optional` contain secondary information that an LLM or script can safely skip if a shorter context window is required.

### Example Structure:

```markdown
# Project Name

> Brief summary of the project goes here.

Additional context, rules, or guidance for the LLM.

## Docs

- [Quickstart](https://example.com/quickstart.html.md): Guide for new users.
- [API Reference](https://example.com/api.md): Full API breakdown.

## Optional

- [Deep Dive](https://example.com/deepdive.md): Secondary information that can be skipped.
```

## Implementation Guidance

For tools that _generate_ llms.txt files from crawled websites:

1. **Two-phase pipeline:** (1) Lightweight per-page tagging — extract `title`, `summary`, and `isSupplementary` (boolean) from each page. (2) Assembly with full context — a single LLM pass sees all pages at once and invents H2 section names, grouping pages logically. Supplementary pages go under `## Optional`.

2. **The `## Optional` rule:** Any URL listed under `## Optional` is secondary/skippable (changelog, legal, about, pricing, community links). The assembler must place all such pages here and nowhere else.

3. **`.md` extension:** When a site serves a markdown version of a page at the same URL with `.md` appended (e.g. `page.html.md` or `index.html.md`), prefer that URL in the generated llms.txt — markdown is more useful to LLMs than HTML.

4. **List format:** Each entry must be exactly `- [Title](url): Description` with no extra metadata in the final output.

## Comparison to Existing Web Standards

- **`robots.txt`**: Tells bots what they are _allowed_ to access (permissions). `llms.txt` gives LLMs the _context_ they need on-demand.
- **`sitemap.xml`**: Provides a comprehensive list of all human-readable pages for search engine indexing. `llms.txt` provides a tightly curated, LLM-readable subset of essential information, often including external links not found in a sitemap.
