// OpenPay の facilitator (JPYC) への verify / settle と、OpenPay 共通の値。
// open-pay.jp 配布のリファレンスゲートを TS 化したもの。verify と settle は分けて公開する
// (買い手保護の処理順 — verify → 上流 → settle — を呼び出し側で組むため)。

import { sellerConfig, validateJpycRequirements } from './sellerPins';
import type { PaymentRequirements, SettleResult, VerifyResult } from './types';

export const OPENPAY_ORIGIN = 'https://open-pay.jp';

// discovery と relay/requirements は OpenPay 側の KV を消費するため、402 を返すだけの
// 支払いなしリクエストは長く使う。
const PAYMENT_LISTING_TTL_MS = 5 * 60_000;
const PROBE_LISTING_TTL_MS = 30 * 60_000;

// forPayment を省略したときは支払い扱い (厳しい側の 5 分) にする。
export function termsMaxAgeMs(forPayment?: boolean): number {
  return forPayment === false ? PROBE_LISTING_TTL_MS : PAYMENT_LISTING_TTL_MS;
}

// async にしない: pin の不一致は呼んだその場で throw し、facilitator には何も送らない。
function callFacilitator(
  path: 'verify' | 'settle',
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<Record<string, unknown>> {
  validateJpycRequirements(paymentRequirements, sellerConfig().expectedRecipient);
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements });
  return fetch(OPENPAY_ORIGIN + '/api/facilitator/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then((r) => r.json());
}

export function verifyPayment(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResult> {
  return callFacilitator('verify', paymentPayload, paymentRequirements);
}

export function settlePayment(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  return callFacilitator('settle', paymentPayload, paymentRequirements);
}

export function encodePaymentResponse(settle: SettleResult): string {
  return Buffer.from(JSON.stringify(settle)).toString('base64');
}
