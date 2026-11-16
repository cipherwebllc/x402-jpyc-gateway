// 支払いの予約を通した GET /api/consult: 同じ支払いを 2 回処理しないこと (409)、いつ予約を外し、いつ残すか、
// 期限の窓、verify のあとの確かめ直し、facilitator の予約 token、settle の本文の大きさ、上流の時間切れ。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, maxDuration } from '@/app/api/consult/route';
import { selectedAdapter } from '@/lib/adapters';
import { DEADLINE_MS as COO_ICP_DEADLINE_MS } from '@/lib/adapters/coo-icp';
import { HTTP_TIMEOUT_MS } from '@/lib/adapters/http';
import type { Adapter } from '@/lib/adapters/types';
import { MAX_UPSTREAM_SECONDS, resetClaims, SETTLEMENT_GRACE_SECONDS } from '@/lib/claims';
import { resetAcceptsCache } from '@/lib/listing';
import {
  FACILITATOR_BODY_LIMIT_BYTES,
  READ_TIMEOUT_MS,
  RESERVATION_TOKEN_MAX_LENGTH,
  SETTLE_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
} from '@/lib/openpay';
import { UPSTREAM_DEADLINE_MS } from '@/lib/purchase';
import { resetArcProblemLog, resetUsdcFaceCache } from '@/lib/usdcFace';

