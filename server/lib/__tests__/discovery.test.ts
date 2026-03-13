import { describe, it, expect } from 'vitest';
import { _internal } from '../discovery';

const {
  stripWww,
  isUnderPrefix,
  isSameOrigin,
  buildDiscoveryScope,
  resolveLink,
  isCandidate,
} = _internal;

// ─── stripWww ────────────────────────────────────────────────────────────────

describe('stripWww', () => {
  it('strips www from https origin', () => {
    expect(stripWww('https://www.example.com')).toBe('https://example.com');
  });

  it('strips www from http origin', () => {
    expect(stripWww('http://www.example.com')).toBe('http://example.com');
  });

  it('leaves non-www origins unchanged', () => {
    expect(stripWww('https://example.com')).toBe('https://example.com');
  });

  it('does not strip www from subdomain (e.g. api.www.example.com)', () => {
    expect(stripWww('https://api.www.example.com')).toBe('https://api.www.example.com');
  });
});

// ─── isUnderPrefix ───────────────────────────────────────────────────────────

describe('isUnderPrefix', () => {
  it('returns true for exact match', () => {
    expect(isUnderPrefix('/docs', '/docs')).toBe(true);
  });

  it('returns true for child path', () => {
    expect(isUnderPrefix('/docs/api', '/docs')).toBe(true);
  });

  it('returns false for sibling with shared prefix string', () => {
    expect(isUnderPrefix('/docs-v2', '/docs')).toBe(false);
  });

  it('returns false for unrelated path', () => {
    expect(isUnderPrefix('/blog', '/docs')).toBe(false);
  });

  it('returns true for deeply nested child', () => {
    expect(isUnderPrefix('/docs/api/v2/endpoints', '/docs')).toBe(true);
  });
});

// ─── buildDiscoveryScope ─────────────────────────────────────────────────────

describe('buildDiscoveryScope', () => {
  it('builds scope from root URL', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));
    expect(scope.origin).toBe('https://example.com');
    expect(scope.strippedOrigin).toBe('https://example.com');
    expect(scope.pathname).toBe('');
    expect(scope.href).toBe('https://example.com/');
  });

  it('builds scope with path prefix', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/docs/intro'));
    expect(scope.pathname).toBe('/docs/intro');
    expect(scope.href).toBe('https://example.com/docs/intro');
  });

  it('strips trailing slash from pathname', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/docs/'));
    expect(scope.pathname).toBe('/docs');
  });

  it('normalizes www in strippedOrigin', () => {
    const scope = buildDiscoveryScope(new URL('https://www.example.com/docs'));
    expect(scope.origin).toBe('https://www.example.com');
    expect(scope.strippedOrigin).toBe('https://example.com');
  });
});

// ─── isSameOrigin ────────────────────────────────────────────────────────────

describe('isSameOrigin', () => {
  const scope = buildDiscoveryScope(new URL('https://example.com/docs'));

  it('returns true for same origin', () => {
    expect(isSameOrigin(scope, 'https://example.com/sitemap.xml')).toBe(true);
  });

  it('returns true for www variant', () => {
    expect(isSameOrigin(scope, 'https://www.example.com/sitemap.xml')).toBe(true);
  });

  it('returns false for different domain', () => {
    expect(isSameOrigin(scope, 'https://other.com/sitemap.xml')).toBe(false);
  });

  it('returns false for subdomain (not www)', () => {
    expect(isSameOrigin(scope, 'https://blog.example.com/sitemap.xml')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isSameOrigin(scope, 'not-a-url')).toBe(false);
  });
});

// ─── resolveLink ─────────────────────────────────────────────────────────────

describe('resolveLink', () => {
  const base = 'https://example.com/docs/intro';

  it('resolves relative links', () => {
    expect(resolveLink('../about', base)).toBe('https://example.com/about');
  });

  it('resolves absolute path links', () => {
    expect(resolveLink('/docs/api', base)).toBe('https://example.com/docs/api');
  });

  it('resolves full URL links', () => {
    expect(resolveLink('https://example.com/page', base)).toBe(
      'https://example.com/page',
    );
  });

  it('strips hash fragments', () => {
    expect(resolveLink('/docs/api#section', base)).toBe('https://example.com/docs/api');
  });

  it('strips query parameters', () => {
    expect(resolveLink('/docs/api?ref=nav', base)).toBe('https://example.com/docs/api');
  });

  it('strips trailing slash', () => {
    expect(resolveLink('/docs/api/', base)).toBe('https://example.com/docs/api');
  });

  it('preserves root trailing slash', () => {
    expect(resolveLink('/', base)).toBe('https://example.com/');
  });

  it('returns null for mailto links', () => {
    expect(resolveLink('mailto:hi@example.com', base)).toBeNull();
  });

  it('returns null for javascript: links', () => {
    expect(resolveLink('javascript:void(0)', base)).toBeNull();
  });

  it('returns null for tel: links', () => {
    expect(resolveLink('tel:+1234567890', base)).toBeNull();
  });

  it('strips both hash and query together', () => {
    expect(resolveLink('/page?q=1#top', base)).toBe('https://example.com/page');
  });
});

// ─── isCandidate ─────────────────────────────────────────────────────────────

