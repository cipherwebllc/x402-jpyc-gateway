// OpenPay への呼び出し (時間切れつき) と、verify / settle の応答の読み分け。JPYC の facilitator もここ。
// open-pay.jp 配布のリファレンスゲートを TS 化したもの。verify と settle は分けて公開する
// (買い手保護の処理順 — verify → 上流 → settle — を呼び出し側で組むため)。

import { sellerConfig, validateJpycRequirements } from './sellerPins';
import type { PaymentRequirements } from './types';

export const OPENPAY_ORIGIN = 'https://open-pay.jp';

// discovery と relay/requirements は OpenPay 側の KV を消費するため、402 を返すだけの
// 支払いなしリクエストは長く使う。
const PAYMENT_LISTING_TTL_MS = 5 * 60_000;
const PROBE_LISTING_TTL_MS = 30 * 60_000;

// OpenPay が返事をしないときに待つ上限。verify と settle は、OpenPay 側の処理の上限 (facilitator の verify は
// 15 秒、relay の verify と両方の settle は 30 秒) より長く取る。先にこちらが切ると、OpenPay が出すはずだった
// 判定を捨てることになり、settle では決済されたかどうかが分からなくなる。
export const READ_TIMEOUT_MS = 5_000;
export const VERIFY_TIMEOUT_MS = 35_000;
export const SETTLE_TIMEOUT_MS = 60_000;

// forPayment を省略したときは支払い扱い (厳しい側の 5 分) にする。
export function termsMaxAgeMs(forPayment?: boolean): number {
  return forPayment === false ? PROBE_LISTING_TTL_MS : PAYMENT_LISTING_TTL_MS;
}

/**
 * OpenPay の 1 回の応答。status が null なら応答なし (通信の失敗か時間切れ)。
 * body は JSON のオブジェクトだけで、それ以外 (JSON でない・null・配列・文字列) は null。
 */
export type OpenPayReply = { status: number | null; body: Record<string, unknown> | null };

// 例外を投げない。応答がなくても、本文が読めなくても、OpenPayReply で返す。
// リダイレクトはたどらない (redirect: 'manual')。たどると、Location の先の答えを OpenPay の判定として信じて
// しまう (307 / 308 では支払いの本文もその先へ送り直す)。3xx はそのまま「その他の状態」として読み分ける
// (verify は判定なし、settle は結果が分からない)。出品と USDC の決済条件の GET は、中身を出品者の pin と照合するのでここを通らない。
export async function postToOpenPay(path: string, body: string, timeoutMs: number): Promise<OpenPayReply> {
  let res: Response;
  try {
    res = await fetch(OPENPAY_ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: null, body: null };
  }
  try {
    const parsed: unknown = await res.json();
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return { status: res.status, body: isObject ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { status: res.status, body: null };
  }
}

// OpenPay の理由コードは snake_case の短い文字列。それ以外の値 (文章・記号・長い文字列) は買い手に返さない。
function reasonCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

export type VerifyOutcome =
  | { kind: 'valid' }
  /** 支払いが通らなかった。何も動かしていないので、402 で払い直してもらえる。 */
  | { kind: 'rejected'; reason: string | undefined }
  /** OpenPay が判定を返せなかった (応答なし・429・5xx・読めない本文)。 */
  | { kind: 'unavailable' };

export function verifyOutcome({ status, body }: OpenPayReply): VerifyOutcome {
  if (status === 200) {
    if (body === null) return { kind: 'unavailable' };
    return body.isValid === true ? { kind: 'valid' } : { kind: 'rejected', reason: reasonCode(body.invalidReason) };
  }
  // 429 以外の 4xx は OpenPay が断った応答。facilitator は invalidReason、relay は error に理由を入れる。
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return { kind: 'rejected', reason: reasonCode(body?.invalidReason) ?? reasonCode(body?.error) };
  }
  return { kind: 'unavailable' };
}