import {
  OPENPAY, arcV2Accept, attacker, catalogAccept, jpycPayment, jpycPaymentHeader, listing, merchant, paymentSignatureFor,
  resource, resourceId, response, usdcFaceWithArc, usdcMerchant, usdcV1PaymentHeader, v2Accept,
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
const TOKEN = `x402r1_${'cd'.repeat(32)}`;
const DEFAULT_ANSWERS: Record<Endpoint, [unknown, number]> = {
  discovery: [listing, 200],
  requirements: [usdcFaceWithArc(), 200],
  'facilitator verify': [{ isValid: true, reservationToken: TOKEN }, 200],
  'facilitator settle': [{ success: true, transaction: '0xjpyc' }, 200],
  'relay verify': [{ isValid: true }, 200],
  'relay settle': [{ success: true, transaction: '0xusdc' }, 200],
};
const WINDOW_SECONDS = MAX_UPSTREAM_SECONDS + SETTLEMENT_GRACE_SECONDS;
const NOW_MS = Date.parse('2026-11-16T00:00:00Z');
const NOW = NOW_MS / 1000;

const paid = (headers: Record<string, string>, q = 'hello') => new Request(`${resource}?q=${q}`, { headers });
const jpyc = (n: number, authorization: Record<string, unknown> = {}) => ({ 'X-PAYMENT': jpycPaymentHeader(n, authorization) });

describe('authorization claims on GET /api/consult', () => {
  let answers: Partial<Record<Endpoint, [unknown, number]>>;
  let posts: Array<{ endpoint: Endpoint; body: Record<string, unknown> }>;
  let adapter: ReturnType<typeof vi.fn<Adapter>>;
  let warnings: string[];

  const postsTo = (endpoint: Endpoint) => posts.filter((post) => post.endpoint === endpoint);

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
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    answers = {};
    posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = ENDPOINT_BY_URL[String(input)];
      if (!endpoint) throw new Error(`unexpected fetch ${String(input)}`);
      if (init?.method === 'POST') posts.push({ endpoint, body: JSON.parse(String(init.body)) });
      const [body, status] = answers[endpoint] ?? DEFAULT_ANSWERS[endpoint];
      return response(body, status);
    }));
    adapter = vi.fn<Adapter>(async ({ q }) => ({ answer: q }));
    vi.mocked(selectedAdapter).mockReset().mockReturnValue(adapter);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('a payment already in use here', () => {
    it('answers 409 without asking for another payment, and calls nothing', async () => {
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
      posts = [];

      const res = await GET(paid(jpyc(1)));

      expect(res.status).toBe(409);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(await res.json()).toEqual({
        error: 'authorization_reserved',
        message: 'This payment authorization is already being processed or was already used here. Do not pay again.',
      });
      expect(posts).toEqual([]);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(warnings).toContain('[openpay-x402] claim refused: authorization reserved (jpyc)');
    });

    it('refuses the same payment while the first request is still waiting on the upstream', async () => {
      let finish!: () => void;
      adapter.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ answer: 'first' }); }));
      const first = GET(paid(jpyc(1)));
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));

      expect((await GET(paid(jpyc(1)))).status).toBe(409);
      expect(postsTo('facilitator verify')).toHaveLength(1);

      finish();
      expect((await first).status).toBe(200);
    });

    it('refuses the same JPYC authorization for another question', async () => {
      expect((await GET(paid(jpyc(1), 'first'))).status).toBe(200);
      expect((await GET(paid(jpyc(1), 'second'))).status).toBe(409);
      expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('treats one USDC nonce sent as v1 X-PAYMENT and as v2 PAYMENT-SIGNATURE as one payment', async () => {
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x31) }))).status).toBe(200);
      expect((await GET(paid({ 'PAYMENT-SIGNATURE': paymentSignatureFor(v2Accept, 0x31) }))).status).toBe(409);
      expect(postsTo('relay verify')).toHaveLength(1);
    });

    it('keys an Arc authorization re-wrapped as a Base payment apart, and frees it when the relay refuses it', async () => {
      expect((await GET(paid({ 'PAYMENT-SIGNATURE': paymentSignatureFor(arcV2Accept, 0x41) }))).status).toBe(200);
      answers['relay verify'] = [{ isValid: false, invalidReason: 'invalid_signature' }, 400];
      const rewrapped = { 'PAYMENT-SIGNATURE': paymentSignatureFor(v2Accept, 0x41) };

      expect((await GET(paid(rewrapped))).status).toBe(402);
      expect((await GET(paid(rewrapped))).status).toBe(402);
      expect(postsTo('relay verify').map((post) => post.body.paymentRequirements))
        .toEqual([arcV2Accept, expect.objectContaining({ network: 'base' }), expect.objectContaining({ network: 'base' })]);
      expect(adapter).toHaveBeenCalledTimes(1);
    });
  });

  describe('releasing a claim before settle, keeping it after', () => {
    // How the first request with payment 1 ends, and whether payment 1 can then be sent again.
    const cases: Array<[string, () => void, number, 'released' | 'kept']> = [
      ['verify rejected', () => { answers['facilitator verify'] = [{ isValid: false, invalidReason: 'invalid_signature' }, 200]; }, 402, 'released'],
      ['verify refused with 4xx', () => { answers['facilitator verify'] = [{ invalidReason: 'payload_too_large' }, 413]; }, 402, 'released'],
      ['verify unavailable', () => { answers['facilitator verify'] = [{ error: 'kv_required' }, 503]; }, 503, 'released'],
      ['upstream failed', () => { adapter.mockRejectedValueOnce(new Error('down')); }, 502, 'released'],
      ['settled', () => {}, 200, 'kept'],
      ['settle rejected', () => { answers['facilitator settle'] = [{ success: false, errorReason: 'invalid_signature' }, 200]; }, 402, 'kept'],
      ['settle refused with 409', () => { answers['facilitator settle'] = [{ success: false, errorReason: 'reservation_invalid' }, 409]; }, 402, 'kept'],
      ['settle pending', () => { answers['facilitator settle'] = [{ success: false, errorReason: 'pending' }, 202]; }, 502, 'kept'],
      ['settle outcome unknown', () => { answers['facilitator settle'] = [null, 500]; }, 500, 'kept'],
    ];

    it.each(cases)('%s', async (_, arrange, status, after) => {
      arrange();
      expect((await GET(paid(jpyc(1)))).status).toBe(status);
      answers = {};

      const again = await GET(paid(jpyc(1)));

      expect(again.status).toBe(after === 'released' ? 200 : 409);
    });

    it('forgets a settled payment at its validBefore (the same nonce signed again is sent to the relay)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      const payment = (validBefore: number) => ({ 'X-PAYMENT': usdcV1PaymentHeader(0x71, { validBefore: String(validBefore) }) });
      expect((await GET(paid(payment(NOW + 300)))).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue((NOW + 299) * 1000);
      expect((await GET(paid(payment(NOW + 600)))).status).toBe(409);
      vi.mocked(Date.now).mockReturnValue((NOW + 300) * 1000);
      expect((await GET(paid(payment(NOW + 600)))).status).toBe(200);
      expect(postsTo('relay verify')).toHaveLength(2);
    });

    it('releases the claim when settle is refused before anything is sent (the seller pin changed during the upstream call)', async () => {
      adapter.mockImplementationOnce(async () => {
        vi.stubEnv('EXPECTED_RECIPIENT', attacker);
        return { answer: 'first' };
      });
      const res = await GET(paid(jpyc(1)));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'payment_settlement_failed' });
      expect(postsTo('facilitator settle')).toEqual([]);

      vi.stubEnv('EXPECTED_RECIPIENT', merchant);
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
    });

    it('releases a USDC claim when the relay answers 409 and the terms cannot be fetched again', async () => {
      answers['relay verify'] = [{ error: 'requirements_mismatch' }, 409];
      const fetchMock = vi.mocked(fetch);
      const normal = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        // The terms are fetched again after the relay's 409, and that fetch fails.
        if (ENDPOINT_BY_URL[String(input)] === 'relay verify') answers.requirements = [{}, 503];
        return normal(input, init);
      });
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x51) }))).status).toBe(500);
      answers = {};
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x51) }))).status).toBe(200);
    });
  });

  describe('payments that cannot be claimed', () => {
    it.each([
      ['a JPYC payment without an intentSalt', jpyc(1, { intentSalt: undefined })],
      ['a JPYC payment with a numeric validBefore', jpyc(1, { validBefore: 4102444800 })],
      ['a USDC v1 payment without a nonce', { 'X-PAYMENT': usdcV1PaymentHeader(1, { nonce: undefined }) }],
      ['a USDC v2 payment without a payer', { 'PAYMENT-SIGNATURE': paymentSignatureFor(v2Accept, 1, { from: undefined }) }],
      ['an Arc payment without a validBefore', { 'PAYMENT-SIGNATURE': paymentSignatureFor(arcV2Accept, 1, { validBefore: undefined }) }],
    ])('answers 402 invalid_payment_payload to %s without calling OpenPay', async (_, headers) => {
      const res = await GET(paid(headers));
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'invalid_payment_payload' });
      expect(posts).toEqual([]);
      expect(adapter).not.toHaveBeenCalled();
    });

    it('answers 500 when the listing terms cannot key a payment, without calling OpenPay', async () => {
      answers.discovery = [{ ...listing, accepts: [{ ...catalogAccept, asset: 'JPYC' }] }, 200];
      const res = await GET(paid(jpyc(1)));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'payment_verification_failed' });
      expect(posts).toEqual([]);
      expect(console.error).toHaveBeenCalledWith('[openpay-x402] JPYC payment terms not claimable');
    });
  });

  describe('the validity window', () => {
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    });

    it(`refuses a payment valid for less than ${WINDOW_SECONDS} seconds before verify`, async () => {
      const res = await GET(paid(jpyc(1, { validBefore: String(NOW + WINDOW_SECONDS - 1) })));
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'insufficient_validity_window' });
      expect(posts).toEqual([]);
      expect(warnings).toEqual(['[openpay-x402] claim refused: insufficient validity window (jpyc)']);
      expect((await GET(paid(jpyc(2, { validBefore: String(NOW + WINDOW_SECONDS) }))))).toHaveProperty('status', 200);
    });

    it('answers 409, not a new 402, to a replay near expiry while processing and after settle', async () => {
      const payment = jpyc(1, { validBefore: String(NOW + WINDOW_SECONDS) });
      let finish!: () => void;
      adapter.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ answer: 'first' }); }));
      const first = GET(paid(payment));
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
      vi.mocked(Date.now).mockReturnValue(NOW_MS + 1000);

      expect((await GET(paid(payment))).status).toBe(409);
      finish();
      expect((await first).status).toBe(200);
      expect((await GET(paid(payment))).status).toBe(409);
      expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('checks the window again after verify and runs nothing when verify used it up', async () => {
      const fetchMock = vi.mocked(fetch);
      const normal = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (ENDPOINT_BY_URL[String(input)] === 'facilitator verify') vi.mocked(Date.now).mockReturnValue(NOW_MS + 1000);
        return normal(input, init);
      });

      const res = await GET(paid(jpyc(1, { validBefore: String(NOW + WINDOW_SECONDS) })));

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'insufficient_validity_window' });
      expect(postsTo('facilitator verify')).toHaveLength(1);
      expect(adapter).not.toHaveBeenCalled();
      expect(postsTo('facilitator settle')).toEqual([]);
      expect(warnings).toContain('[openpay-x402] claim refused after verify: insufficient validity window (jpyc)');
    });
  });

  describe('the facilitator reservation token', () => {
    it('sends the token from verify to settle', async () => {
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
      expect(postsTo('facilitator verify')[0].body).not.toHaveProperty('reservationToken');
      expect(postsTo('facilitator settle')[0].body).toMatchObject({ reservationToken: TOKEN });
      expect(warnings).toEqual([]);
    });

    it.each([
      ['absent', { isValid: true }, 'verify ok without reservation token (jpyc)'],
      ['too long', { isValid: true, reservationToken: 'x'.repeat(RESERVATION_TOKEN_MAX_LENGTH + 1) }, 'verify returned malformed reservation token (jpyc)'],
      ['not a string', { isValid: true, reservationToken: 42 }, 'verify returned malformed reservation token (jpyc)'],
      ['with other characters', { isValid: true, reservationToken: 'x402r1_ab cd' }, 'verify returned malformed reservation token (jpyc)'],
    ])('settles without a token that is %s, and says so in the log', async (_, verify, line) => {
      answers['facilitator verify'] = [verify, 200];
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
      expect(postsTo('facilitator settle')[0].body).not.toHaveProperty('reservationToken');
      expect(warnings).toEqual([`[openpay-x402] ${line}`]);
    });

    it('never sends a token to the USDC relay', async () => {
      answers['relay verify'] = [{ isValid: true, reservationToken: TOKEN }, 200];
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader() }))).status).toBe(200);
      expect(postsTo('relay settle')[0].body).not.toHaveProperty('reservationToken');
    });
  });

  describe('the facilitator body limit', () => {
    // The settle body this request would send, with the longest token, in UTF-8 bytes.
    function settleBytes(q: string, description = catalogAccept.description): number {
      return Buffer.byteLength(JSON.stringify({
        x402Version: 1,
        paymentPayload: jpycPayment(1),
        paymentRequirements: { ...catalogAccept, description, resource: `${resource}?q=${q}` },
        reservationToken: 'x'.repeat(RESERVATION_TOKEN_MAX_LENGTH),
      }), 'utf8');
    }
    const fillTo = (bytes: number) => 'a'.repeat(bytes - settleBytes(''));

    it(`sells when the settle body is exactly ${FACILITATOR_BODY_LIMIT_BYTES} bytes, and refuses one more byte unpaid`, async () => {
      const longest = fillTo(FACILITATOR_BODY_LIMIT_BYTES);
      expect(settleBytes(longest)).toBe(FACILITATOR_BODY_LIMIT_BYTES);
      expect((await GET(paid(jpyc(1), longest))).status).toBe(200);

      posts = [];
      const res = await GET(paid(jpyc(2), `${longest}a`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'q_too_long' });
      expect(posts).toEqual([]);
      expect(adapter).toHaveBeenCalledTimes(1);
      // Refused before the claim: the same payment with a shorter question still sells.
      expect((await GET(paid(jpyc(2), 'short'))).status).toBe(200);
    });

    it('counts UTF-8 bytes, not characters', async () => {
      const description = '相談'.repeat(10);
      answers.discovery = [{ ...listing, accepts: [{ ...catalogAccept, description }] }, 200];
      const q = 'a'.repeat(FACILITATOR_BODY_LIMIT_BYTES - settleBytes('', description) + 1);
      // In characters the body fits; in bytes it is one over.
      expect(settleBytes(q, description) - (Buffer.byteLength(description) - description.length))
        .toBeLessThanOrEqual(FACILITATOR_BODY_LIMIT_BYTES);
      expect((await GET(paid(jpyc(1), q))).status).toBe(400);
    });

    it('does not limit USDC payments (the relay is not sent the question)', async () => {
      const q = 'a'.repeat(5000);
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader() }, q))).status).toBe(200);
    });
  });

  describe('the upstream deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(NOW_MS);
    });

    it('answers 502 at the deadline without settling, and frees the payment only once the upstream call ends', async () => {
      let finish!: () => void;
      adapter.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ answer: 'late' }); }));
      let settled = false;
      const first = GET(paid(jpyc(1))).finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(UPSTREAM_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await first;

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'upstream_error' });
      expect(postsTo('facilitator settle')).toEqual([]);
      expect(console.error).toHaveBeenCalledWith('[openpay-x402] upstream timed out, not charged (jpyc)');
      // The upstream call is still running: the same payment must not start it again.
      expect((await GET(paid(jpyc(1)))).status).toBe(409);

      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
      expect(adapter).toHaveBeenCalledTimes(2);
    });

    it('keeps the claim of a timed-out upstream call past validBefore until the call ends', async () => {
      let finish!: () => void;
      adapter.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ answer: 'late' }); }));
      const validFor = (seconds: number) => ({ validBefore: String(Math.ceil(Date.now() / 1000) + seconds) });
      const first = GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x61, validFor(300)) }));
      await vi.advanceTimersByTimeAsync(UPSTREAM_DEADLINE_MS);
      expect((await first).status).toBe(502);

      // Past the first authorization's validBefore, the same payer and nonce signed again.
      await vi.advanceTimersByTimeAsync(301_000 - UPSTREAM_DEADLINE_MS);
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x61, validFor(300)) }))).status).toBe(409);

      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect((await GET(paid({ 'X-PAYMENT': usdcV1PaymentHeader(0x61, validFor(300)) }))).status).toBe(200);
      expect(adapter).toHaveBeenCalledTimes(2);
    });

    it('leaves no timer behind when the upstream answers in time', async () => {
      expect((await GET(paid(jpyc(1)))).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('gives every adapter its own deadline below the upstream deadline (so a timed-out call always ends)', () => {
    expect(COO_ICP_DEADLINE_MS).toBeLessThan(UPSTREAM_DEADLINE_MS);
    expect(HTTP_TIMEOUT_MS).toBeLessThan(UPSTREAM_DEADLINE_MS);
  });

  it('fits the slowest purchase in maxDuration, and settles before the relay forgets an Arc verify (15 minutes)', () => {
    const relayRefetchMs = READ_TIMEOUT_MS;
    const slowestMs = 2 * READ_TIMEOUT_MS + VERIFY_TIMEOUT_MS + relayRefetchMs + UPSTREAM_DEADLINE_MS +
      SETTLE_TIMEOUT_MS + relayRefetchMs;
    expect(slowestMs).toBeLessThan(maxDuration * 1000);
    // From the end of verify to the start of settle: the upstream deadline.
    expect(UPSTREAM_DEADLINE_MS).toBeLessThan(15 * 60_000);
    // The window a payment needs covers the upstream deadline.
    expect(MAX_UPSTREAM_SECONDS * 1000).toBe(UPSTREAM_DEADLINE_MS);
  });
});
