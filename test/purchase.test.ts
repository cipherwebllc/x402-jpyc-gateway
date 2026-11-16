import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choosePayment, type PaymentChoice } from '@/lib/purchase';
import type { UsdcFace } from '@/lib/types';

import {
  OPENPAY, arcPaymentRequiredHeader, arcV2Accept, catalogAccept, listing, merchant, paymentHeader,
  paymentPayload, paymentRequiredHeader, paymentSignatureFor, resource, resourceId, response, usdcAccept,
  usdcFace, usdcFaceWithArc, usdcMerchant, usdcV1PaymentHeader, v2Accept,
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
      .toEqual({
        kind: 'usdc', face: usdcFace, headers: { paymentHeader: x }, rail: 'base',
        payload: { network: 'base', authorization: 'payment' },
      });
    expect(choosePayment({ paymentHeader: x, paymentSignatureHeader: SIG_BASE }, [catalogAccept], usdcFace))
      .toEqual({
        kind: 'usdc', face: usdcFace, headers: { paymentSignatureHeader: SIG_BASE }, rail: 'base',
        payload: JSON.parse(Buffer.from(SIG_BASE, 'base64').toString('utf8')),
      });
  });
});

// 同じモジュールで同時に動く 2 件の支払い。どちらも「自分の」支払いの verify → 上流 → settle を 1 回ずつ通って
// 200 になる。fetch の記録は、POST の本文の支払い (facilitator は paymentPayload、relay は paymentHeader か
// paymentSignatureHeader) から誰の支払いかを決めて `verify <名前>` / `settle <名前>` と書く。settle はテストが
// 1 件ずつ放すまで止めておき、2 件とも止まっている間はどちらも終わらないこと、先の 1 件だけを放すとその 1 件
// だけが終わることを確かめる (相手の settle で終わっていない)。2 件のあいだの verify と上流の順番は約束しない。
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
    base1: { 'X-PAYMENT': usdcV1PaymentHeader() },
    base2: { 'PAYMENT-SIGNATURE': SIG_BASE },
    arc: { 'PAYMENT-SIGNATURE': SIG_ARC },
  };
  let events: string[] = [];
  // settle ごとの放す関数 (支払いの名前で引く)。
  let heldSettles: Map<string, () => void>;

  /** The name in PAID of the payment carried by an OpenPay POST body. */
  function payerOf(body: string): string {
    const sent = JSON.parse(body) as { paymentPayload?: unknown; paymentHeader?: string; paymentSignatureHeader?: string };
    const header = sent.paymentPayload !== undefined
      ? b64(sent.paymentPayload)
      : sent.paymentHeader ?? sent.paymentSignatureHeader;
    const names = Object.keys(PAID).filter((name) => Object.values(PAID[name])[0] === header);
    if (names.length !== 1) throw new Error('POST body does not carry exactly one known payment');
    return names[0];
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('MY_RESOURCE_ID', resourceId);
    vi.stubEnv('EXPECTED_RECIPIENT', merchant);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
    heldSettles = new Map();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = ROUTES[String(input)];
      if (!route) throw new Error(`unexpected fetch ${String(input)}`);
      if (init?.method !== 'POST') {
        events.push(`read ${route}`);
        return response(BODIES[route]);
      }
      const name = payerOf(String(init.body));
      const step = route.endsWith('settle') ? 'settle' : 'verify';
      events.push(`${step} ${name}`);
      if (step === 'settle') {
        if (heldSettles.has(name)) throw new Error(`second settle for ${name}`);
        await new Promise<void>((release) => heldSettles.set(name, release));
      }
      return response(BODIES[route]);
    }));
    const { selectedAdapter } = await import('@/lib/adapters');
    vi.mocked(selectedAdapter).mockReset().mockReturnValue(async ({ q }) => {
      events.push(`adapter ${q}`);
      return { answer: q };
    });
  });

  afterEach(() => {
    for (const release of heldSettles.values()) release();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each<[string, string]>([
    ['base2', 'jpyc'], ['jpyc', 'base2'], ['base1', 'jpyc'], ['jpyc', 'base1'],
    ['arc', 'jpyc'], ['jpyc', 'arc'], ['arc', 'base2'],
  ])('%s and %s together each run their own verify, upstream call and settle', async (first, second) => {
    const { GET } = await import('@/app/api/consult/route');
    // 支払いなしの 1 件で出品と USDC 面をキャッシュに入れ、支払い 2 件は同じ条件から始める。
    expect((await GET(new Request(`${resource}?q=warm`))).status).toBe(402);
    events = [];

    const statuses: Record<string, number> = {};
    const requests = [first, second].map(async (name) => {
      const res = await GET(new Request(`${resource}?q=${name}`, { headers: PAID[name] }));
      events.push(`done ${name}`);
      statuses[name] = res.status;
    });
    const release = (name: string) => heldSettles.get(name)!();

    // 2 件とも自分の settle で止まっている間は、どちらも終わらない。
    await vi.waitFor(() => expect([...heldSettles.keys()].sort()).toEqual([first, second].sort()));
    expect(statuses).toEqual({});

    // 先の 1 件の settle だけを放すと、その 1 件だけが終わる。
    release(first);
    await vi.waitFor(() => expect(statuses).toEqual({ [first]: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual({ [first]: 200 });

    release(second);
    await vi.waitFor(() => expect(statuses).toEqual({ [first]: 200, [second]: 200 }));
    await Promise.all(requests);

    // 記録はすべてどちらかの 1 件のもので、各自が自分の支払いの verify → 上流 → settle → 応答を 1 回ずつ通る。
    const own = (name: string) => events.filter((event) => event.split(' ')[1] === name);
    expect(own(first).length + own(second).length).toBe(events.length);
    for (const name of [first, second]) {
      expect(own(name)).toEqual([`verify ${name}`, `adapter ${name}`, `settle ${name}`, `done ${name}`]);
    }
  });
});
