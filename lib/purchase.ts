// GET / HEAD /api/consult の本体。決済条件を読み、どの rail で払うかを決め (choosePayment)、
// verify → 上流 → settle を 1 本の手順で動かす。上流が失敗したら settle しない。
// OpenPay の応答は openpay.ts の verifyOutcome / settleOutcome で読み分ける。

import { selectedAdapter } from './adapters';
import { json402, jsonResponse } from './http';
import { acceptsFor } from './listing';
import {
  encodePaymentResponse,
  settleOutcome,
  settlePayment,
  verifyOutcome,
  verifyPayment,
  type OpenPayReply,
} from './openpay';
import { decodePaymentHeader } from './paymentHeader';
import { relayPayment } from './relay';
import { ARC_NETWORKS, isLoggedSellerRejection } from './sellerPins';
import type { PaymentRequirements, UsdcFace, UsdcRail } from './types';
import { isArcPayment, paymentRequiredHeaderFor, usdcFace } from './usdcFace';

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
type Purchase = JpycPurchase | UsdcPurchase;
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

// 支払いのヘッダーがあるときだけ呼ぶ (支払いなしの 402 と q の確認は consult が先に済ませる)。
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

// 1 つの rail の verify / settle。OpenPay の応答をそのまま返す (読み分けは consult がする)。
// Response が返ったらそのまま返す (USDC の 409 → 402 requirements_mismatch)。
// throw するのは、pin や設定が合わず OpenPay に何も送らなかったときと、USDC の relay が 409 で断ったあとに
// 決済条件を取り直せなかった (取れない・pin が合わない) とき。どちらも請求はない。
type PurchaseRail = {
  name: 'jpyc' | UsdcRail;
  verify(): Promise<OpenPayReply | Response>;
  settle(): Promise<OpenPayReply | Response>;
  // 支払いが通らず、OpenPay が理由を返さなかったときの error。OpenPay の 2 つのリファレンスゲートに
  // 合わせて、rail ごとに文字列が違う。
  invalidFallback: 'invalid_payment' | 'payment_invalid';
  // 決済の結果 (settle の本文) を買い手に渡すヘッダー。
  receiptHeaders(receipt: Record<string, unknown>): Record<string, string>;
};

function jpycRail(payload: unknown, accept: PaymentRequirements): PurchaseRail {
  return {
    name: 'jpyc',
    verify: () => verifyPayment(payload, accept),
    settle: () => settlePayment(payload, accept),
    invalidFallback: 'invalid_payment',
    receiptHeaders: (receipt) => ({ 'X-PAYMENT-RESPONSE': encodePaymentResponse(receipt) }),
  };
}

function usdcRail({ face, headers, rail }: UsdcPurchase, jpycAccepts: PaymentRequirements[]): PurchaseRail {
  // PAYMENT-SIGNATURE で払うのは x402 v2 のクライアントで、結果は PAYMENT-RESPONSE から読む。
  const isV2 = 'paymentSignatureHeader' in headers;
  return {
    name: rail,
    verify: () => relayPayment('verify', headers, face, jpycAccepts, rail),
    settle: () => relayPayment('settle', headers, face, jpycAccepts, rail),
    invalidFallback: 'payment_invalid',
    receiptHeaders: (receipt) => {
      const paymentResponse = encodePaymentResponse(receipt);
      return {
        'X-PAYMENT-RESPONSE': paymentResponse,
        ...(isV2 ? { 'PAYMENT-RESPONSE': paymentResponse } : {}),
      };
    },
  };
}

// 握りつぶさずに残す失敗の記録。書くのは、ここで決めた固定の言葉と rail の名前、HTTP の状態だけ。
// q・回答・支払いのヘッダー・ウォレット・URL・相手の本文・例外のメッセージは書かない。
function logFailure(what: string, rail: PurchaseRail, reply?: OpenPayReply): void {
  const status = reply === undefined ? '' : reply.status === null ? ', no response' : `, HTTP ${reply.status}`;
  console.error(`[openpay-x402] ${what} (${rail.name}${status})`);
}

// catch した例外の記録。出品や pin の不一致は sellerPins が理由を記録済みなので、それ以外のときだけ書く。
function logUnexpected(error: unknown, what: string): void {
  if (!isLoggedSellerRejection(error)) console.error(`[openpay-x402] ${what} (unexpected error)`);
}

function hasPaymentHeaders(paymentHeader: string | null, paymentSignatureHeader: string | null): boolean {
  return Boolean(paymentHeader) || paymentSignatureHeader !== null;
}

