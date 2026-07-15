import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpAdapter } from '@/lib/adapters/http';

describe('httpAdapter', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTREAM_URL', 'https://upstream.example/consult?source=gateway');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('encodes q, disables caching, and relays JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ answer: 'ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpAdapter({ q: 'a question & answer' })).resolves.toEqual({ answer: 'ok' });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://upstream.example/consult?source=gateway&q=a+question+%26+answer',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws for a non-successful upstream response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpAdapter({ q: 'hello' })).rejects.toThrow('upstream responded 502');
  });
});
