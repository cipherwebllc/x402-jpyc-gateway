import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAcceptsCache, resetArcProblemLog, resetUsdcFaceCache } from '@/lib/gate';
import { resetOpenApiCache } from '@/lib/openapi';

vi.mock('@/lib/adapters', () => ({
  selectedAdapter: vi.fn(),
}));

import { GET as consult } from '@/app/api/consult/route';
import { GET } from '@/app/openapi.json/route';

import {
  OPENPAY, arcV2Accept, attacker, listing, merchant, resource, resourceId, response, usdcFace,
  usdcFaceWithArc, usdcMerchant,
} from './fixtures';

const description = 'Consultation';
const paidListing = { ...listing, description, usdc: { priceUsd: '0.05' } };
const DISCOVERY = `${OPENPAY}/api/discovery/${resourceId}`;
const REQUIREMENTS = `${OPENPAY}/api/x402/relay/requirements?resourceId=${resourceId}`;

type OpenPayState = {
  listing?: unknown;
  listingStatus?: number;
  listingThrows?: boolean;
  face?: unknown;
  faceStatus?: number;
  faceThrows?: boolean;
};

function fetchFor(state: OpenPayState = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const target = String(input);
    if (target === DISCOVERY) {
      if (state.listingThrows) throw new Error('discovery unavailable');
      return response(state.listing ?? paidListing, state.listingStatus);
    }
    if (target === REQUIREMENTS) {
      if (state.faceThrows) throw new Error('requirements unavailable');
      return response(state.face ?? usdcFace, state.faceStatus);
    }
    throw new Error(`unexpected fetch ${target}`);
  });
}

async function snapshot(res: Response) {
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}

function unpaidConsult(): Promise<Response> {
  return consult(new Request(`${resource}?q=hello`));
}

