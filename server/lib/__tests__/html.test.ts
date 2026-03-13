import { describe, it, expect } from 'vitest';
import { html } from '../html';

const { extractSiteInfo, extractText, isSpaShell, extractDescription } = html;

// ─── extractSiteInfo ─────────────────────────────────────────────────────────

describe('extractSiteInfo', () => {
  const url = new URL('https://example.com');

  it('uses og:site_name when available', () => {
    const html = `
      <html><head>
        <meta property="og:site_name" content="My Project">
        <title>Some Page | My Project</title>
      </head><body><h1>Hello</h1></body></html>`;
    expect(extractSiteInfo(html, url).name).toBe('My Project');
  });

  it('falls back to full title when no og:site_name', () => {
    const html = `<html><head><title>Next.js | The React Framework</title></head><body></body></html>`;
    expect(extractSiteInfo(html, url).name).toBe('Next.js | The React Framework');
  });

  it('falls back to h1 when no og:site_name or title', () => {
    const html = `<html><head></head><body><h1>My App</h1></body></html>`;
    expect(extractSiteInfo(html, url).name).toBe('My App');
  });

  it('falls back to hostname when nothing else available', () => {
    const html = `<html><head></head><body></body></html>`;
    expect(extractSiteInfo(html, url).name).toBe('example.com');
  });

  it('extracts meta description', () => {
    const html = `<html><head><meta name="description" content="A great tool."><title>Tool</title></head><body></body></html>`;
    const info = extractSiteInfo(html, url);
    expect(info.description).toBe('A great tool.');
  });

  it('extracts og:description when meta description is absent', () => {
    const html = `<html><head><meta property="og:description" content="OG desc."><title>X</title></head><body></body></html>`;
    expect(extractSiteInfo(html, url).description).toBe('OG desc.');
  });

  it('truncates long descriptions at word boundary with ellipsis', () => {
    const longDesc = 'A'.repeat(100) + ' ' + 'B'.repeat(200);
    const html = `<html><head><meta name="description" content="${longDesc}"><title>X</title></head><body></body></html>`;
    const desc = extractSiteInfo(html, url).description;
    expect(desc.endsWith('…')).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(251); // 250 + ellipsis char
  });

  it('truncates with ellipsis when no sentence boundary', () => {
    const longDesc = 'A'.repeat(300);
    const html = `<html><head><meta name="description" content="${longDesc}"><title>X</title></head><body></body></html>`;
    const desc = extractSiteInfo(html, url).description;
    expect(desc.endsWith('…')).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(251);
  });

  it('returns empty description when none exists', () => {
    const html = `<html><head><title>X</title></head><body></body></html>`;
    expect(extractSiteInfo(html, url).description).toBe('');
  });
});

// ─── extractText ─────────────────────────────────────────────────────────────

describe('extractText', () => {
  it('extracts visible text from body', () => {
    const html = `<html><body><p>Hello world</p></body></html>`;
    expect(extractText(html)).toBe('Hello world');
  });

  it('removes script and style elements', () => {
    const html = `<html><body>
      <script>var x = 1;</script>
      <style>.foo { color: red; }</style>
      <p>Visible text</p>
    </body></html>`;
    expect(extractText(html)).toBe('Visible text');
  });

  it('removes nav and footer', () => {
    const html = `<html><body>
      <nav><a href="/">Home</a></nav>
      <main><p>Content</p></main>
      <footer>Copyright 2024</footer>
    </body></html>`;
    expect(extractText(html)).toBe('Content');
  });

  it('prefers main/article content over body', () => {
    const html = `<html><body>
      <div>Sidebar stuff</div>
      <main><p>Main content here</p></main>
    </body></html>`;
    expect(extractText(html)).toBe('Main content here');
  });

  it('removes iframes and forms', () => {
    const html = `<html><body>
      <iframe src="ad.html"></iframe>
      <form><input type="text"></form>
      <p>Real content</p>
    </body></html>`;
    expect(extractText(html)).toBe('Real content');
  });

  it('removes aria-hidden elements', () => {
    const html = `<html><body>
      <div aria-hidden="true">Hidden</div>
      <p>Shown</p>
    </body></html>`;
    expect(extractText(html)).toBe('Shown');
  });

  it('removes aside and complementary role', () => {
    const html = `<html><body>
      <aside>Side note</aside>
      <div role="complementary">Extra</div>
      <main><p>Core</p></main>
    </body></html>`;
    expect(extractText(html)).toBe('Core');
  });

  it('collapses whitespace', () => {
    const html = `<html><body><p>  Hello   world  </p></body></html>`;
    expect(extractText(html)).toBe('Hello world');
  });

  it('removes top-level header but preserves article header', () => {
    const html = `<html><body>
      <header><h1>Site Name</h1></header>
      <article>
        <header><h2>Article Title</h2><time>2024</time></header>
        <p>Body text</p>
      </article>
    </body></html>`;
    const text = extractText(html);
    expect(text).toContain('Article Title');
    expect(text).toContain('Body text');
  });
});

// ─── isSpaShell ──────────────────────────────────────────────────────────────

describe('isSpaShell', () => {
  it('returns true for minimal HTML with no content', () => {
    const html = `<html><body><div id="root"></div><script src="app.js"></script></body></html>`;
    expect(isSpaShell(html)).toBe(true);
  });

  it('returns true for HTML with less than 100 chars of visible text', () => {
    const html = `<html><body><p>Short</p></body></html>`;
    expect(isSpaShell(html)).toBe(true);
  });

  it('returns false for HTML with substantial content', () => {
    const content = 'A'.repeat(150);
    const html = `<html><body><p>${content}</p></body></html>`;
    expect(isSpaShell(html)).toBe(false);
  });
});

// ─── extractDescription ─────────────────────────────────────────────────────

describe('extractDescription', () => {
  it('extracts meta description', () => {
    const html = `<html><head><meta name="description" content="Page about stuff"></head><body></body></html>`;
    expect(extractDescription(html)).toBe('Page about stuff');
  });

  it('falls back to og:description', () => {
    const html = `<html><head><meta property="og:description" content="OG stuff"></head><body></body></html>`;
    expect(extractDescription(html)).toBe('OG stuff');
  });

  it('falls back to first paragraph in main', () => {
    const html = `<html><head></head><body><main><p>First paragraph.</p></main></body></html>`;
    expect(extractDescription(html)).toBe('First paragraph.');
  });

  it('returns empty string when nothing found', () => {
    const html = `<html><head></head><body></body></html>`;
    expect(extractDescription(html)).toBe('');
  });
});
