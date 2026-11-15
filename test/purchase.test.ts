import { describe, expect, it } from 'vitest';

import { choosePayment, type PaymentChoice } from '@/lib/purchase';
import type { UsdcFace } from '@/lib/types';

import {
  arcPaymentRequiredHeader, arcV2Accept, catalogAccept, paymentHeader, paymentPayload,
  paymentRequiredHeader, paymentSignatureFor, usdcAccept, usdcFace, usdcFaceWithArc, v2Accept,
} from './fixtures';

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
