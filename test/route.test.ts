import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from '@/lib/adapters/types';
import { selectedAdapter } from '@/lib/adapters';
import { resetAcceptsCache } from '@/lib/gate';

vi.mock('@/lib/adapters', () => ({
  selectedAdapter: vi.fn(),
}));

import { GET } from '@/app/api/consult/route';

const OPENPAY = 'https://open-pay.jp';
const resource = 'https://gateway.example.com/api/consult';
const catalogAccept = {
  scheme: 'exact',
  network: 'eip155:137',
  maxAmountRequired: '1010000000000000000',
  resource,
  description: 'Consultation',
  mimeType: 'application/json',
  payTo: '0xmerchant',
  asset: '0xasset',
  extra: { openpay: { merchantValue: '1000000000000000000' } },
};
const paymentPayload = { authorization: 'payment' };
const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function url(path = '?q=hello'): string {
  return `https://untrusted-request-host.example/api/consult${path}`;
}

function request(path = '?q=hello', payment = paymentHeader): Request {
  return new Request(url(path), { headers: { 'X-PAYMENT': payment } });
}

type FacilitatorState = {
  discovery?: unknown;
  discoveryStatus?: number;
  verify?: unknown;
  settle?: unknown;
};

function fetchFor(state: FacilitatorState = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if (target === `${OPENPAY}/api/discovery`) {
      return response(
        state.discovery ?? { items: [{ resource, accepts: [catalogAccept] }] },
        state.discoveryStatus,
      );
    }
    if (target === `${OPENPAY}/api/facilitator/verify`) {
      return response(state.verify ?? { isValid: true });
    }
    if (target === `${OPENPAY}/api/facilitator/settle`) {
      return response(state.settle ?? { success: true, transaction: '0xsettled' });
    }
    throw new Error(`unexpected fetch ${target} ${JSON.stringify(init)}`);
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, endpoint: 'verify' | 'settle') {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith(`/api/facilitator/${endpoint}`),
  );
}

function expectNoStore(res: Response): void {
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('GET /api/consult', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let adapter: ReturnType<typeof vi.fn<Adapter>>;

  beforeEach(() => {
    resetAcceptsCache();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    adapter = vi.fn<Adapter>();
    adapter.mockResolvedValue({ answer: 'answer' });
    vi.mocked(selectedAdapter).mockReturnValue(adapter);
  });

  afterEach(() => {
    resetAcceptsCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(['?q=hello', ''])('returns a resource-rewritten 402 without payment (%s)', async (path) => {
    const res = await GET(new Request(url(path)));
    const body = (await res.json()) as {
      x402Version: number;
      accepts: Array<typeof catalogAccept>;
      error: string;
    };

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe('payment_required');
    expect(body.accepts).toEqual([
      {
        ...catalogAccept,
        resource: `https://gateway.example.com/api/consult${path}`,
      },
    ]);
    expect(body.accepts[0].maxAmountRequired).toBe(catalogAccept.maxAmountRequired);
    expect(body.accepts[0].payTo).toBe(catalogAccept.payTo);
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each(['not valid base64', Buffer.from('not json').toString('base64')])(
    'rejects a malformed payment payload',
    async (header) => {
      const res = await GET(request('?q=hello', header));

      expect(res.status).toBe(402);
      expectNoStore(res);
      expect(await res.json()).toMatchObject({ error: 'invalid_payment_payload' });
      expect(callsTo(fetchMock, 'verify')).toHaveLength(0);
      expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
      expect(adapter).not.toHaveBeenCalled();
    },
  );

  it.each(['', '?q='])('returns 400 for a missing or empty q before payment processing', async (path) => {
    const res = await GET(request(path));

    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'q_required' });
    expect(callsTo(fetchMock, 'verify')).toHaveLength(0);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('does not invoke the adapter or settle when verification fails', async () => {
    fetchMock = fetchFor({ verify: { isValid: false, invalidReason: 'authorization_invalid' } });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(await res.json()).toMatchObject({ error: 'authorization_invalid' });
    expect(callsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('does not settle when the adapter throws', async () => {
    adapter.mockRejectedValue(new Error('upstream unavailable'));

    const res = await GET(request());

    expect(res.status).toBe(502);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
    expect(callsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('does not settle when the adapter return value cannot be serialized', async () => {
    adapter.mockResolvedValue({ answer: BigInt(1) });

    const res = await GET(request());

    expect(res.status).toBe(502);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
    expect(callsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('does not return the answer when settlement fails', async () => {
    fetchMock = fetchFor({ settle: { success: false, errorReason: 'settlement_declined' } });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(body.error).toBe('settlement_declined');
    expect(body.answer).toBeUndefined();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(1);
  });

  it('settles after a serializable answer and returns its payment response', async () => {
    const settlement = { success: true, transaction: '0xsettled' };
    fetchMock = fetchFor({ settle: settlement });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(await res.json()).toEqual({ answer: 'answer' });
    expect(JSON.parse(Buffer.from(res.headers.get('X-PAYMENT-RESPONSE')!, 'base64').toString('utf8'))).toEqual(
      settlement,
    );
  });

  it('returns the bootstrap 500 when the resource is absent from discovery', async () => {
    fetchMock = fetchFor({ discovery: { items: [] } });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(500);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'accepts_unavailable' });
    expect(callsTo(fetchMock, 'verify')).toHaveLength(0);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('sends the exact OpenPay facilitator body with accepts[0]', async () => {
    const res = await GET(request('?q=hello%20world'));
    const rewrittenRequirements = {
      ...catalogAccept,
      resource: 'https://gateway.example.com/api/consult?q=hello%20world',
    };

    expect(res.status).toBe(200);
    for (const endpoint of ['verify', 'settle'] as const) {
      const call = callsTo(fetchMock, endpoint)[0];
      const init = call[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({
        x402Version: 1,
        paymentPayload,
        paymentRequirements: rewrittenRequirements,
      });
    }
  });

  it('returns a no-store 500 when discovery is non-successful', async () => {
    fetchMock = fetchFor({ discoveryStatus: 503 });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(500);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'accepts_unavailable' });
  });
});
