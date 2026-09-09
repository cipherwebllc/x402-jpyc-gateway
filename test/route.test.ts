import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLicenseGate,
  hasLicense,
  resolveLicense,
  LicenseError,
  LicenseRpcError,
} from 'openpay-x402-sdk';

import type { Adapter } from '@/lib/adapters/types';
import { selectedAdapter } from '@/lib/adapters';
import { resetAcceptsCache, resetUsdcFaceCache } from '@/lib/gate';
import { ensureLicense, resetLicenseForTests } from '@/lib/license';
import { descriptor, product } from './fixtures/license';

const licenseGateMock = vi.hoisted(() => ({
  ready: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  check: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({
  selectedAdapter: vi.fn(),
}));

vi.mock('openpay-x402-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openpay-x402-sdk')>();
  return {
    ...actual,
    hasLicense: vi.fn(),
    resolveLicense: vi.fn(),
    createLicenseGate: vi.fn(() => licenseGateMock),
  };
});

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
const payer = '0x1111111111111111111111111111111111111111';
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

const rails = ['JPYC', 'USDC v1', 'USDC v2'] as const;

function railRequest(rail: typeof rails[number], headers: Record<string, string> = {}): Request {
  if (rail !== 'JPYC') vi.stubEnv('MY_RESOURCE_ID', resourceId);
  const payment: Record<string, string> = rail === 'USDC v2'
    ? { 'PAYMENT-SIGNATURE': 'raw-signature' }
    : { 'X-PAYMENT': rail === 'USDC v1'
      ? Buffer.from(JSON.stringify({ network: 'base', authorization: 'usdc-payment' })).toString('base64')
      : paymentHeader };
  return new Request(url(), { headers: { ...payment, ...headers } });
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
      return response(state.relayVerify ?? { isValid: true, payer });
    }
    if (target === `${OPENPAY}/api/x402/relay/settle`) {
      events?.push('relay settle');
      if (state.relaySettleThrows) throw new Error('relay settle unavailable');
      return response(
        state.relaySettle ?? { success: true, transaction: '0xusdcsettled', network: 'base' },
      );
    }
    if (target === `${OPENPAY}/api/facilitator/verify`) {
      events?.push('verify');
      return response(state.verify ?? { isValid: true, payer });
    }
    if (target === `${OPENPAY}/api/facilitator/settle`) {
      events?.push('settle');
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
    resetLicenseForTests();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', undefined);
    vi.stubEnv('LICENSE_PRODUCT_ID', product);
    vi.stubEnv('LICENSE_SESSION_SECRET', 'test-license-session-secret-32-bytes-minimum');
    vi.mocked(resolveLicense).mockResolvedValue(descriptor);
    licenseGateMock.ready.mockResolvedValue(undefined);
    vi.mocked(hasLicense).mockResolvedValue({ holder: true, balance: 1n, blockNumber: 1n });
    vi.mocked(createLicenseGate).mockReturnValue(licenseGateMock);
    licenseGateMock.check.mockImplementation(() => {
      throw new LicenseError('invalid_session', 'invalid test session');
    });
    fetchMock = fetchFor();
    vi.stubGlobal('fetch', fetchMock);
    adapter = vi.fn<Adapter>();
    adapter.mockResolvedValue({ answer: 'answer' });
    vi.mocked(selectedAdapter).mockReturnValue(adapter);
  });

  afterEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
    resetLicenseForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.useRealTimers();
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

  it.each(['JPYC', 'USDC'] as const)(
    'admits a license holder and reaches settlement on the %s rail',
    async (rail) => {
      let paidRequest: Request;
      if (rail === 'USDC') {
        vi.stubEnv('MY_RESOURCE_ID', resourceId);
        paidRequest = new Request(url(), {
          headers: { 'PAYMENT-SIGNATURE': 'raw-signature' },
        });
      } else {
        paidRequest = request();
      }

      const res = await GET(paidRequest);

      expect(res.status).toBe(200);
      expect(vi.mocked(hasLicense)).toHaveBeenCalledWith(
        expect.objectContaining({ address: payer }),
      );
      if (rail === 'USDC') {
        expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(1);
      } else {
        expect(callsTo(fetchMock, 'settle')).toHaveLength(1);
      }
    },
  );

  it.each(['JPYC', 'USDC'] as const)(
    'rejects a non-holder before adapter and settlement on the %s rail',
    async (rail) => {
      vi.mocked(hasLicense).mockResolvedValue({ holder: false, balance: 0n, blockNumber: 1n });
      let paidRequest: Request;
      if (rail === 'USDC') {
        vi.stubEnv('MY_RESOURCE_ID', resourceId);
        paidRequest = new Request(url(), {
          headers: { 'PAYMENT-SIGNATURE': 'raw-signature' },
        });
      } else {
        paidRequest = request();
      }

      const res = await GET(paidRequest);

      expect(res.status).toBe(403);
      expectNoStore(res);
      expect(await res.json()).toEqual({
        error: 'license_required',
        product,
        productUrl: descriptor.productUrl,
      });
      expect(adapter).not.toHaveBeenCalled();
      expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
      expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
    },
  );

  it.each(['JPYC', 'USDC'] as const)(
    'returns 503 without caching an RPC failure on the %s rail',
    async (rail) => {
      vi.mocked(hasLicense).mockRejectedValue(new LicenseRpcError('test RPC unavailable'));
      const paidRequest = () => {
        if (rail === 'USDC') {
          vi.stubEnv('MY_RESOURCE_ID', resourceId);
          return new Request(url(), { headers: { 'PAYMENT-SIGNATURE': 'raw-signature' } });
        }
        return request();
      };

      const first = await GET(paidRequest());
      const second = await GET(paidRequest());

      expect(first.status).toBe(503);
      expect(second.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'license_check_unavailable' });
      expect(await second.json()).toEqual({ error: 'license_check_unavailable' });
      expect(vi.mocked(hasLicense)).toHaveBeenCalledTimes(2);
      expect(adapter).not.toHaveBeenCalled();
      expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
      expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
    },
  );

  it('returns 503 without settling when verification omits payer', async () => {
    fetchMock = fetchFor({ verify: { isValid: true } });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'license_check_unavailable' });
    expect(vi.mocked(hasLicense)).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('accepts a valid session without checking on-chain ownership', async () => {
    licenseGateMock.check.mockReturnValue({ address: payer, tokenId: 1n, exp: 2_000_000_000 });
    const paidRequest = new Request(url(), {
      headers: {
        Authorization: 'Bearer valid-license-session',
        'X-PAYMENT': paymentHeader,
      },
    });

    const res = await GET(paidRequest);

    expect(res.status).toBe(200);
    expect(licenseGateMock.check).toHaveBeenCalledWith('valid-license-session');
    expect(vi.mocked(hasLicense)).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(1);
  });

  it('returns 403 for an invalid session presented without payment', async () => {
    const res = await GET(
      new Request(url(), { headers: { Cookie: 'license_session=invalid-license-session' } }),
    );

    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(await res.json()).toMatchObject({
      error: 'license_required',
      product,
      productUrl: descriptor.productUrl,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a bare catalog probe at 402 with license metadata and untouched accepts', async () => {
    const res = await GET(new Request(url()));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expect(body.accepts).toEqual([
      { ...catalogAccept, resource: 'https://gateway.example.com/api/consult?q=hello' },
    ]);
    expect(body.license).toEqual({
      required: true,
      product,
      productUrl: descriptor.productUrl,
      contract: '0x2222222222222222222222222222222222222222',
      tokenId: descriptor.tokenId,
      chainId: 137,
    });
  });

  it('caches a payer ownership result for 60 seconds', async () => {
    const first = await GET(request());
    const second = await GET(request('?q=again'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(vi.mocked(hasLicense)).toHaveBeenCalledTimes(1);
    expect(callsTo(fetchMock, 'settle')).toHaveLength(2);
  });

  it('also caches a negative payer ownership result', async () => {
    vi.mocked(hasLicense).mockResolvedValue({ holder: false, balance: 0n, blockNumber: 1n });

    const first = await GET(request());
    const second = await GET(request('?q=again'));

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(vi.mocked(hasLicense)).toHaveBeenCalledTimes(1);
    expect(adapter).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it('fails closed with a generic body when license configuration is missing', async () => {
    vi.stubEnv('LICENSE_PRODUCT_ID', undefined);
    resetLicenseForTests();

    const res = await GET(new Request(url()));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({ error: 'license_unavailable' });
    expect(text).not.toContain('LICENSE_PRODUCT_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(rails)('orders verify → license → adapter → serialize → settle on %s', async (rail) => {
    const events: string[] = [];
    fetchMock = fetchFor({}, events);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(hasLicense).mockImplementation(async () => {
      events.push('license');
      return { holder: true, balance: 1n, blockNumber: 1n };
    });
    adapter.mockImplementation(async () => {
      events.push('adapter');
      return { toJSON() { events.push('serialize'); return { answer: 'answer' }; } };
    });

    const res = await GET(railRequest(rail));

    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(events).toEqual(rail === 'JPYC'
      ? ['verify', 'license', 'adapter', 'serialize', 'settle']
      : ['relay verify', 'license', 'adapter', 'serialize', 'relay settle']);
    expect(hasLicense).toHaveBeenCalledExactlyOnceWith({
      address: payer,
      chainId: descriptor.chainId,
      contract: descriptor.contract,
      tokenId: descriptor.tokenId,
    });
  });

  it.each(rails)('rejects a non-holder before adapter and settle, including %s headers', async (rail) => {
    vi.mocked(hasLicense).mockResolvedValue({ holder: false, balance: 0n, blockNumber: 1n });
    const res = await GET(railRequest(rail));
    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'license_required', product, productUrl: descriptor.productUrl });
    expect(adapter).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it.each(rails)('does not cache RPC errors or settle on %s', async (rail) => {
    vi.mocked(hasLicense).mockRejectedValue(new LicenseRpcError('private RPC details'));
    for (let i = 0; i < 2; i++) {
      const res = await GET(railRequest(rail));
      expect(res.status).toBe(503);
      expectNoStore(res);
      expect(await res.json()).toEqual({ error: 'license_check_unavailable' });
    }
    expect(hasLicense).toHaveBeenCalledTimes(2);
    expect(adapter).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
    expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
  });

  it.each(rails)('requires a string payer after verification on %s', async (rail) => {
    for (const invalidPayer of [undefined, null, 123, {}, []]) {
      const verification = { isValid: true, payer: invalidPayer };
      fetchMock = fetchFor({ verify: verification, relayVerify: verification });
      vi.stubGlobal('fetch', fetchMock);
      const res = await GET(railRequest(rail));
      expect(res.status).toBe(503);
      expectNoStore(res);
      expect(await res.json()).toEqual({ error: 'license_check_unavailable' });
      expect(callsTo(fetchMock, 'settle')).toHaveLength(0);
      expect(relayCallsTo(fetchMock, 'settle')).toHaveLength(0);
    }
    expect(hasLicense).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each(rails)('accepts a cookie session on %s without a payer ownership call', async (rail) => {
    licenseGateMock.check.mockReturnValue({ address: payer, tokenId: 1n, exp: 2_000_000_000 });
    const res = await GET(railRequest(rail, { Cookie: 'other=value; license_session=cookie%2Dsession' }));
    expect(res.status).toBe(200);
    expect(licenseGateMock.check).toHaveBeenCalledWith('cookie-session');
    expect(hasLicense).not.toHaveBeenCalled();
    expect(adapter).toHaveBeenCalledOnce();
  });

  it.each(rails)('falls back to the payer for invalid or expired sessions with %s payment', async (rail) => {
    for (const code of ['invalid_session', 'session_expired'] as const) {
      licenseGateMock.check.mockImplementation(() => { throw new LicenseError(code, 'private session details'); });
      const res = await GET(railRequest(rail, { Authorization: 'Bearer expired-session' }));
      expect(res.status).toBe(200);
    }
    expect(hasLicense).toHaveBeenCalledOnce();
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid_session', 'session_expired'] as const)('requires a license for %s without payment', async (code) => {
    licenseGateMock.check.mockImplementation(() => { throw new LicenseError(code, 'private details'); });
    const res = await GET(new Request(url(), { headers: { Authorization: 'Bearer invalid-session' } }));
    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'license_required', product, productUrl: descriptor.productUrl });
    expect(hasLicense).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['rpc_error', 503, 'license_check_unavailable'],
    ['nonce_store_error', 503, 'license_check_unavailable'],
    ['not_ready', 503, 'license_check_unavailable'],
    ['no_license', 403, 'license_required'],
    ['invalid_challenge', 400, 'license_verification_failed'],
    ['challenge_expired', 400, 'license_verification_failed'],
    ['invalid_signature', 400, 'license_verification_failed'],
    ['invalid_nonce', 400, 'license_verification_failed'],
  ] as const)('maps session SDK %s without exposing details', async (code, status, expectedError) => {
    licenseGateMock.check.mockImplementation(() => {
      throw code === 'rpc_error' ? new LicenseRpcError('private details') : new LicenseError(code, 'private details');
    });
    const res = await GET(railRequest('JPYC', { Authorization: 'Bearer session' }));
    expect(res.status).toBe(status);
    expectNoStore(res);
    expect(await res.json()).toEqual(expectedError === 'license_required'
      ? { error: expectedError, product, productUrl: descriptor.productUrl }
      : { error: expectedError });
    expect(hasLicense).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('expires the cached holder=%s verdict at 60 seconds', async (holder) => {
    vi.useFakeTimers();
    vi.mocked(hasLicense).mockResolvedValue({ holder, balance: holder ? 1n : 0n, blockNumber: 1n });
    expect((await GET(request())).status).toBe(holder ? 200 : 403);
    vi.advanceTimersByTime(59_999);
    expect((await GET(request())).status).toBe(holder ? 200 : 403);
    expect(hasLicense).toHaveBeenCalledOnce();
    vi.mocked(hasLicense).mockResolvedValue({ holder: !holder, balance: holder ? 0n : 1n, blockNumber: 2n });
    vi.advanceTimersByTime(1);
    expect((await GET(request())).status).toBe(holder ? 403 : 200);
    expect(hasLicense).toHaveBeenCalledTimes(2);
  });

  it('keeps the captured descriptor through an overlapping refresh', async () => {
    vi.useFakeTimers();
    vi.mocked(hasLicense).mockImplementation(async () => {
      vi.advanceTimersByTime(300_000);
      vi.mocked(resolveLicense).mockResolvedValue({
        ...descriptor,
        contract: '0x3333333333333333333333333333333333333333',
        productUrl: `https://open-pay.jp/@new-seller?product=${product}`,
      });
      await ensureLicense();
      return { holder: false, balance: 0n, blockNumber: 1n };
    });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'license_required', product, productUrl: descriptor.productUrl });
    expect(hasLicense).toHaveBeenCalledWith(expect.objectContaining({ contract: descriptor.contract }));
    expect(resolveLicense).toHaveBeenCalledTimes(2);
    expect(adapter).not.toHaveBeenCalled();
  });

});
