// OpenPay への呼び出しの時間切れ、verify / settle の応答の読み分け、失敗の記録に何を書くか。
// 応答の全パターン (状態 × 本文) は golden.test.ts の 6・7・13・14 が場面ごとに固定している。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, HEAD } from '@/app/api/consult/route';
import { selectedAdapter } from '@/lib/adapters';
import { resetClaims } from '@/lib/claims';
import { resetAcceptsCache } from '@/lib/listing';
import { settleOutcome, verifyOutcome } from '@/lib/openpay';
import { resetArcProblemLog, resetUsdcFaceCache } from '@/lib/usdcFace';

import {
  OPENPAY, listing, merchant, paymentHeader, paymentSignatureFor, resource, resourceId, response, usdcFace,
  usdcMerchant, v2Accept, jpycPaymentHeader,
} from './fixtures';

vi.mock('@/lib/adapters', () => ({ selectedAdapter: vi.fn() }));

type Endpoint = 'discovery' | 'requirements' | 'facilitator verify' | 'facilitator settle' | 'relay verify' | 'relay settle';

const ENDPOINT_BY_URL: Record<string, Endpoint> = {
  [`${OPENPAY}/api/discovery/${resourceId}`]: 'discovery',
  [`${OPENPAY}/api/x402/relay/requirements?resourceId=${resourceId}`]: 'requirements',
  [`${OPENPAY}/api/facilitator/verify`]: 'facilitator verify',
  [`${OPENPAY}/api/facilitator/settle`]: 'facilitator settle',
  [`${OPENPAY}/api/x402/relay/verify`]: 'relay verify',
  [`${OPENPAY}/api/x402/relay/settle`]: 'relay settle',
};
const BODIES: Record<Endpoint, unknown> = {
  discovery: listing,
  requirements: usdcFace,
  'facilitator verify': { isValid: true },
  'facilitator settle': { success: true, transaction: '0xjpyc' },
  'relay verify': { isValid: true },
  'relay settle': { success: true, transaction: '0xusdc' },
};
const JPYC = { 'X-PAYMENT': paymentHeader };
const BASE_V2 = { 'PAYMENT-SIGNATURE': paymentSignatureFor(v2Accept) };
const url = (q = 'hello') => `${resource}?q=${q}`;

/** How one endpoint misbehaves: it never answers, or it answers and then the body never arrives. */
type Stall = 'no response' | 'no body';

/** A redirect answered by an OpenPay endpoint: the status, and the JSON body sent with it (none if undefined). */
type Redirect = { status: number; body: unknown };
const ELSEWHERE = 'https://elsewhere.example/answer';
// リダイレクトの先が返す答え。たどってしまうと、verify は通り (上流が動く)、settle は「断られた」の 402 になる。
const ELSEWHERE_ANSWER: Partial<Record<Endpoint, [unknown, number]>> = {
  'facilitator verify': [{ isValid: true }, 200],
  'relay verify': [{ isValid: true }, 200],
  'facilitator settle': [{ success: false, errorReason: 'invalid_signature' }, 400],
  'relay settle': [{ success: false, errorReason: 'invalid_signature' }, 400],
};

