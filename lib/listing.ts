// JPYC の出品 (OpenPay discovery) のキャッシュと、このリクエスト用の accepts。
// accepts の resource だけを実際のリクエスト URL に差し替える
// (金銭フィールドはカタログ掲載値のまま — 改ざん検知と両立させるため)。

import { OPENPAY_ORIGIN, termsMaxAgeMs } from './openpay';
import { rejectSellerRequirements, sellerConfig, validateJpycListing } from './sellerPins';
import type { CatalogItem, PaymentRequirements } from './types';

let acceptsCache: CatalogItem | null = null;
let acceptsCachedAt = 0;
// 並行する discovery 取得は「後から開始した取得」の結果だけを反映する (完了順は問わない)。
let listingFetchSeq = 0;
let listingAppliedSeq = 0;

export function resetAcceptsCache(): void {
  acceptsCache = null;
  acceptsCachedAt = 0;
  listingAppliedSeq = listingFetchSeq;
}

async function listingAccepts(maxAgeMs: number): Promise<PaymentRequirements[]> {
  const config = sellerConfig();
  // ヒットで acceptsCachedAt を更新してはならない。支払いリクエストの 5 分判定は取得時刻が基準。
  if (acceptsCache?.id === config.resourceId && Date.now() - acceptsCachedAt < maxAgeMs) {
    validateJpycListing(acceptsCache, config);
    return acceptsCache.accepts;
  }
  const seq = ++listingFetchSeq;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENPAY_ORIGIN + '/api/discovery/' + encodeURIComponent(config.resourceId), {
      cache: 'no-store',
    });
  } catch {
    rejectSellerRequirements('OpenPay temporarily unavailable (discovery request failed)');
  }
  if (res.status === 404) {
    // 出品が消えた確定シグナル。購入できない出品の 402 をキャッシュから出し続けない。
    if (seq > listingAppliedSeq) {
      listingAppliedSeq = seq;
      if (acceptsCache?.id === config.resourceId) {
        acceptsCache = null;
        acceptsCachedAt = 0;
      }
    }
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
  // 掲載値の年齢は取得の開始時刻から数える。応答が遅れた分だけ新しく見せない。
  if (Date.now() - startedAt >= maxAgeMs) {
    rejectSellerRequirements('OpenPay discovery response too old');
  }
  if (seq > listingAppliedSeq) {
    listingAppliedSeq = seq;
    acceptsCache = mine; // 検証済みの掲載値のみをキャッシュ (支払いあり 5 分 / なし 30 分で使う)
    acceptsCachedAt = startedAt;
    return mine.accepts;
  }
  // 後から開始した取得の結果が先に反映済み。古い応答ではなくそちらに従う。
  if (acceptsCache?.id === config.resourceId && Date.now() - acceptsCachedAt < maxAgeMs) {
    validateJpycListing(acceptsCache, config);
    return acceptsCache.accepts;
  }
  rejectSellerRequirements('OpenPay listing superseded by a newer discovery result');
}

// resource だけをリクエスト URL (クエリ込み) に差し替えた accepts を返す。
// 買い手は accept.resource と自分が叩いた URL の一致を検証するため resource は
// 差し替えが必要だが、金銭フィールド (network/asset/payTo/maxAmountRequired 等) は
// カタログ掲載値と照合されるので絶対に触らない。
// forPayment を省略したときは支払い扱い (厳しい側の 5 分) にする。
export async function acceptsFor(
  requestUrl: string,
  options: { forPayment?: boolean } = {},
): Promise<PaymentRequirements[]> {
  const accepts = await listingAccepts(termsMaxAgeMs(options.forPayment));
  // listingAccepts の sellerConfig() が MY_RESOURCE_URL を確かめ済み。
  const configuredUrl = new URL(process.env.MY_RESOURCE_URL!);
  const actualRequestUrl = new URL(requestUrl);
  configuredUrl.hash = '';
  configuredUrl.search = actualRequestUrl.search;
  const resource = configuredUrl.toString();

  return accepts.map((a) => ({ ...structuredClone(a), resource }));
}
