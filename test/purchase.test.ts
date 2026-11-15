import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choosePayment, type PaymentChoice } from '@/lib/purchase';
import type { UsdcFace } from '@/lib/types';

import {
  OPENPAY, arcPaymentRequiredHeader, arcV2Accept, catalogAccept, listing, merchant, paymentHeader,
  paymentPayload, paymentRequiredHeader, paymentSignatureFor, resource, resourceId, response, usdcAccept,
  usdcFace, usdcFaceWithArc, usdcMerchant, v2Accept,
} from './fixtures';

vi.mock('@/lib/adapters', () => ({ selectedAdapter: vi.fn() }));

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const onNetwork = (network: string) => b64({ network, authorization: 'payment' });
const SIG_BASE = paymentSignatureFor(v2Accept);
const SIG_ARC = paymentSignatureFor(arcV2Accept);
const FACES: Record<'off' | 'base' | 'arc', UsdcFace | null> = {
  off: null,
  base: usdcFace,
  arc: usdcFaceWithArc(),
};

/** Base64 of JSON whose padded form ends with '=', with the padding removed. */
function unpadded(build: (filler: string) => unknown): string {
  for (let filler = ''; ; filler += 'x') {
    const padded = b64(build(filler));
    if (padded.endsWith('=')) return padded.replace(/=+$/, '');
  }
}

type Headers = { x?: string; sig?: string };
type Expected =
  | { reply: string; accepts: unknown; header?: string }
  | { jpyc: unknown }
  | { usdc: 'base' | 'arc'; with: 'paymentHeader' | 'paymentSignatureHeader' };

const NAMED_ACCEPTS: Array<[string, unknown]> = [['jpyc', [catalogAccept]], ['all', [catalogAccept, usdcAccept]]];
const NAMED_HEADERS: Record<string, string> = { [paymentRequiredHeader]: 'base', [arcPaymentRequiredHeader]: 'arc' };

// 選ばれた rail か、返す 402 の中身 (error・載せた accepts・PAYMENT-REQUIRED) に縮める。
async function summary(choice: PaymentChoice, face: UsdcFace | null): Promise<Expected> {
  if (choice.kind === 'jpyc') return { jpyc: choice.payload };
  if (choice.kind === 'usdc') {
    expect(choice.face).toBe(face);
    const [name] = Object.keys(choice.headers) as Array<'paymentHeader' | 'paymentSignatureHeader'>;
    return { usdc: choice.rail, with: name };
  }
  const res = choice.response;
  expect(res.status).toBe(402);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = await res.json();
  expect(body.x402Version).toBe(1);
  const named = NAMED_ACCEPTS.find(([, accepts]) => JSON.stringify(accepts) === JSON.stringify(body.accepts));
  const header = res.headers.get('PAYMENT-REQUIRED');
  return {
    reply: body.error,
    accepts: named ? named[0] : body.accepts,
    ...(header === null ? {} : { header: NAMED_HEADERS[header] ?? header }),
  };
}

