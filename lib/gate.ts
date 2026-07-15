// OpenPay JPYC x402 ゲート (自己完結・Node 20.9+ / Next 16 要件)
// open-pay.jp 配布のリファレンスゲートを TS 化したもの。意味論は同一で、
// 以下の 2 点だけを変えている:
//   1. accepts の resource だけを実際のリクエスト URL に差し替える
//      (金銭フィールドはカタログ掲載値のまま — 改ざん検知と両立させるため)
//   2. verify と settle を分離して公開する (買い手保護の処理順を route 側で組むため)

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

type CatalogItem = {
  resource?: string;
  accepts?: PaymentRequirements[];
};

let acceptsCache: PaymentRequirements[] | null = null;
let acceptsCachedAt = 0;

export function resetAcceptsCache(): void {
  acceptsCache = null;
  acceptsCachedAt = 0;
}

async function myAccepts(): Promise<PaymentRequirements[]> {
  if (acceptsCache && Date.now() - acceptsCachedAt < 5 * 60_000) return acceptsCache;
  const myResourceUrl = process.env.MY_RESOURCE_URL;
  const res = await fetch(OPENPAY + '/api/discovery');
  if (!res.ok) {
    throw new Error('OpenPay discovery request failed');
  }
  const { items } = (await res.json()) as { items?: CatalogItem[] };
  const mine = (items || []).find((i) => i.resource === myResourceUrl);
  if (!mine || !mine.accepts || mine.accepts.length === 0) {
    // カタログ掲載前はここで落ちて 500 になる (bootstrap の意図された挙動)
    throw new Error('resource not found in OpenPay catalog: ' + myResourceUrl);
  }
  acceptsCache = mine.accepts; // 手数料/forwarder の改定に自動追従 (5 分キャッシュ)
  acceptsCachedAt = Date.now();
  return acceptsCache;
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

  return accepts.map((a) => ({ ...a, resource }));
}

export function json402(accepts: PaymentRequirements[], error: string): Response {
  return new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export function decodePaymentHeader(header: string): unknown | undefined {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
      return undefined;
    }
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function callFacilitator(
  path: 'verify' | 'settle',
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements });
  return fetch(OPENPAY + '/api/facilitator/' + path, {
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
