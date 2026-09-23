// OpenPay JPYC x402 ゲート (自己完結・Node 20.9+ / Next 16 要件)
// open-pay.jp 配布のリファレンスゲートを TS 化。SDK 0.10.0 の seller pin を検証し、
// このゲートウェイでは以下の 2 点を維持する:
//   1. accepts の resource だけを実際のリクエスト URL に差し替える
//      (金銭フィールドはカタログ掲載値のまま — 改ざん検知と両立させるため)
//   2. verify と settle を分離して公開する (買い手保護の処理順を route 側で組むため)

import {
  rejectSellerRequirements,
  sellerConfig,
  validateJpycListing,
  validateJpycRequirements,
  validateUsdcFace,
  type CatalogItem,
} from './sellerPins';
export { decodePaymentHeader } from './paymentHeader';

const OPENPAY = 'https://open-pay.jp';

export type PaymentRequirements = {
  resource?: string;
  [key: string]: unknown;
};

export type VerifyResult = {
  isValid?: boolean;
  invalidReason?: string;
  [key: string]: unknown;
};

export type SettleResult = {
  success?: boolean;
  errorReason?: string;
  [key: string]: unknown;
};

export type UsdcFace = {
  resourceId: string;
  v1Accepts: PaymentRequirements;
  v2Accept: PaymentRequirements;
  paymentRequiredHeader: string;
  [key: string]: unknown;
};

let acceptsCache: CatalogItem | null = null;
let acceptsCachedAt = 0;
let usdcFaceCache: UsdcFace | null = null;
let usdcFaceCachedAt = 0;

export function resetAcceptsCache(): void {
  acceptsCache = null;
  acceptsCachedAt = 0;
}

export function resetUsdcFaceCache(): void {
  usdcFaceCache = null;
  usdcFaceCachedAt = 0;
}

export async function usdcFace(): Promise<UsdcFace | null> {
  const config = sellerConfig();
  if (!config.expectedUsdcRecipient) return null;
  const { resourceId } = config;
  if (
    usdcFaceCache &&
    usdcFaceCache.resourceId === resourceId &&
    Date.now() - usdcFaceCachedAt < 5 * 60_000
  ) {
    validateUsdcFace(usdcFaceCache, config);
    return structuredClone(usdcFaceCache);
  }

  let value: unknown;
  try {
    const res = await fetch(
      OPENPAY + '/api/x402/relay/requirements?resourceId=' + encodeURIComponent(resourceId),
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    value = await res.json();
  } catch {
    return null;
  }
  // Trust failures must stop both rails, outside the availability fallback above.
  validateUsdcFace(value, config);
  usdcFaceCache = value;
  usdcFaceCachedAt = Date.now();
  return structuredClone(value);
}

async function myAccepts(): Promise<PaymentRequirements[]> {
  const config = sellerConfig();
  if (acceptsCache?.id === config.resourceId && Date.now() - acceptsCachedAt < 5 * 60_000) {
    validateJpycListing(acceptsCache, config);
    return acceptsCache.accepts;
  }
  let res: Response;
  try {
    res = await fetch(OPENPAY + '/api/discovery/' + encodeURIComponent(config.resourceId), {
      cache: 'no-store',
    });
  } catch {
    rejectSellerRequirements('OpenPay temporarily unavailable (discovery request failed)');
  }
  if (res.status === 404) {
    rejectSellerRequirements('OpenPay listing not found or not public (HTTP 404)');
  }
  if (res.status >= 500) {
    rejectSellerRequirements(`OpenPay temporarily unavailable (HTTP ${res.status})`);
  }
  if (!res.ok) {
    rejectSellerRequirements(`OpenPay discovery request failed (HTTP ${res.status})`);
  }
  let mine: unknown;
  try {
    mine = await res.json();
  } catch {
    rejectSellerRequirements('invalid discovery response');
  }
  validateJpycListing(mine, config);
  acceptsCache = mine; // 検証済みの掲載値のみを 5 分キャッシュ
  acceptsCachedAt = Date.now();
  return mine.accepts;
}

// resource だけをリクエスト URL (クエリ込み) に差し替えた accepts を返す。
// 買い手は accept.resource と自分が叩いた URL の一致を検証するため resource は
// 差し替えが必要だが、金銭フィールド (network/asset/payTo/maxAmountRequired 等) は
// カタログ掲載値と照合されるので絶対に触らない。
export async function acceptsFor(requestUrl: string): Promise<PaymentRequirements[]> {
  const accepts = await myAccepts();
  const configuredResource = process.env.MY_RESOURCE_URL;
  if (!configuredResource) {
    throw new Error('MY_RESOURCE_URL is not set');
  }

  const configuredUrl = new URL(configuredResource);
  const actualRequestUrl = new URL(requestUrl);
  configuredUrl.search = '';
  configuredUrl.hash = '';
  configuredUrl.search = actualRequestUrl.search;
  const resource = configuredUrl.toString();

  return accepts.map((a) => ({ ...structuredClone(a), resource }));
}

export function json402(
  accepts: PaymentRequirements[],
  error: string,
  paymentRequiredHeader?: string,
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  };
  if (paymentRequiredHeader !== undefined) {
    headers['PAYMENT-REQUIRED'] = paymentRequiredHeader;
  }
  return new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers,
  });
}

function callFacilitator(
  path: 'verify' | 'settle',
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<Record<string, unknown>> {
  validateJpycRequirements(paymentRequirements, sellerConfig().expectedRecipient);
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements });
  return fetch(OPENPAY + '/api/facilitator/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then((r) => r.json());
}

export function relayPayment(
  path: 'verify' | 'settle',
  headers: { paymentHeader?: string; paymentSignatureHeader?: string },
  face: UsdcFace,
  jpycAccepts: PaymentRequirements[],
): Promise<Record<string, unknown> | Response> {
  const config = sellerConfig();
  validateUsdcFace(face, config);
  // Bind the relay to this request's validated terms, including during settlement.
  const body = JSON.stringify({
    resourceId: config.resourceId,
    paymentRequirements: face.v1Accepts,
    ...headers,
  });
  return fetch(OPENPAY + '/api/x402/relay/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then(async (r) => {
    if (r.status === 409) {
      resetUsdcFaceCache();
      // Re-pin changed terms and ask the buyer again without replaying the payment.
      const fresh = await usdcFace();
      if (!fresh) rejectSellerRequirements('OpenPay USDC requirements unavailable');
      return json402([...jpycAccepts, fresh.v1Accepts], 'requirements_mismatch', fresh.paymentRequiredHeader);
    }
    return r.json();
  });
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