describe('GET /openapi.json', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
    resetArcProblemLog();
    resetOpenApiCache();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    vi.stubEnv('EXPECTED_RECIPIENT', merchant);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
    vi.stubEnv('ADAPTER', 'coo-icp');
    vi.stubEnv('COO_CANISTER_ID', 'canister-id');
    vi.stubEnv('UPSTREAM_URL', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAcceptsCache();
    resetUsdcFaceCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectUnavailable(): Promise<void> {
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'openapi_unavailable' });
  }

  it('serves the document built from the config and the listing', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      openapi: '3.1.0',
      info: {
        title: 'gateway.example.com',
        version: '1.0.0',
        description,
        'x-guidance': expect.stringContaining('GET /api/consult?q=<input>'),
      },
      servers: [{ url: 'https://gateway.example.com' }],
      paths: {
        '/api/consult': {
          get: {
            operationId: 'consult',
            summary: description,
            parameters: [{
              name: 'q',
              in: 'query',
              required: true,
              description: expect.any(String),
              schema: { type: 'string', minLength: 1 },
            }],
            'x-payment-info': {
              price: { mode: 'fixed', currency: 'USD', amount: '0.05' },
              protocols: [{ x402: {} }],
            },
            responses: {
              '200': {
                description: expect.any(String),
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { answer: { type: 'string' } },
                      required: ['answer'],
                    },
                  },
                },
              },
              '402': { description: expect.any(String) },
            },
          },
        },
      },
    });
  });

  it('uses the listing title when the listing has one', async () => {
    vi.stubGlobal('fetch', fetchFor({ listing: { ...paidListing, title: 'Listing title' } }));

    const document = await (await GET()).json();

    expect(document.info.title).toBe('Listing title');
  });

  it('takes the origin and the path from MY_RESOURCE_URL, without its query', async () => {
    const other = 'https://other.example:8443/v1/ask?source=openpay';
    vi.stubEnv('MY_RESOURCE_URL', other);
    vi.stubGlobal('fetch', fetchFor({ listing: { ...paidListing, resource: other } }));

    const document = await (await GET()).json();

    expect(document.servers).toEqual([{ url: 'https://other.example:8443' }]);
    expect(Object.keys(document.paths)).toEqual(['/v1/ask']);
    expect(document.info.title).toBe('other.example:8443');
  });

  it('describes the http adapter response without inventing its shape', async () => {
    vi.stubEnv('ADAPTER', 'http');
    vi.stubEnv('UPSTREAM_URL', 'https://upstream.example/api');

    const document = await (await GET()).json();

    const operation = document.paths['/api/consult'].get;
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      description: expect.any(String),
    });
  });

  it('never exposes wallets, secrets or a contact address', async () => {
    vi.stubEnv('IC_IDENTITY_SEED', 'secret-seed');

    const text = await (await GET()).text();

    expect(text.toLowerCase()).not.toContain(merchant.toLowerCase());
    expect(text.toLowerCase()).not.toContain(usdcMerchant.toLowerCase());
    expect(text).not.toContain('secret-seed');
    expect(text).not.toContain('contact');
    expect(text).not.toContain('@');
  });

  it('returns 404 without fetching when USDC is disabled', async () => {
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', '');

    await expectUnavailable();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the relay disabled the USDC face', { faceStatus: 404 }],
    ['the relay failed', { faceStatus: 500 }],
    ['the relay is unreachable', { faceThrows: true }],
    ['the USDC recipient does not match', {
      face: { ...usdcFace, v1Accepts: { ...usdcFace.v1Accepts, payTo: attacker } },
    }],
    ['the Arc recipient does not match', {
      face: usdcFaceWithArc({ ...arcV2Accept, payTo: attacker }),
    }],
    ['the listing is gone', { listingStatus: 404 }],
    ['the listing failed', { listingStatus: 500 }],
    ['the listing is unreachable', { listingThrows: true }],
    ['the JPYC recipient does not match', {
      listing: { ...paidListing, accepts: [{ ...listing.accepts[0], extra: {} }] },
    }],
    ['the listing has no USDC price', { listing: { ...paidListing, usdc: undefined } }],
    ['the listing has no description', { listing: { ...paidListing, description: '' } }],
  ] as [string, OpenPayState][])('returns 404 when %s', async (_name, state) => {
    vi.stubGlobal('fetch', fetchFor(state));

    await expectUnavailable();
  });

  it.each([['0'], ['0.000'], ['$0.05'], ['1e3'], ['.5'], ['0.0000001'], [''], [5]])(
    'returns 404 for the listing price %j',
    async (priceUsd) => {
      vi.stubGlobal('fetch', fetchFor({ listing: { ...paidListing, usdc: { priceUsd } } }));

      await expectUnavailable();
    },
  );

  it.each([['MY_RESOURCE_URL'], ['MY_RESOURCE_ID'], ['EXPECTED_RECIPIENT']])(
    'returns 404 without fetching when %s is not set',
    async (name) => {
      vi.stubEnv(name, undefined);

      await expectUnavailable();

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['the adapter is unknown', { ADAPTER: 'other' }],
    ['coo-icp has no canister', { COO_CANISTER_ID: '' }],
    ['http has no upstream', { ADAPTER: 'http', UPSTREAM_URL: '' }],
  ] as [string, Record<string, string>][])('returns 404 without fetching when %s', async (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    await expectUnavailable();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a dropped Arc signing domain, because Base and JPYC keep selling', async () => {
    vi.stubGlobal('fetch', fetchFor({
      face: usdcFaceWithArc({ ...arcV2Accept, maxTimeoutSeconds: 1 }),
    }));

    expect((await GET()).status).toBe(200);
  });

  it('reads OpenPay once for concurrent requests and for the next 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    await Promise.all([GET(), GET()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not read OpenPay again for a minute after a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const failing = fetchFor({ faceStatus: 500 });
    vi.stubGlobal('fetch', failing);

    await expectUnavailable();
    await expectUnavailable();
    expect(failing).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', fetchMock);
    vi.advanceTimersByTime(60_000);
    expect((await GET()).status).toBe(200);
  });

  it('leaves the /api/consult 402 unchanged', async () => {
    const before = await snapshot(await unpaidConsult());
    resetAcceptsCache();
    resetUsdcFaceCache();

    expect((await GET()).status).toBe(200);
    const after = await snapshot(await unpaidConsult());

    expect(before.status).toBe(402);
    expect(after).toEqual(before);
  });

  it.each([
    ['the listing has no USDC price', { listing: { ...paidListing, usdc: undefined } }],
    ['the relay is unreachable', { faceThrows: true }],
    ['the relay disabled the USDC face', { faceStatus: 404 }],
  ] as [string, OpenPayState][])(
    'leaves the /api/consult 402 unchanged when /openapi.json fails because %s',
    async (_name, state) => {
      vi.stubGlobal('fetch', fetchFor(state));
      const before = await snapshot(await unpaidConsult());

      await expectUnavailable();
      const after = await snapshot(await unpaidConsult());

      expect(before.status).toBe(402);
      expect(after).toEqual(before);
    },
  );

  it('does not fill the payment caches', async () => {
    await GET();
    fetchMock.mockClear();

    await unpaidConsult();

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([DISCOVERY, REQUIREMENTS]);
  });

  it('does not use the payment caches', async () => {
    await unpaidConsult();
    vi.stubGlobal('fetch', fetchFor({ faceStatus: 404 }));

    await expectUnavailable();
  });

  it.each([
    ['listing', DISCOVERY],
    ['relay', REQUIREMENTS],
  ])(
    'does not disturb a %s read in flight on /api/consult when /openapi.json gets a 404',
    async (_name, target) => {
      let release!: (value: Response) => void;
      const held = new Promise<Response>((resolve) => { release = resolve; });
      let reads = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url !== target) return response(url === DISCOVERY ? paidListing : usdcFace);
        reads += 1;
        return reads === 1 ? held : response({ error: 'not_found' }, 404);
      }));

      const pending = unpaidConsult();
      await vi.waitFor(() => expect(reads).toBe(1));
      await expectUnavailable();
      release(response(target === DISCOVERY ? paidListing : usdcFace));

      const res = await pending;
      expect(res.status).toBe(402);
      expect((await res.json()).accepts).toHaveLength(2);
    },
  );
});