describe('OpenPay calls', () => {
  // AbortSignal.timeout を差し替えて、渡された待ち時間を記録し、テストから時間切れを起こせるようにする。
  let timeouts: Array<{ ms: number; controller: AbortController }>;
  let calls: Array<{
    endpoint: Endpoint;
    method: string | undefined;
    redirect: RequestRedirect | undefined;
    signal: AbortSignal | null | undefined;
  }>;
  let stalled: Partial<Record<Endpoint, Stall>>;
  let redirecting: Partial<Record<Endpoint, Redirect>>;
  // リダイレクトの先へ行った endpoint。
  let followed: Endpoint[];
  let adapter: ReturnType<typeof vi.fn>;

  const abortError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(abortError()));
  });

  /** Runs the request and fires the timeout of the stalled endpoint once the gateway is waiting on it. */
  async function requestWithTimeout(endpoint: Endpoint, headers: Record<string, string>): Promise<Response> {
    const pending = GET(new Request(url(), { headers }));
    await vi.waitFor(() => expect(calls.map((call) => call.endpoint)).toContain(endpoint));
    const { signal } = calls.find((call) => call.endpoint === endpoint)!;
    timeouts.find(({ controller }) => controller.signal === signal)!.controller.abort(abortError());
    return pending;
  }

  beforeEach(() => {
    resetClaims();
    resetAcceptsCache();
    resetUsdcFaceCache();
    resetArcProblemLog();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    vi.stubEnv('EXPECTED_RECIPIENT', merchant);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    timeouts = [];
    calls = [];
    stalled = {};
    redirecting = {};
    followed = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      timeouts.push({ ms, controller });
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = ENDPOINT_BY_URL[String(input)];
      if (!endpoint) throw new Error(`unexpected fetch ${String(input)}`);
      const signal = init?.signal;
      calls.push({ endpoint, method: init?.method, redirect: init?.redirect, signal });
      const stall = stalled[endpoint];
      if (stall === 'no response') return untilAborted(signal!);
      if (stall === 'no body') {
        return { status: 200, ok: true, json: () => untilAborted(signal!) } as unknown as Response;
      }
      const redirect = redirecting[endpoint];
      if (redirect) {
        // fetch の既定 (redirect: 'follow') をまねる。'manual' でなければ Location の先へ行き、その答えを返す。
        if (init?.redirect !== 'manual') {
          followed.push(endpoint);
          const [body, status] = ELSEWHERE_ANSWER[endpoint]!;
          return response(body, status);
        }
        return new Response(redirect.body === undefined ? null : JSON.stringify(redirect.body), {
          status: redirect.status,
          headers: {
            location: ELSEWHERE,
            ...(redirect.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        });
      }
      return response(BODIES[endpoint]);
    }));
    adapter = vi.fn().mockResolvedValue({ answer: 'answer' });
    vi.mocked(selectedAdapter).mockReturnValue(adapter as never);
  });

  afterEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('gives every call its own time limit: reads 5 s, verify 35 s, settle 60 s', async () => {
    expect((await GET(new Request(url(), { headers: JPYC }))).status).toBe(200);
    resetAcceptsCache();
    resetUsdcFaceCache();
    expect((await GET(new Request(url(), { headers: BASE_V2 }))).status).toBe(200);

    const limit = (endpoint: Endpoint) => calls
      .filter((call) => call.endpoint === endpoint)
      .map(({ signal }) => timeouts.find(({ controller }) => controller.signal === signal)?.ms);
    expect(limit('discovery')).toEqual([5_000, 5_000]);
    expect(limit('requirements')).toEqual([5_000, 5_000]);
    expect(limit('facilitator verify')).toEqual([35_000]);
    expect(limit('facilitator settle')).toEqual([60_000]);
    expect(limit('relay verify')).toEqual([35_000]);
    expect(limit('relay settle')).toEqual([60_000]);
    // 1 回の呼び出しに 1 つの signal。使い回さない。
    expect(new Set(calls.map((call) => call.signal)).size).toBe(calls.length);
  });

  it.each<Stall>(['no response', 'no body'])('discovery with %s: 500, nothing else is called', async (stall) => {
    stalled.discovery = stall;
    const res = await requestWithTimeout('discovery', JPYC);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'accepts_unavailable' });
    expect(calls.map((call) => call.endpoint)).toEqual(['discovery']);
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each<Stall>(['no response', 'no body'])('requirements with %s: the USDC face is left out, JPYC still sells', async (stall) => {
    stalled.requirements = stall;
    const unpaid = await requestWithTimeout('requirements', {});
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(((await unpaid.json()) as { accepts: unknown[] }).accepts).toHaveLength(1);
  });

  it.each<[Endpoint, Record<string, string>, Stall]>([
    ['facilitator verify', JPYC, 'no response'],
    ['facilitator verify', JPYC, 'no body'],
    ['relay verify', BASE_V2, 'no response'],
    ['relay verify', BASE_V2, 'no body'],
  ])('%s with %s (%s): 503, upstream and settle do not run', async (endpoint, headers, stall) => {
    stalled[endpoint] = stall;
    const res = await requestWithTimeout(endpoint, headers);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toEqual({ error: 'payment_service_unavailable' });
    expect(adapter).not.toHaveBeenCalled();
    expect(calls.some((call) => call.endpoint.endsWith('settle'))).toBe(false);
  });

  it.each<[Endpoint, Record<string, string>, Stall]>([
    ['facilitator settle', JPYC, 'no response'],
    ['facilitator settle', JPYC, 'no body'],
    ['relay settle', BASE_V2, 'no response'],
    ['relay settle', BASE_V2, 'no body'],
  ])('%s with %s (%s): 500 settlement_unknown, the answer is not released', async (endpoint, headers, stall) => {
    stalled[endpoint] = stall;
    const res = await requestWithTimeout(endpoint, headers);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // 「払い直して」と読める 402 にも、決済済みと読めるヘッダーにもしない。
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'settlement_unknown' });
    expect(body).not.toContain('answer');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.endpoint === endpoint)).toHaveLength(1);
  });

  it('posts to OpenPay without following redirects; the GET reads keep the default', async () => {
    expect((await GET(new Request(url(), { headers: JPYC }))).status).toBe(200);
    resetAcceptsCache();
    resetUsdcFaceCache();
    expect((await GET(new Request(url(), { headers: BASE_V2 }))).status).toBe(200);

    const isPost = (endpoint: Endpoint) => endpoint.endsWith(' verify') || endpoint.endsWith(' settle');
    const posts = calls.filter((call) => isPost(call.endpoint));
    const reads = calls.filter((call) => !isPost(call.endpoint));
    expect(posts.map((call) => call.endpoint))
      .toEqual(['facilitator verify', 'facilitator settle', 'relay verify', 'relay settle']);
    for (const call of posts) expect([call.method, call.redirect]).toEqual(['POST', 'manual']);
    expect(reads.map((call) => call.endpoint)).toEqual(['discovery', 'requirements', 'discovery', 'requirements']);
    for (const call of reads) expect([call.method, call.redirect]).toEqual([undefined, undefined]);
  });

  const RAILS = { jpyc: JPYC, base: BASE_V2 } as const;
  const REDIRECT_STATUSES = [302, 307, 308];
  const redirectCases = (endpoints: Array<[Endpoint, keyof typeof RAILS]>, claim: unknown) =>
    endpoints.flatMap(([endpoint, rail]) => REDIRECT_STATUSES.flatMap((status) =>
      [undefined, claim].map((body): [Endpoint, keyof typeof RAILS, number, unknown] => [endpoint, rail, status, body])));

  it.each(redirectCases([['facilitator verify', 'jpyc'], ['relay verify', 'base']], { isValid: true }))(
    '%s (%s) answering %i with body %j: 503, upstream and settle do not run',
    async (endpoint, rail, status, body) => {
      redirecting[endpoint] = { status, body };
      const res = await GET(new Request(url(), { headers: RAILS[rail] }));
      expect(res.status).toBe(503);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(await res.json()).toEqual({ error: 'payment_service_unavailable' });
      expect(adapter).not.toHaveBeenCalled();
      expect(calls.filter((call) => call.endpoint === endpoint)).toHaveLength(1);
      expect(calls.some((call) => call.endpoint.endsWith(' settle'))).toBe(false);
      expect(followed).toEqual([]);
      expect(vi.mocked(console.error).mock.calls)
        .toEqual([[`[openpay-x402] verify unavailable (${rail}, HTTP ${status})`]]);
    },
  );

  it.each(redirectCases([['facilitator settle', 'jpyc'], ['relay settle', 'base']], { success: true, transaction: '0xabc' }))(
    '%s (%s) answering %i with body %j: 500 settlement_unknown, no receipt and no 402',
    async (endpoint, rail, status, body) => {
      redirecting[endpoint] = { status, body };
      const res = await GET(new Request(url(), { headers: RAILS[rail] }));
      expect(res.status).toBe(500);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
      expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
      expect(await res.json()).toEqual({ error: 'settlement_unknown' });
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(calls.filter((call) => call.endpoint === endpoint)).toHaveLength(1);
      expect(followed).toEqual([]);
      expect(vi.mocked(console.error).mock.calls)
        .toEqual([[`[openpay-x402] settle outcome unknown, content not delivered (${rail}, HTTP ${status})`]]);
    },
  );

  it('writes only fixed words, the rail and the HTTP status to the log', async () => {
    const secretQ = 'SECRET-QUESTION';
    const secretRemote = 'SECRET-REMOTE-TEXT';
    const secretAnswer = 'SECRET-ANSWER';
    const fetchMock = vi.mocked(fetch);
    const answerWith = (endpoint: Endpoint, body: unknown, status: number) => {
      const normal = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        (ENDPOINT_BY_URL[String(input)] === endpoint ? response(body, status) : normal(input, init)));
    };
    // A different payment per request: a payment that reached settle stays reserved.
    const requests: Array<[Endpoint | null, unknown, number, Record<string, string>]> = [
      ['facilitator verify', { isValid: true, invalidReason: secretRemote, payer: secretRemote }, 503, JPYC],
      ['relay verify', { error: secretRemote }, 500, BASE_V2],
      ['facilitator settle', { success: true, transaction: secretRemote }, 502, { 'X-PAYMENT': jpycPaymentHeader(3) }],
      ['relay settle', { success: false, errorReason: 'pending', transaction: secretRemote }, 202,
        { 'PAYMENT-SIGNATURE': paymentSignatureFor(v2Accept, 0x2004) }],
      [null, null, 0, { 'X-PAYMENT': jpycPaymentHeader(5) }],
    ];
    const normal = fetchMock.getMockImplementation()!;
    adapter.mockResolvedValue({ answer: secretAnswer });
    for (const [endpoint, body, status, headers] of requests) {
      fetchMock.mockImplementation(normal);
      if (endpoint) answerWith(endpoint, body, status);
      else adapter.mockRejectedValue(new Error(`${secretRemote} ${secretQ}`));
      await GET(new Request(url(secretQ), { headers }));
    }

    const lines = vi.mocked(console.error).mock.calls.map((args) => args.join(' '));
    expect(lines).toEqual([
      '[openpay-x402] verify unavailable (jpyc, HTTP 503)',
      '[openpay-x402] verify unavailable (base, HTTP 500)',
      '[openpay-x402] settle outcome unknown, content not delivered (jpyc, HTTP 502)',
      '[openpay-x402] settle pending, content not delivered (base, HTTP 202)',
      '[openpay-x402] upstream failed, not charged (jpyc)',
    ]);
    for (const secret of [secretQ, secretRemote, secretAnswer, paymentHeader, BASE_V2['PAYMENT-SIGNATURE'], merchant]) {
      expect(lines.join('\n')).not.toContain(secret);
    }
  });

  it('logs a fixed line for an error the seller checks did not already log', async () => {
    // discovery を待つあいだに MY_RESOURCE_URL が消える。sellerPins を通らない例外になる。
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (ENDPOINT_BY_URL[String(input)] === 'discovery') vi.stubEnv('MY_RESOURCE_URL', '');
      return normal(input, init);
    });

    const res = await GET(new Request(url('SECRET-QUESTION'), { headers: JPYC }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'accepts_unavailable' });
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['[openpay-x402] payment terms unavailable (unexpected error)'],
    ]);
  });

  it('does not log a second line when the seller checks already logged the reason', async () => {
    vi.stubEnv('EXPECTED_RECIPIENT', usdcMerchant);
    const res = await GET(new Request(url(), { headers: JPYC }));
    expect(res.status).toBe(500);
    expect(vi.mocked(console.error).mock.calls).toEqual([['[openpay-x402] JPYC recipient mismatch']]);
  });

  it.each<[Endpoint, string, string]>([
    ['relay verify', 'payment_verification_failed', 'verify'],
    ['relay settle', 'payment_settlement_failed', 'settle'],
  ])('%s refused with 409 and the refreshed terms fail unexpectedly: 500 %s, one fixed log line', async (endpoint, error, step) => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let refused = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const hit = ENDPOINT_BY_URL[String(input)];
      if (hit === endpoint) {
        refused = true;
        return response({ error: 'requirements_mismatch' }, 409);
      }
      if (hit === 'requirements' && refused) {
        // 取り直した決済条件を確かめるところで、sellerPins が記録しない例外が起きる。
        const terms = { get resourceId(): never { throw new Error('SECRET-REMOTE-TEXT'); } };
        return { status: 200, ok: true, json: async () => terms } as unknown as Response;
      }
      return normal(input, init);
    });

    const res = await GET(new Request(url('SECRET-QUESTION'), { headers: BASE_V2 }));

    expect(res.status).toBe(500);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toEqual({ error });
    expect(vi.mocked(console.error).mock.calls)
      .toEqual([[`[openpay-x402] ${step} not sent or refused by OpenPay (unexpected error)`]]);
  });

  it('HEAD with a payment header calls nothing and is refused; HEAD without one gets the 402 headers', async () => {
    for (const headers of [JPYC, BASE_V2, { 'PAYMENT-SIGNATURE': '' }]) {
      const res = await HEAD(new Request(url(), { method: 'HEAD', headers }));
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(adapter).not.toHaveBeenCalled();

    const unpaid = await HEAD(new Request(url(), { method: 'HEAD' }));
    const get = await GET(new Request(url()));
    expect(unpaid.status).toBe(402);
    expect(unpaid.body).toBeNull();
    expect([...unpaid.headers]).toEqual([...get.headers]);
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe('verifyOutcome', () => {
  it.each<[number | null, unknown, ReturnType<typeof verifyOutcome>]>([
    [200, { isValid: true }, { kind: 'valid' }],
    [200, { isValid: true, invalidReason: 'ignored' }, { kind: 'valid' }],
    [200, { isValid: false, invalidReason: 'insufficient_funds' }, { kind: 'rejected', reason: 'insufficient_funds' }],
    [200, { isValid: 1 }, { kind: 'rejected', reason: undefined }],
    [200, null, { kind: 'unavailable' }],
    [400, { isValid: false, invalidReason: 'bad_request' }, { kind: 'rejected', reason: 'bad_request' }],
    [400, { isValid: true }, { kind: 'rejected', reason: undefined }],
    [404, { error: 'not_found' }, { kind: 'rejected', reason: 'not_found' }],
    [400, { invalidReason: 'from_verdict', error: 'from_error' }, { kind: 'rejected', reason: 'from_verdict' }],
    [413, null, { kind: 'rejected', reason: undefined }],
    [429, { isValid: false, invalidReason: 'rate_limited' }, { kind: 'unavailable' }],
    [500, { isValid: true }, { kind: 'unavailable' }],
    [503, { isValid: false, invalidReason: 'kv_required' }, { kind: 'unavailable' }],
    [201, { isValid: true }, { kind: 'unavailable' }],
    [202, { isValid: true }, { kind: 'unavailable' }],
    [302, null, { kind: 'unavailable' }],
    [null, null, { kind: 'unavailable' }],
  ])('status %s, body %j', (status, body, expected) => {
    expect(verifyOutcome({ status, body: body as Record<string, unknown> | null })).toEqual(expected);
  });
});

describe('settleOutcome', () => {
  const receipt = { success: true, transaction: '0xabc' };
  const pending = { success: false, errorReason: 'pending', transaction: '0xabc' };

  it.each<[number | null, unknown, ReturnType<typeof settleOutcome>]>([
    [200, receipt, { kind: 'settled', receipt }],
    [200, { success: false, errorReason: 'reverted' }, { kind: 'rejected', reason: 'reverted' }],
    [200, { success: false }, { kind: 'rejected', reason: undefined }],
    // 200 でも、成功とも失敗ともはっきり言っていない本文は「分からない」。
    [200, {}, { kind: 'unknown' }],
    [200, { success: 'true' }, { kind: 'unknown' }],
    [200, { success: 0 }, { kind: 'unknown' }],
    [200, null, { kind: 'unknown' }],
    [202, pending, { kind: 'pending', receipt: pending }],
    [202, receipt, { kind: 'pending', receipt }],
    [202, null, { kind: 'pending', receipt: null }],
    [400, { success: true }, { kind: 'rejected', reason: undefined }],
    [400, { success: false, errorReason: 'invalid_signature' }, { kind: 'rejected', reason: 'invalid_signature' }],
    [409, { error: 'reservation_invalid' }, { kind: 'rejected', reason: 'reservation_invalid' }],
    [429, { error: 'rate_limited' }, { kind: 'rejected', reason: 'rate_limited' }],
    [500, receipt, { kind: 'unknown' }],
    [502, { success: false, errorReason: 'relay_error' }, { kind: 'unknown' }],
    [503, { success: false, errorReason: 'kv_required' }, { kind: 'unknown' }],
    [201, receipt, { kind: 'unknown' }],
    [302, null, { kind: 'unknown' }],
    [null, null, { kind: 'unknown' }],
  ])('status %s, body %j', (status, body, expected) => {
    expect(settleOutcome({ status, body: body as Record<string, unknown> | null })).toEqual(expected);
  });

  it.each(['Signature is invalid!', 'UPPER_CASE', 'a'.repeat(65), '', 'with space', 'line\nbreak', 42, null, { a: 1 }])(
    'does not pass the reason %j on to the buyer',
    (reason) => {
      expect(settleOutcome({ status: 200, body: { success: false, errorReason: reason } }))
        .toEqual({ kind: 'rejected', reason: undefined });
      expect(verifyOutcome({ status: 200, body: { isValid: false, invalidReason: reason } }))
        .toEqual({ kind: 'rejected', reason: undefined });
      expect(verifyOutcome({ status: 400, body: { error: reason } })).toEqual({ kind: 'rejected', reason: undefined });
    },
  );

  it('passes a 64-character snake_case reason on', () => {
    const reason = 'a_1'.repeat(21) + 'z';
    expect(reason).toHaveLength(64);
    expect(settleOutcome({ status: 200, body: { success: false, errorReason: reason } }))
      .toEqual({ kind: 'rejected', reason });
  });
});