describe('choosePayment', () => {
  it.each<[string, keyof typeof FACES, Headers, Expected]>([
    // PAYMENT-SIGNATURE (x402 v2) は空でも支払いで、X-PAYMENT があっても USDC の relay に回す。
    ['signature, USDC off', 'off', { sig: SIG_BASE }, { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['empty signature, USDC off', 'off', { sig: '' }, { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['signature and X-PAYMENT, USDC off', 'off', { x: paymentHeader, sig: SIG_BASE },
      { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['Base signature, Base face', 'base', { sig: SIG_BASE }, { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['empty signature, Base face', 'base', { sig: '' }, { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['signature and JPYC X-PAYMENT, Base face', 'base', { x: paymentHeader, sig: SIG_BASE },
      { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['Arc signature, Arc face', 'arc', { sig: SIG_ARC }, { usdc: 'arc', with: 'paymentSignatureHeader' }],
    ['unpadded Arc signature, Arc face', 'arc',
      { sig: unpadded((filler) => ({ x402Version: 2, accepted: arcV2Accept, payload: { signature: '0x00', filler } })) },
      { usdc: 'arc', with: 'paymentSignatureHeader' }],
    ['Arc signature with its terms in another key order, Arc face', 'arc',
      { sig: paymentSignatureFor(Object.fromEntries(Object.entries(arcV2Accept).reverse())) },
      { usdc: 'arc', with: 'paymentSignatureHeader' }],
    ['Arc signature, Base-only face', 'base', { sig: SIG_ARC }, { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['Base signature, Arc face', 'arc', { sig: SIG_BASE }, { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['signature for other Arc terms, Arc face', 'arc', { sig: paymentSignatureFor({ ...arcV2Accept, amount: '1' }) },
      { usdc: 'base', with: 'paymentSignatureHeader' }],
    ['unparseable signature, Arc face', 'arc', { sig: 'raw-signature' }, { usdc: 'base', with: 'paymentSignatureHeader' }],

    // X-PAYMENT (x402 v1) は厳密に復号し、network で rail を決める。
    ['JPYC X-PAYMENT, USDC off', 'off', { x: paymentHeader }, { jpyc: paymentPayload }],
    ['JPYC X-PAYMENT, Arc face', 'arc', { x: paymentHeader }, { jpyc: paymentPayload }],
    ['X-PAYMENT of JSON null', 'base', { x: b64(null) }, { jpyc: null }],
    ['X-PAYMENT not base64, USDC off', 'off', { x: 'not valid base64' },
      { reply: 'invalid_payment_payload', accepts: 'jpyc' }],
    ['X-PAYMENT not base64, Base face', 'base', { x: 'not valid base64' },
      { reply: 'invalid_payment_payload', accepts: 'all', header: 'base' }],
    ['X-PAYMENT not JSON, Arc face', 'arc', { x: Buffer.from('not json').toString('base64') },
      { reply: 'invalid_payment_payload', accepts: 'all', header: 'arc' }],
    ['unpadded X-PAYMENT', 'base', { x: unpadded((filler) => ({ ...paymentPayload, filler })) },
      { reply: 'invalid_payment_payload', accepts: 'all', header: 'base' }],
    ['X-PAYMENT on base, USDC off', 'off', { x: onNetwork('base') }, { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['X-PAYMENT on base-sepolia, USDC off', 'off', { x: onNetwork('base-sepolia') },
      { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['X-PAYMENT on eip155:8453, USDC off', 'off', { x: onNetwork('eip155:8453') },
      { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['X-PAYMENT on eip155:84532, USDC off', 'off', { x: onNetwork('eip155:84532') },
      { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['X-PAYMENT on base, Base face', 'base', { x: onNetwork('base') }, { usdc: 'base', with: 'paymentHeader' }],
    ['X-PAYMENT on base, Arc face', 'arc', { x: onNetwork('base') }, { usdc: 'base', with: 'paymentHeader' }],
    // USDC にするのは face の v1 network (base) と完全に一致するときだけ。ほかは JPYC の facilitator に回る。
    ['X-PAYMENT on eip155:8453, Base face', 'base', { x: onNetwork('eip155:8453') },
      { jpyc: { network: 'eip155:8453', authorization: 'payment' } }],
    ['X-PAYMENT on base-sepolia, Base face', 'base', { x: onNetwork('base-sepolia') },
      { jpyc: { network: 'base-sepolia', authorization: 'payment' } }],
    ['X-PAYMENT on eip155:5042, USDC off', 'off', { x: onNetwork('eip155:5042') },
      { reply: 'payment_invalid', accepts: 'jpyc' }],
    ['X-PAYMENT on eip155:5042, Base face', 'base', { x: onNetwork('eip155:5042') },
      { reply: 'payment_invalid', accepts: 'all', header: 'base' }],
    ['X-PAYMENT on eip155:5042002, Arc face', 'arc', { x: onNetwork('eip155:5042002') },
      { reply: 'payment_invalid', accepts: 'all', header: 'arc' }],
  ])('%s', async (_name, faceName, headers, expected) => {
    const face = FACES[faceName];
    const choice = choosePayment(
      { paymentHeader: headers.x ?? null, paymentSignatureHeader: headers.sig ?? null },
      [catalogAccept],
      face,
    );
    expect(await summary(choice, face)).toEqual(expected);
  });

  it('hands the relay the buyer header unchanged', () => {
    const x = onNetwork('base');
    expect(choosePayment({ paymentHeader: x, paymentSignatureHeader: null }, [catalogAccept], usdcFace))
      .toEqual({ kind: 'usdc', face: usdcFace, headers: { paymentHeader: x }, rail: 'base' });
    expect(choosePayment({ paymentHeader: x, paymentSignatureHeader: SIG_BASE }, [catalogAccept], usdcFace))
      .toEqual({ kind: 'usdc', face: usdcFace, headers: { paymentSignatureHeader: SIG_BASE }, rail: 'base' });
  });
});

// 同じモジュールで同時に動く 2 件の支払いの順番 (verify / 上流 / settle の fetch と応答)。await が 1 つ
// 増えるだけで入れ替わる (coo-icp の slot の割り当ても変わる)。期待値はリファクタ前のコード
// (a108724 の route.ts) で同じテストを動かして得た順番。lib/ はモックした '@/lib/adapters' と route だけを
// 読むので、同じ本文が分割の前後どちらでも動く。
describe('two concurrent paid requests on one module', () => {
  const ROUTES: Record<string, string> = {
    [`${OPENPAY}/api/discovery/${resourceId}`]: 'discovery',
    [`${OPENPAY}/api/x402/relay/requirements?resourceId=${resourceId}`]: 'requirements',
    [`${OPENPAY}/api/facilitator/verify`]: 'facilitator verify',
    [`${OPENPAY}/api/facilitator/settle`]: 'facilitator settle',
    [`${OPENPAY}/api/x402/relay/verify`]: 'relay verify',
    [`${OPENPAY}/api/x402/relay/settle`]: 'relay settle',
  };
  const BODIES: Record<string, unknown> = {
    discovery: listing,
    requirements: usdcFaceWithArc(),
    'facilitator verify': { isValid: true },
    'facilitator settle': { success: true, transaction: '0xjpyc' },
    'relay verify': { isValid: true },
    'relay settle': { success: true, transaction: '0xusdc' },
  };
  const PAID: Record<string, Record<string, string>> = {
    jpyc: { 'X-PAYMENT': paymentHeader },
    base1: { 'X-PAYMENT': onNetwork('base') },
    base2: { 'PAYMENT-SIGNATURE': SIG_BASE },
    arc: { 'PAYMENT-SIGNATURE': SIG_ARC },
  };
  let events: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    vi.stubEnv('EXPECTED_RECIPIENT', merchant);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const route = ROUTES[String(input)];
      events.push(`fetch ${route}`);
      return response(BODIES[route]);
    }));
    const { selectedAdapter } = await import('@/lib/adapters');
    vi.mocked(selectedAdapter).mockReset().mockReturnValue(async ({ q }) => {
      events.push(`adapter ${q}`);
      return { answer: q };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each<[string, string, string[]]>([
    ['base2', 'jpyc', ['fetch relay verify', 'fetch facilitator verify', 'adapter jpyc', 'adapter base2',
      'fetch facilitator settle', 'fetch relay settle', 'done jpyc', 'done base2']],
    ['jpyc', 'base2', ['fetch facilitator verify', 'fetch relay verify', 'adapter jpyc', 'fetch facilitator settle',
      'adapter base2', 'fetch relay settle', 'done jpyc', 'done base2']],
    ['base1', 'jpyc', ['fetch relay verify', 'fetch facilitator verify', 'adapter jpyc', 'adapter base1',
      'fetch facilitator settle', 'fetch relay settle', 'done jpyc', 'done base1']],
    ['jpyc', 'base1', ['fetch facilitator verify', 'fetch relay verify', 'adapter jpyc', 'fetch facilitator settle',
      'adapter base1', 'fetch relay settle', 'done jpyc', 'done base1']],
    ['arc', 'jpyc', ['fetch relay verify', 'fetch facilitator verify', 'adapter jpyc', 'adapter arc',
      'fetch facilitator settle', 'fetch relay settle', 'done jpyc', 'done arc']],
    ['jpyc', 'arc', ['fetch facilitator verify', 'fetch relay verify', 'adapter jpyc', 'fetch facilitator settle',
      'adapter arc', 'fetch relay settle', 'done jpyc', 'done arc']],
    ['arc', 'base2', ['fetch relay verify', 'fetch relay verify', 'adapter arc', 'adapter base2',
      'fetch relay settle', 'fetch relay settle', 'done arc', 'done base2']],
  ])('%s started before %s keeps the original order', async (first, second, expected) => {
    const { GET } = await import('@/app/api/consult/route');
    // 支払いなしの 1 件で出品と USDC 面をキャッシュに入れ、支払い 2 件は同じ条件から始める。
    expect((await GET(new Request(`${resource}?q=warm`))).status).toBe(402);
    events = [];

    const statuses = await Promise.all([first, second].map(async (name) => {
      const res = await GET(new Request(`${resource}?q=${name}`, { headers: PAID[name] }));
      events.push(`done ${name}`);
      return res.status;
    }));

    expect(statuses).toEqual([200, 200]);
    expect(events).toEqual(expected);
  });
});

// 支払いの settle の途中で始まった支払いなしのリクエストと、どちらが先に終わるか。consult の最後で
// 別の async 関数の Promise を返すと、支払いの完了だけが数ジョブ遅れて入れ替わる。境目の両側 (k と k+1) を
// 置き、完了が 1 ジョブ早まっても遅れても失敗するようにしてある。期待値は a108724 で得た順番。
describe('completion order of a paid request and an unpaid one started during its settle', () => {
  const PAID: Record<string, Record<string, string>> = {
    jpyc: { 'X-PAYMENT': paymentHeader },
    base2: { 'PAYMENT-SIGNATURE': SIG_BASE },
  };
  let hook: 'fetch' | 'json' = 'json';
  let startUnpaid: () => void = () => {};

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    vi.stubEnv('EXPECTED_RECIPIENT', merchant);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith('/settle')) {
        return response(url.includes('/discovery/') ? listing : url.includes('/requirements') ? usdcFace : { isValid: true });
      }
      if (hook === 'fetch') startUnpaid();
      // settle の応答だけは素のオブジェクトにして、json() が呼ばれた時点をテストから掴む。
      return {
        status: 200,
        ok: true,
        json: () => {
          if (hook === 'json') startUnpaid();
          return Promise.resolve({ success: true, transaction: '0xsettled' });
        },
      } as unknown as Response;
    }));
    const { selectedAdapter } = await import('@/lib/adapters');
    vi.mocked(selectedAdapter).mockReset().mockReturnValue(async () => ({ answer: 'answer' }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each<[string, number, 'fetch' | 'json', string[]]>([
    ['jpyc', 0, 'json', ['paid 200', 'unpaid 402']],
    ['jpyc', 0, 'fetch', ['unpaid 402', 'paid 200']],
    ['jpyc', 1, 'fetch', ['paid 200', 'unpaid 402']],
    ['base2', 1, 'fetch', ['unpaid 402', 'paid 200']],
    ['base2', 2, 'fetch', ['paid 200', 'unpaid 402']],
  ])('%s paid, unpaid started %i microtasks after the settle %s()', async (rail, k, at, expected) => {
    const { GET } = await import('@/app/api/consult/route');
    expect((await GET(new Request(`${resource}?q=warm`))).status).toBe(402);
    hook = at;
    const order: string[] = [];
    let unpaid: Promise<void> | undefined;
    startUnpaid = () => {
      let left = k;
      const start = () => {
        if (left-- > 0) return queueMicrotask(start);
        unpaid = GET(new Request(`${resource}?q=unpaid`)).then((res) => { order.push(`unpaid ${res.status}`); });
      };
      queueMicrotask(start);
    };

    await GET(new Request(`${resource}?q=paid`, { headers: PAID[rail] }))
      .then((res) => { order.push(`paid ${res.status}`); });
    expect(unpaid).toBeDefined();
    await unpaid;

    expect(order).toEqual(expected);
  });
});