describe('isCandidate', () => {
  describe('origin check', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));

    it('accepts same-origin URL', () => {
      expect(isCandidate(scope, 'https://example.com/docs')).toBe(true);
    });

    it('accepts www variant as same origin', () => {
      expect(isCandidate(scope, 'https://www.example.com/docs')).toBe(true);
    });

    it('rejects cross-origin URL', () => {
      expect(isCandidate(scope, 'https://other.com/docs')).toBe(false);
    });

    it('rejects different subdomain', () => {
      expect(isCandidate(scope, 'https://blog.example.com/docs')).toBe(false);
    });

    it('rejects invalid URL', () => {
      expect(isCandidate(scope, 'not-a-url')).toBe(false);
    });
  });

  describe('pagination check', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));

    it('rejects ?page=2', () => {
      expect(isCandidate(scope, 'https://example.com/list?page=2')).toBe(false);
    });

    it('rejects &page=10 in query', () => {
      expect(isCandidate(scope, 'https://example.com/list?sort=name&page=10')).toBe(
        false,
      );
    });

    it('accepts page in path segment (not query)', () => {
      expect(isCandidate(scope, 'https://example.com/page/about')).toBe(true);
    });
  });

  describe('extension check', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));

    it('accepts no extension', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api')).toBe(true);
    });

    it('accepts .html', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api.html')).toBe(true);
    });

    it('accepts .htm', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api.htm')).toBe(true);
    });

    it('accepts .php', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api.php')).toBe(true);
    });

    it('rejects .pdf', () => {
      expect(isCandidate(scope, 'https://example.com/file.pdf')).toBe(false);
    });

    it('rejects .jpg', () => {
      expect(isCandidate(scope, 'https://example.com/image.jpg')).toBe(false);
    });

    it('rejects .png', () => {
      expect(isCandidate(scope, 'https://example.com/image.png')).toBe(false);
    });

    it('rejects .xml', () => {
      expect(isCandidate(scope, 'https://example.com/data.xml')).toBe(false);
    });

    it('rejects .txt', () => {
      expect(isCandidate(scope, 'https://example.com/llms.txt')).toBe(false);
    });

    it('rejects .zip', () => {
      expect(isCandidate(scope, 'https://example.com/archive.zip')).toBe(false);
    });
  });

  describe('excluded paths', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));

    it.each(['/login', '/signup', '/register', '/account', '/auth', '/search'])(
      'rejects %s',
      (path) => {
        expect(isCandidate(scope, `https://example.com${path}`)).toBe(false);
      },
    );

    it('rejects children of excluded paths', () => {
      expect(isCandidate(scope, 'https://example.com/account/settings')).toBe(false);
      expect(isCandidate(scope, 'https://example.com/auth/callback')).toBe(false);
    });

    it('does not reject paths that start with excluded string but differ at boundary', () => {
      expect(isCandidate(scope, 'https://example.com/authentication')).toBe(true);
      expect(isCandidate(scope, 'https://example.com/searching')).toBe(true);
    });
  });

  describe('prefix scoping', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/docs'));

    it('accepts URL under prefix', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api')).toBe(true);
    });

    it('accepts exact prefix match', () => {
      expect(isCandidate(scope, 'https://example.com/docs')).toBe(true);
    });

    it('rejects URL outside prefix', () => {
      expect(isCandidate(scope, 'https://example.com/blog/post')).toBe(false);
    });

    it('rejects URL sharing prefix string but not segment boundary', () => {
      expect(isCandidate(scope, 'https://example.com/docs-v2/intro')).toBe(false);
    });

    it('accepts deeply nested paths under prefix', () => {
      expect(isCandidate(scope, 'https://example.com/docs/api/v2/users')).toBe(true);
    });
  });

  describe('prefix scoping with root URL', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/'));

    it('accepts any path when scope is root', () => {
      expect(isCandidate(scope, 'https://example.com/anything')).toBe(true);
      expect(isCandidate(scope, 'https://example.com/docs/api')).toBe(true);
    });
  });

  describe('case-insensitive matching', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/en-US/docs'));

    it('matches mixed-case paths case-insensitively', () => {
      expect(isCandidate(scope, 'https://example.com/en-US/docs/API')).toBe(true);
      expect(isCandidate(scope, 'https://example.com/en-us/docs/api')).toBe(true);
    });
  });

  describe('combined filters', () => {
    const scope = buildDiscoveryScope(new URL('https://example.com/docs'));

    it('rejects cross-origin even if path matches prefix', () => {
      expect(isCandidate(scope, 'https://other.com/docs/api')).toBe(false);
    });

    it('rejects paginated URL under prefix', () => {
      expect(isCandidate(scope, 'https://example.com/docs/list?page=2')).toBe(false);
    });

    it('rejects non-HTML file under prefix', () => {
      expect(isCandidate(scope, 'https://example.com/docs/file.pdf')).toBe(false);
    });

    it('rejects excluded path under prefix', () => {
      // /docs scope wouldn't normally have /login, but testing filter precedence
      const rootScope = buildDiscoveryScope(new URL('https://example.com/'));
      expect(isCandidate(rootScope, 'https://example.com/login')).toBe(false);
    });
  });
});
