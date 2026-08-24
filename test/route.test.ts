import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from '@/lib/adapters/types';
import { selectedAdapter } from '@/lib/adapters';
import { resetAcceptsCache, resetUsdcFaceCache } from '@/lib/gate';

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
const resourceId = 'resource-id';
const paymentRequiredHeader = 'encoded-payment-requirements';
const usdcAccept = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource,
  description: 'Consultation',
  mimeType: 'application/json',
  payTo: '0xusdcmerchant',
  maxTimeoutSeconds: 300,
  asset: '0xusdc',
  extra: { name: 'USDC', version: '2' },
};
const usdcFace = {
  resourceId,
  v1Accepts: usdcAccept,
  paymentRequiredHeader,
};

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
  requirements?: unknown;
  requirementsStatus?: number;
  requirementsThrows?: boolean;
  relayVerify?: unknown;
  relaySettle?: unknown;
  relayVerifyThrows?: boolean;
  relaySettleThrows?: boolean;
};

function fetchFor(state: FacilitatorState = {}, events?: string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if (target === `${OPENPAY}/api/discovery`) {
      return response(
        state.discovery ?? { items: [{ resource, accepts: [catalogAccept] }] },
        state.discoveryStatus,
      );
    }
    if (target === `${OPENPAY}/api/x402/relay/requirements?resourceId=${resourceId}`) {
      if (state.requirementsThrows) throw new Error('requirements unavailable');
      return response(state.requirements ?? usdcFace, state.requirementsStatus);
    }
    if (target === `${OPENPAY}/api/x402/relay/verify`) {
      events?.push('relay verify');
      if (state.relayVerifyThrows) throw new Error('relay verify unavailable');
      return response(state.relayVerify ?? { isValid: true });
    }
    if (target === `${OPENPAY}/api/x402/relay/settle`) {
      events?.push('relay settle');
      if (state.relaySettleThrows) throw new Error('relay settle unavailable');
      return response(
        state.relaySettle ?? { success: true, transaction: '0xusdcsettled', network: 'base' },
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

function relayCallsTo(
  fetchMock: ReturnType<typeof vi.fn>,
  endpoint: 'requirements' | 'verify' | 'settle',
) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes(`/api/x402/relay/${endpoint}`),
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
    resetUsdcFaceCache();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', undefined);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    adapter = vi.fn<Adapter>();
    adapter.mockResolvedValue({ answer: 'answer' });
    vi.mocked(selectedAdapter).mockReturnValue(adapter);
  });

  afterEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
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

  it('returns JPYC then verbatim USDC accepts with PAYMENT-REQUIRED when unpaid', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(new Request(url()));
    const body = (await res.json()) as { accepts: unknown[]; error: string };

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBe(paymentRequiredHeader);
    expect(body.error).toBe('payment_required');
    expect(body.accepts).toEqual([
      { ...catalogAccept, resource: 'https://gateway.example.com/api/consult?q=hello' },
      usdcAccept,
    ]);
  });

  it('does not fetch the relay when MY_RESOURCE_ID is unset', async () => {
    const res = await GET(new Request(url()));
    const body = (await res.json()) as { accepts: unknown[] };

    expect(res.status).toBe(402);
    expect(body.accepts).toHaveLength(1);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/x402/relay/'))).toBe(
      false,
    );
  });

  it.each([
    ['a requirements 404', { requirementsStatus: 404 }],
    ['a requirements fetch exception', { requirementsThrows: true }],
  ])('degrades to JPYC-only after %s', async (_label, state) => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor(state);
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(new Request(url()));
    const body = (await res.json()) as { accepts: unknown[] };

    expect(res.status).toBe(402);
    expect(body.accepts).toEqual([
      { ...catalogAccept, resource: 'https://gateway.example.com/api/consult?q=hello' },
    ]);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(relayCallsTo(fetchMock, 'requirements')).toHaveLength(1);
    expect(relayCallsTo(fetchMock, 'verify')).toHaveLength(0);
  });

  it('uses the USDC v2 relay in verify-adapter-settle order', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    const events: string[] = [];
    const settlement = { success: true, transaction: '0xusdcsettled', network: 'base' };
    fetchMock = fetchFor({ relaySettle: settlement }, events);
    vi.stubGlobal('fetch', fetchMock);
    adapter.mockImplementation(async () => {
      events.push('adapter');
      return { answer: 'answer' };
    });
    const signature = 'raw-payment-signature';

    const res = await GET(
      new Request(url(), { headers: { 'PAYMENT-SIGNATURE': signature } }),
    );

    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(await res.json()).toEqual({ answer: 'answer' });
    expect(events).toEqual(['relay verify', 'adapter', 'relay settle']);
    expect(callsTo(fetchMock, 'verify')).toHaveLength(0);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    for (const endpoint of ['verify', 'settle'] as const) {
      const init = relayCallsTo(fetchMock, endpoint)[0][1] as RequestInit;
      expect(init.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.parse(String(init.body))).toEqual({
        resourceId,
        paymentSignatureHeader: signature,
      });
    }
    expect(
      JSON.parse(Buffer.from(res.headers.get('X-PAYMENT-RESPONSE')!, 'base64').toString('utf8')),
    ).toEqual(settlement);
  });

  it('uses the USDC v1 relay for an X-PAYMENT payload on the Base network', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    const rawPaymentHeader = Buffer.from(
      JSON.stringify({ network: 'base', authorization: 'usdc-payment' }),
    ).toString('base64');

    const res = await GET(request('?q=hello', rawPaymentHeader));

    expect(res.status).toBe(200);
    expect(relayCallsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(1);
    expect(callsTo(fetchMock, 'verify')).toHaveLength(0);
    for (const endpoint of ['verify', 'settle'] as const) {
      const init = relayCallsTo(fetchMock, endpoint)[0][1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({
        resourceId,
        paymentHeader: rawPaymentHeader,
      });
    }
  });

  it('keeps an eip155:137 X-PAYMENT payload on the JPYC rail', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    const polygonPayload = { network: 'eip155:137', authorization: 'jpyc-payment' };
    const rawPaymentHeader = Buffer.from(JSON.stringify(polygonPayload)).toString('base64');

    const res = await GET(request('?q=hello', rawPaymentHeader));

    expect(res.status).toBe(200);
    expect(callsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(1);
    expect(relayCallsTo(fetchMock, 'verify')).toHaveLength(0);
    const verifyInit = callsTo(fetchMock, 'verify')[0][1] as RequestInit;
    expect(JSON.parse(String(verifyInit.body))).toMatchObject({ paymentPayload: polygonPayload });
  });

  it.each([
    [{ isValid: false, invalidReason: 'usdc_authorization_invalid' }, 'usdc_authorization_invalid'],
    [{ isValid: false }, 'payment_invalid'],
  ])('does not call the adapter when USDC verification fails', async (relayVerify, error) => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor({ relayVerify });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(
      new Request(url(), { headers: { 'PAYMENT-SIGNATURE': 'raw-signature' } }),
    );

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(await res.json()).toMatchObject({ error });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBe(paymentRequiredHeader);
    expect(adapter).not.toHaveBeenCalled();
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('does not settle USDC when the adapter throws', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    adapter.mockRejectedValue(new Error('upstream unavailable'));

    const res = await GET(
      new Request(url(), { headers: { 'PAYMENT-SIGNATURE': 'raw-signature' } }),
    );

    expect(res.status).toBe(502);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
    expect(relayCallsTo(fetchMock, 'verify')).toHaveLength(1);
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('does not return the answer when USDC settlement fails', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor({
      relaySettle: { success: false, errorReason: 'usdc_settlement_declined' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(
      new Request(url(), { headers: { 'PAYMENT-SIGNATURE': 'raw-signature' } }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expectNoStore(res);
    expect(body.error).toBe('usdc_settlement_declined');
    expect(body.answer).toBeUndefined();
    expect(res.headers.get('PAYMENT-REQUIRED')).toBe(paymentRequiredHeader);
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(1);
  });

  it.each([
    ['verify', { relayVerifyThrows: true }, 'payment_verification_failed'],
    ['settle', { relaySettleThrows: true }, 'payment_settlement_failed'],
  ] as const)(
    'maps a USDC relay %s exception to the existing 500 wrapper',
    async (_endpoint, state, error) => {
      vi.stubEnv('MY_RESOURCE_ID', resourceId);
      fetchMock = fetchFor(state);
      vi.stubGlobal('fetch', fetchMock);

      const res = await GET(
        new Request(url(), { headers: { 'PAYMENT-SIGNATURE': 'raw-signature' } }),
      );

      expect(res.status).toBe(500);
      expectNoStore(res);
      expect(await res.json()).toEqual({ error });
    },
  );

  it('caches a valid USDC face across requests for five minutes', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);

    await GET(new Request(url()));
    await GET(new Request(url('?q=again')));

    expect(relayCallsTo(fetchMock, 'requirements')).toHaveLength(1);
  });

  it('does not cache a null USDC face', async () => {
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    fetchMock = fetchFor({ requirementsStatus: 404 });
    vi.stubGlobal('fetch', fetchMock);

    await GET(new Request(url()));
    await GET(new Request(url('?q=again')));

    expect(relayCallsTo(fetchMock, 'requirements')).toHaveLength(2);
  });
});
