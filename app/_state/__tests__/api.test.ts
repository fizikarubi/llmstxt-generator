import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postApi, postApiWithRetry, isRetryableStatus } from '../api';

describe('isRetryableStatus', () => {
  it('returns true for 429', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('returns true for 500', () => {
    expect(isRetryableStatus(500)).toBe(true);
  });

  it('returns true for 502', () => {
    expect(isRetryableStatus(502)).toBe(true);
  });

  it('returns true for 503', () => {
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('returns false for 400', () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('returns false for 401', () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it('returns false for 403', () => {
    expect(isRetryableStatus(403)).toBe(false);
  });

  it('returns false for 404', () => {
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('returns false for 200', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('postApi', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns ok result on 200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'hello' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await postApi('/api/test', { foo: 'bar' }, AbortSignal.timeout(5000));
    expect(result).toEqual({ ok: true, data: { data: 'hello' } });
  });

  it('returns error result on non-ok response with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await postApi('/api/test', {}, AbortSignal.timeout(5000));
    expect(result).toEqual({ ok: false, error: 'Bad request', status: 400 });
  });

  it('returns fallback error message when response body is not JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const result = await postApi('/api/test', {}, AbortSignal.timeout(5000));
    expect(result).toEqual({ ok: false, error: 'HTTP 500', status: 500 });
  });

  it('sends POST with JSON content type', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = mockFn;

    await postApi('/api/test', { key: 'value' }, AbortSignal.timeout(5000));

    expect(mockFn).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      }),
    );
  });
});

describe('postApiWithRetry', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns data on first success', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 42 }), { status: 200 }));

    const result = await postApiWithRetry('/api/test', {}, AbortSignal.timeout(5000));
    expect(result).toEqual({ value: 42 });
  });

  it('bails immediately on non-retryable status', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      );

    await expect(
      postApiWithRetry('/api/test', {}, AbortSignal.timeout(5000)),
    ).rejects.toThrow('Unauthorized');

    // Should only be called once (no retries)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and succeeds on second attempt', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
      }
      return new Response(JSON.stringify({ value: 'ok' }), { status: 200 });
    });

    const result = await postApiWithRetry('/api/test', {}, AbortSignal.timeout(10000));
    expect(result).toEqual({ value: 'ok' });
    expect(callCount).toBe(2);
  });

  it('retries on 429 and succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 });
      }
      return new Response(JSON.stringify({ result: true }), { status: 200 });
    });

    const result = await postApiWithRetry('/api/test', {}, AbortSignal.timeout(10000));
    expect(result).toEqual({ result: true });
    expect(callCount).toBe(2);
  });
});
