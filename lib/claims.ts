// 同じ支払い (authorization) で上流を 2 回動かさないための、このプロセスの中だけの予約。
// openpay-x402-sdk 0.11.1 の authorizationClaims.mjs を TS にしたもの (鍵の作り方は同じ)。
//
// 予約は verify の前に取る。保っている予約は「この支払いをこのプロセスで処理している途中か、ここで settle まで
// 進めた」ことを表す。だから、settle を送る前に終わったとき (verify が通らない・上流が失敗した) は外し、
// settle を送ったら結果にかかわらず残す (同じ支払いをもう一度送っても、上流は動かない)。
// プロセスをまたいでは効かない (Vercel の別のインスタンスには届かない)。

import { ARC_MAX_TIMEOUT_SECONDS } from './sellerPins';

/** 予約の鍵と、その支払いの期限 (秒)。 */
export type AuthorizationClaim = { key: string; validBefore: bigint };
/** 取れた予約。外すときは、取った本人 (owner) のものだけを外す。 */
export type HeldClaim = { key: string; owner: symbol };
export type ClaimRefusal = 'insufficient_validity_window' | 'authorization_reserved';
export type ClaimResult = { ok: true; claim: HeldClaim } | { ok: false; reason: ClaimRefusal };

// 上流の呼び出しの上限 (purchase.ts が待つ時間) と、そのあと settle を終えるための猶予。支払いの期限まで
// これより短ければ、上流を動かしても決済が間に合わないかもしれないので、受け付けない。
export const MAX_UPSTREAM_SECONDS = 125;
export const SETTLEMENT_GRACE_SECONDS = 30;
const REQUIRED_VALIDITY_SECONDS = BigInt(MAX_UPSTREAM_SECONDS + SETTLEMENT_GRACE_SECONDS);
// 予約を覚えておく上限。期限 (validBefore) がずっと先の支払いでも、これを過ぎたら忘れる
// (メモリを使い続けないため)。Arc の支払いの期限の上限と同じ 8 日。
const MAX_RETENTION_SECONDS = BigInt(ARC_MAX_TIMEOUT_SECONDS);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalAddress(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function canonicalBytes32(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

function canonicalDecimal(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value).toString() : null;
}

function canonicalNetwork(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^eip155:([0-9]+)$/.exec(value);
  return match ? `eip155:${BigInt(match[1]).toString()}` : null;
}

function claimOf(parts: Array<string | null>, validBefore: string | null): AuthorizationClaim | null {
  if (validBefore === null || parts.some((part) => part === null)) return null;
  return { key: JSON.stringify(parts), validBefore: BigInt(validBefore) };
}

/** 出品の JPYC の決済条件のうち、支払いの鍵に入る項目。 */
export type JpycTerms = {
  asset: string;
  forwarder: string;
  merchant: string;
  merchantValue: string;
  feeReceiver: string;
  feeValue: string;
};

/** 出品の決済条件から鍵に入る項目を読む。どれかが読めなければ null (出品の側の問題)。 */
export function jpycTerms(paymentRequirements: unknown): JpycTerms | null {
  const requirements = record(paymentRequirements);
  const openpay = record(record(requirements?.extra)?.openpay);
  const terms = {
    asset: canonicalAddress(requirements?.asset),
    forwarder: canonicalAddress(openpay?.forwarder),
    merchant: canonicalAddress(openpay?.merchant),
    merchantValue: canonicalDecimal(openpay?.merchantValue),
    feeReceiver: canonicalAddress(openpay?.feeReceiver),
    feeValue: canonicalDecimal(openpay?.feeValue),
  };
  return Object.values(terms).every((value) => value !== null) ? terms as JpycTerms : null;
}

/**
 * JPYC の支払いの鍵。facilitator が支払いを見分けるのに使う項目 (買い手の authorization と、
 * 出品の分割の条件) から作る。支払いのどれかが読めなければ null (買い手の側の問題)。
 */
export function jpycAuthorizationClaim(paymentPayload: unknown, terms: JpycTerms): AuthorizationClaim | null {
  const payment = record(paymentPayload);
  const authorization = record(record(payment?.payload)?.authorization);
  if (!payment || !authorization) return null;
  const validBefore = canonicalDecimal(authorization.validBefore);
  return claimOf([
    canonicalNetwork(payment.network),
    terms.asset,
    canonicalAddress(authorization.from),
    terms.forwarder,
    terms.merchant,
    terms.merchantValue,
    terms.feeReceiver,
    terms.feeValue,
    canonicalDecimal(authorization.validAfter),
    validBefore,
    canonicalBytes32(authorization.intentSalt),
  ], validBefore);
}

/** USDC の出品者が確かめた決済条件のうち、鍵に入る項目 (network と asset)。読めなければ null。 */
export function usdcTerms(pinnedRequirements: unknown): { network: string; asset: string } | null {
  const pinned = record(pinnedRequirements);
  const network = canonicalNetwork(pinned?.network);
  const asset = canonicalAddress(pinned?.asset);
  return network !== null && asset !== null ? { network, asset } : null;
}

/**
 * USDC (Base / Arc) の支払いの鍵。network と asset は、買い手の申告ではなく出品者が確かめた
 * 決済条件から取る (同じ nonce を v1 と v2 で送っても 1 つの支払いになる)。
 */
export function usdcAuthorizationClaim(
  paymentPayload: unknown,
  terms: { network: string; asset: string },
): AuthorizationClaim | null {
  const authorization = record(record(record(paymentPayload)?.payload)?.authorization);
  if (!authorization) return null;
  return claimOf([
    terms.network,
    terms.asset,
    canonicalAddress(authorization.from),
    canonicalBytes32(authorization.nonce),
  ], canonicalDecimal(authorization.validBefore));
}

const claims = new Map<string, { owner: symbol; expiresAt: bigint }>();

function nowSeconds(): bigint {
  return BigInt(Math.ceil(Date.now() / 1000));
}

/** 支払いの期限まで、上流と settle の時間が残っているか。 */
export function hasValidityWindow(claim: AuthorizationClaim): boolean {
  return claim.validBefore - nowSeconds() >= REQUIRED_VALIDITY_SECONDS;
}

export function claimAuthorization(claim: AuthorizationClaim): ClaimResult {
  const now = nowSeconds();
  for (const [key, held] of claims) {
    if (held.expiresAt <= now) claims.delete(key);
  }
  if (claim.validBefore - now < REQUIRED_VALIDITY_SECONDS) {
    return { ok: false, reason: 'insufficient_validity_window' };
  }
  if (claims.has(claim.key)) return { ok: false, reason: 'authorization_reserved' };
  const owner = Symbol('claim');
  const retentionLimit = now + MAX_RETENTION_SECONDS;
  claims.set(claim.key, {
    owner,
    expiresAt: claim.validBefore < retentionLimit ? claim.validBefore : retentionLimit,
  });
  return { ok: true, claim: { key: claim.key, owner } };
}

// 取った本人の予約だけを外す (期限切れで消えたあと別の要求が取り直した予約を、古い要求が外さない)。
export function releaseAuthorization(claim: HeldClaim): void {
  if (claims.get(claim.key)?.owner === claim.owner) claims.delete(claim.key);
}

/** テスト用: 予約をすべて消す。 */
export function resetClaims(): void {
  claims.clear();
}
