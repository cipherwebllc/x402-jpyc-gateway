// 支払いのある /api/consult の 2 段。どの rail で払うかを決め (choosePayment)、
// verify → 上流 → settle を 1 本の手順で動かす (runPurchase)。上流が失敗したら settle しない。

import { selectedAdapter } from './adapters';
import { json402, jsonResponse } from './http';
import { encodePaymentResponse, settlePayment, verifyPayment } from './openpay';
import { decodePaymentHeader } from './paymentHeader';
import { relayPayment } from './relay';
import { ARC_NETWORKS } from './sellerPins';
import type { PaymentRequirements, SettleResult, UsdcFace, UsdcRail, VerifyResult } from './types';
import { isArcPayment, paymentRequiredHeaderFor } from './usdcFace';

// USDC 面がないとき、Base の支払いを名乗る X-PAYMENT は JPYC の facilitator に回さない。
const BASE_NETWORKS = ['base', 'base-sepolia', 'eip155:8453', 'eip155:84532'];

export type PaymentHeaders = { paymentHeader: string | null; paymentSignatureHeader: string | null };

type JpycPurchase = { kind: 'jpyc'; payload: unknown };
type UsdcPurchase = {
  kind: 'usdc';
  face: UsdcFace;
  headers: { paymentSignatureHeader: string } | { paymentHeader: string };
  rail: UsdcRail;
};
export type Purchase = JpycPurchase | UsdcPurchase;
export type PaymentChoice = { kind: 'reply'; response: Response } | Purchase;

/**
 * 支払える全 rail の決済条件を載せた 402。USDC 面があれば PAYMENT-REQUIRED も付ける
 * (USDC 面がなければ JPYC の条件だけで、ヘッダーも付かない)。
 */
export function paymentRequired(
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
  error: string,
): Response {
  return json402(usdc ? [...accepts, usdc.v1Accepts] : accepts, error, paymentRequiredHeaderFor(usdc));
}

// 支払いのヘッダーがあるときだけ呼ぶ (支払いなしの 402 と q の確認は route が先に済ませる)。
// 空の PAYMENT-SIGNATURE も支払いで、X-PAYMENT より優先する。network は完全一致でだけ比べる。
export function choosePayment(
  { paymentHeader, paymentSignatureHeader }: PaymentHeaders,
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
): PaymentChoice {
  const reply = (error: string): PaymentChoice =>
    ({ kind: 'reply', response: paymentRequired(accepts, usdc, error) });

  if (paymentSignatureHeader !== null) {
    if (!usdc) return reply('payment_invalid');
    const rail = isArcPayment(usdc, paymentSignatureHeader) ? 'arc' : 'base';
    return { kind: 'usdc', face: usdc, headers: { paymentSignatureHeader }, rail };
  }

  const xPayment = paymentHeader ?? '';
  const payload = decodePaymentHeader(xPayment);
  if (payload === undefined) return reply('invalid_payment_payload');
  const isObject = typeof payload === 'object' && payload !== null;
  const network = isObject ? (payload as { network?: unknown }).network : undefined;
  if (!usdc && typeof network === 'string' && BASE_NETWORKS.includes(network)) {
    return reply('payment_invalid');
  }
  // Arc is v2 only: a v1 X-PAYMENT naming an Arc network can never be settled.
  if (typeof network === 'string' && ARC_NETWORKS.includes(network)) {
    return reply('payment_invalid');
  }
  if (usdc !== null && isObject && network === usdc.v1Accepts.network) {
    return { kind: 'usdc', face: usdc, headers: { paymentHeader: xPayment }, rail: 'base' };
  }
  return { kind: 'jpyc', payload };
}

// 1 つの rail の verify / settle。Response が返ったらそのまま返す (USDC の 409 → 402 requirements_mismatch)。
// verify / settle は呼び先の Promise をそのまま返し、await を足さない。足すと、同時に動く別の支払いとの
// 上流の呼び出しや settle の順番が以前と変わる。本文の読み替えは await の直後に同期の read で行う。
type PurchaseRail = {
  verify(): Promise<VerifyResult | Response>;
  settle(): Promise<SettleResult | Response>;
  read<T>(body: T): T;
  // isValid が true でなく理由もないときの error。いまは rail ごとに文字列が違う (C1 で揃える)。
  invalidFallback: 'invalid_payment' | 'payment_invalid';
  successHeaders(paymentResponse: string): Record<string, string>;
};

function jpycRail(payload: unknown, accept: PaymentRequirements): PurchaseRail {
  return {
    verify: () => verifyPayment(payload, accept),
    settle: () => settlePayment(payload, accept),
    // facilitator の JSON は加工しない。null だと runPurchase の isValid / success の読み取りが
    // try の外で TypeError になり、GET から漏れる (Next の 500)。いまの挙動のまま残す (C1 で直す)。
    read: (body) => body,
    invalidFallback: 'invalid_payment',
    successHeaders: (paymentResponse) => ({ 'X-PAYMENT-RESPONSE': paymentResponse }),
  };
}

function usdcRail({ face, headers, rail }: UsdcPurchase, jpycAccepts: PaymentRequirements[]): PurchaseRail {
  return {
    verify: () => relayPayment('verify', headers, face, jpycAccepts, rail),
    settle: () => relayPayment('settle', headers, face, jpycAccepts, rail),
    // relay の JSON null は {} にする。以前の `?.` と同じく 402 (payment_invalid / settlement_failed) になる。
    read: (body) => body ?? ({} as typeof body),
    invalidFallback: 'payment_invalid',
    successHeaders: (paymentResponse) => ({
      'X-PAYMENT-RESPONSE': paymentResponse,
      // Arc buyers pay with x402 v2 clients, which read PAYMENT-RESPONSE.
      ...(rail === 'arc' ? { 'PAYMENT-RESPONSE': paymentResponse } : {}),
    }),
  };
}

// verify → 上流 → settle。失敗の 402 は rail によらず、支払える全 rail の決済条件で返す。
export async function runPurchase(
  purchase: Purchase,
  q: string,
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
): Promise<Response> {
  const rail = purchase.kind === 'jpyc' ? jpycRail(purchase.payload, accepts[0]) : usdcRail(purchase, accepts);

  let verification: VerifyResult | Response;
  try {
    verification = rail.read(await rail.verify());
  } catch {
    return jsonResponse(500, { error: 'payment_verification_failed' });
  }
  if (verification instanceof Response) return verification;
  if (verification.isValid !== true) {
    return paymentRequired(accepts, usdc, verification.invalidReason ?? rail.invalidFallback);
  }

  let serializedBody: string;
  try {
    const result = await selectedAdapter()({ q });
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error('adapter result is not JSON serializable');
    serializedBody = serialized;
  } catch {
    return jsonResponse(502, { error: 'upstream_error' });
  }

  let settlement: SettleResult | Response;
  try {
    settlement = rail.read(await rail.settle());
  } catch {
    return jsonResponse(500, { error: 'payment_settlement_failed' });
  }
  if (settlement instanceof Response) return settlement;
  if (settlement.success !== true) {
    return paymentRequired(accepts, usdc, settlement.errorReason ?? 'settlement_failed');
  }

  return new Response(serializedBody, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...rail.successHeaders(encodePaymentResponse(settlement)),
    },
  });
}