export type SettleOutcome =
  | { kind: 'settled'; receipt: Record<string, unknown> }
  /** 202: 同じ支払いの決済が進行中。決済される見込みなので、払い直しを求めてはいけない。 */
  | { kind: 'pending'; receipt: Record<string, unknown> | null }
  /** OpenPay が決済を断った。請求されていない。 */
  | { kind: 'rejected'; reason: string | undefined }
  /** 決済されたかどうかが分からない (応答なし・5xx・読めない本文)。 */
  | { kind: 'unknown' };

export function settleOutcome({ status, body }: OpenPayReply): SettleOutcome {
  if (status === 200) {
    if (body?.success === true) return { kind: 'settled', receipt: body };
    // 「請求していない」と言えるのは、success が false とはっきり返ったときだけ。
    if (body?.success === false) return { kind: 'rejected', reason: reasonCode(body.errorReason) };
    return { kind: 'unknown' };
  }
  if (status === 202) return { kind: 'pending', receipt: body };
  if (status !== null && status >= 400 && status < 500) {
    return { kind: 'rejected', reason: reasonCode(body?.errorReason) ?? reasonCode(body?.error) };
  }
  return { kind: 'unknown' };
}

// facilitator は verify / settle の本文が UTF-8 で 4096 byte を超えると 413 で断る。
export const FACILITATOR_BODY_LIMIT_BYTES = 4096;
// verify が返す予約の token は `x402r1_` と 64 桁の 16 進。settle に渡すのは、この長さまでの安全な文字だけ。
export const RESERVATION_TOKEN_MAX_LENGTH = 71;
const RESERVATION_TOKEN = new RegExp(`^[A-Za-z0-9_-]{1,${RESERVATION_TOKEN_MAX_LENGTH}}$`);

// verify・settle・大きさの確認は、必ずこの 1 つの組み立てを使う (食い違うと「verify は通り、settle は 413」が起きる)。
function facilitatorBody(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
  reservationToken?: string,
): string {
  return JSON.stringify({
    x402Version: 1,
    paymentPayload,
    paymentRequirements,
    ...(reservationToken === undefined ? {} : { reservationToken }),
  });
}

/**
 * settle の本文が facilitator の上限に収まるか。token は verify のあとでしか分からないので、
 * いちばん長い token が付いたとして測る。本文の大きさはほぼ q (resource の URL に入る) で決まる。
 */
export function facilitatorSettleBodyFits(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): boolean {
  const longest = facilitatorBody(paymentPayload, paymentRequirements, 'x'.repeat(RESERVATION_TOKEN_MAX_LENGTH));
  return Buffer.byteLength(longest, 'utf8') <= FACILITATOR_BODY_LIMIT_BYTES;
}

export type ReservationToken =
  | { kind: 'token'; token: string }
  | { kind: 'absent' }
  /** 形が合わない値。settle には渡さない (切り詰めたり直したりもしない)。 */
  | { kind: 'malformed' };

/** facilitator の verify が通ったときの本文から、settle に渡す予約の token を読む。 */
export function reservationTokenOf(reply: OpenPayReply): ReservationToken {
  const token = reply.body?.reservationToken;
  if (token === undefined) return { kind: 'absent' };
  return typeof token === 'string' && RESERVATION_TOKEN.test(token) ? { kind: 'token', token } : { kind: 'malformed' };
}

// async にしない: pin の不一致は呼んだその場で throw し、facilitator には何も送らない。
function callFacilitator(
  path: 'verify' | 'settle',
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
  reservationToken?: string,
): Promise<OpenPayReply> {
  validateJpycRequirements(paymentRequirements, sellerConfig().expectedRecipient);
  return postToOpenPay(
    '/api/facilitator/' + path,
    facilitatorBody(paymentPayload, paymentRequirements, reservationToken),
    path === 'verify' ? VERIFY_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
  );
}

export function verifyPayment(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<OpenPayReply> {
  return callFacilitator('verify', paymentPayload, paymentRequirements);
}

/** reservationToken は verify が返した予約の token (なければ付けない)。 */
export function settlePayment(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
  reservationToken?: string,
): Promise<OpenPayReply> {
  return callFacilitator('settle', paymentPayload, paymentRequirements, reservationToken);
}

export function encodePaymentResponse(settle: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(settle)).toString('base64');
}