// 失敗の 402 は rail によらず、支払える全 rail の決済条件で返す。
export async function consult(request: Request): Promise<Response> {
  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  // 402 ゲートと掲載値の鮮度 (5 分 / 30 分) は必ずこの 1 変数から決める。
  const hasPayment = hasPaymentHeaders(paymentHeader, paymentSignatureHeader);

  let accepts: PaymentRequirements[];
  let usdc: UsdcFace | null;
  try {
    accepts = await acceptsFor(request.url, { forPayment: hasPayment });
    usdc = await usdcFace({ forPayment: hasPayment });
  } catch (error) {
    logUnexpected(error, 'payment terms unavailable');
    return jsonResponse(500, { error: 'accepts_unavailable' });
  }

  if (!hasPayment) {
    return paymentRequired(accepts, usdc, 'payment_required');
  }

  const q = new URL(request.url).searchParams.get('q');
  if (!q) {
    return jsonResponse(400, { error: 'q_required' });
  }

  const choice = choosePayment({ paymentHeader, paymentSignatureHeader }, accepts, usdc);
  if (choice.kind === 'reply') return choice.response;
  const rail = choice.kind === 'jpyc' ? jpycRail(choice.payload, accepts[0]) : usdcRail(choice, accepts);

  let verifyReply: OpenPayReply | Response;
  try {
    verifyReply = await rail.verify();
  } catch (error) {
    // pin や設定が合わず OpenPay に何も送っていないか、relay が 409 で断ったあとに決済条件を取り直せなかった。
    // どちらも請求していない。
    logUnexpected(error, 'verify not sent or refused by OpenPay');
    return jsonResponse(500, { error: 'payment_verification_failed' });
  }
  if (verifyReply instanceof Response) return verifyReply;
  const verification = verifyOutcome(verifyReply);
  if (verification.kind === 'unavailable') {
    // 何も動かしていないし、請求もしていない。払い直しではなく、時間をおいた再試行を促す。
    logFailure('verify unavailable', rail, verifyReply);
    return jsonResponse(503, { error: 'payment_service_unavailable' });
  }
  if (verification.kind === 'rejected') {
    return paymentRequired(accepts, usdc, verification.reason ?? rail.invalidFallback);
  }

  let serializedBody: string;
  try {
    const result = await selectedAdapter()({ q });
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error('adapter result is not JSON serializable');
    serializedBody = serialized;
  } catch {
    logFailure('upstream failed, not charged', rail);
    return jsonResponse(502, { error: 'upstream_error' });
  }

  let settleReply: OpenPayReply | Response;
  try {
    settleReply = await rail.settle();
  } catch (error) {
    // pin や設定が合わず OpenPay に何も送っていないか、relay が 409 で断ったあとに決済条件を取り直せなかった。
    // どちらも請求していない。
    logUnexpected(error, 'settle not sent or refused by OpenPay');
    return jsonResponse(500, { error: 'payment_settlement_failed' });
  }
  if (settleReply instanceof Response) return settleReply;
  const settlement = settleOutcome(settleReply);
  switch (settlement.kind) {
    case 'settled':
      return new Response(serializedBody, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...rail.receiptHeaders(settlement.receipt),
        },
      });
    case 'rejected':
      return paymentRequired(accepts, usdc, settlement.reason ?? 'settlement_failed');
    case 'pending':
      // 決済される見込みなので 402 にしない (402 は「もう一度払って」の意味になり、二重払いを招く)。
      logFailure('settle pending, content not delivered', rail, settleReply);
      return jsonResponse(
        502,
        { error: 'settlement_pending' },
        settlement.receipt ? rail.receiptHeaders(settlement.receipt) : {},
      );
    case 'unknown':
      // 決済されたかどうかが分からない。「失敗」とは言わず、払い直しも求めない。
      logFailure('settle outcome unknown, content not delivered', rail, settleReply);
      return jsonResponse(500, { error: 'settlement_unknown' });
  }
}

// HEAD は本文を返せないので、何も売らない。支払いのヘッダーがなければ GET と同じ 402 (ヘッダーだけ) を返し、
// 支払いのヘッダーがあれば OpenPay を呼ばずに 405 で断る (verify・上流・settle を動かさない)。
export async function consultHead(request: Request): Promise<Response> {
  if (hasPaymentHeaders(request.headers.get('X-PAYMENT'), request.headers.get('PAYMENT-SIGNATURE'))) {
    return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
  }
  const response = await consult(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
