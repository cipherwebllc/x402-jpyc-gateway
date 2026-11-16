// USDC (Base / Arc) の決済条件 (OpenPay relay の requirements) のキャッシュと、買い手に見せる形。

import { OPENPAY_ORIGIN, termsMaxAgeMs } from './openpay';
import { decodePaymentSignature } from './paymentHeader';
import { arcFaceProblem, sameJson, sellerConfig, validateUsdcFace } from './sellerPins';
import type { SellerConfig, UsdcFace } from './types';

let usdcFaceCache: UsdcFace | null = null;
let usdcFaceCachedAt = 0;
// 並行する requirements 取得も「後から開始した取得」の結果だけを反映する (完了順は問わない)。
let usdcFetchSeq = 0;
let usdcAppliedSeq = 0;
// Arc problems already logged, so a dropped Arc face does not log on every request.
const loggedArcProblems = new Set<string>();

export function resetUsdcFaceCache(): void {
  usdcFaceCache = null;
  usdcFaceCachedAt = 0;
  usdcAppliedSeq = usdcFetchSeq;
}

export function resetArcProblemLog(): void {
  loggedArcProblems.clear();
}

// Returns the face to serve: Arc money mismatches throw (both rails stop, like the Base face);
// Arc signing-domain mismatches drop only the Arc face, logged once per reason.
function servedUsdcFace(face: UsdcFace, config: SellerConfig): UsdcFace {
  if (face.arc === undefined) return face;
  const problem = arcFaceProblem(face, config);
  if (problem === null) return face;
  if (!loggedArcProblems.has(problem)) {
    loggedArcProblems.add(problem);
    // Only caller-defined reasons: never log remote bodies, wallets, URLs, or payment data.
    console.error(`[openpay-x402] ${problem}; Arc face disabled`);
  }
  const served = { ...face };
  delete served.arc;
  return served;
}

/** The PAYMENT-REQUIRED header to send: Base + Arc when the Arc face is served, else Base only. */
export function paymentRequiredHeaderFor(face: UsdcFace | null): string | undefined {
  return face?.arc?.paymentRequiredHeader ?? face?.paymentRequiredHeader;
}

/** True only when the buyer's v2 payment accepted exactly the served Arc terms. */
export function isArcPayment(face: UsdcFace, paymentSignatureHeader: string): boolean {
  if (!face.arc) return false;
  const payload = decodePaymentSignature(paymentSignatureHeader);
  const accepted = typeof payload === 'object' && payload !== null
    ? (payload as { accepted?: unknown }).accepted : undefined;
  return sameJson(accepted, face.arc.v2Accept);
}

function cachedUsdcFace(resourceId: string, maxAgeMs: number, config: SellerConfig): UsdcFace | null {
  if (usdcFaceCache?.resourceId !== resourceId || Date.now() - usdcFaceCachedAt >= maxAgeMs) {
    return null;
  }
  validateUsdcFace(usdcFaceCache, config);
  return servedUsdcFace(structuredClone(usdcFaceCache), config);
}

// forPayment を省略したときは支払い扱い (厳しい側の 5 分) にする。
export async function usdcFace(options: { forPayment?: boolean } = {}): Promise<UsdcFace | null> {
  const config = sellerConfig();
  if (!config.expectedUsdcRecipient) return null;
  const { resourceId } = config;
  const maxAgeMs = termsMaxAgeMs(options.forPayment);
  // ヒットで usdcFaceCachedAt を更新してはならない。USDC の verify / settle はこの値を使う。
  const cached = cachedUsdcFace(resourceId, maxAgeMs, config);
  if (cached) return cached;

  const seq = ++usdcFetchSeq;
  const startedAt = Date.now();
  let value: unknown;
  try {
    const res = await fetch(
      OPENPAY_ORIGIN + '/api/x402/relay/requirements?resourceId=' + encodeURIComponent(resourceId),
      { cache: 'no-store' },
    );
    if (res.status === 404) {
      // USDC 面の無効化 / リレー停止の確定シグナル。止めた USDC 面をキャッシュから出し続けない。
      if (seq > usdcAppliedSeq) {
        usdcAppliedSeq = seq;
        if (usdcFaceCache?.resourceId === resourceId) {
          usdcFaceCache = null;
          usdcFaceCachedAt = 0;
        }
      }
      return null;
    }
    if (!res.ok) return null;
    value = await res.json();
  } catch {
    return null;
  }
  // Trust failures must stop both rails, outside the availability fallback above.
  validateUsdcFace(value, config);
  const served = servedUsdcFace(structuredClone(value), config);
  if (Date.now() - startedAt >= maxAgeMs) return null;
  if (seq > usdcAppliedSeq) {
    usdcAppliedSeq = seq;
    usdcFaceCache = value;
    usdcFaceCachedAt = startedAt;
    return served;
  }
  // 後から開始した取得の結果が先に反映済み。古い応答ではなくそちらに従う。
  return cachedUsdcFace(resourceId, maxAgeMs, config);
}
