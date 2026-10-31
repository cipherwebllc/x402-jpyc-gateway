// x402scan 用の OpenAPI 文書。支払いの経路に影響させないため、lib/gate.ts のキャッシュと
// 取得の順序には触らず、検証だけを共有して OpenPay を別に読む。
import {
  arcFaceProblem,
  sellerConfig,
  validateJpycListing,
  validateUsdcFace,
  type CatalogItem,
  type SellerConfig,
} from './sellerPins';

const OPENPAY = 'https://open-pay.jp';
// OpenPay の取得上限は IP ごとで /api/consult と共有する。失敗も含めて読む回数を抑える。
const LISTING_TTL_MS = 30 * 60_000;
const RETRY_AFTER_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;
// OpenPay が保存する usdc.priceUsd の形 (USD の 10 進文字列)。
const USD_PRICE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

type ListingFields = { title?: unknown; description?: unknown; usdc?: { priceUsd?: unknown } };
type ListingText = { title?: string; description: string; price: string };
type ListingRead = { startedAt: number; ttlMs: number; listing: Promise<ListingText | null> };

let listingRead: ListingRead | null = null;

export function resetOpenApiCache(): void {
  listingRead = null;
}

async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenPay responded ${res.status}`);
  return res.json();
}

async function readListing(config: SellerConfig): Promise<ListingText | null> {
  const id = encodeURIComponent(config.resourceId);
  const [face, listing] = await Promise.all([
    readJson(`${OPENPAY}/api/x402/relay/requirements?resourceId=${id}`),
    readJson(`${OPENPAY}/api/discovery/${id}`),
  ]);
  // /api/consult が 500 になる条件は、ここでも出さない。
  validateUsdcFace(face, config);
  if (face.arc !== undefined) arcFaceProblem(face, config);
  validateJpycListing(listing, config);

  const { title, description, usdc } = listing as CatalogItem & ListingFields;
  const price = usdc?.priceUsd;
  if (typeof price !== 'string' || !USD_PRICE.test(price) || !/[1-9]/.test(price)) return null;
  if (typeof description !== 'string' || !description) return null;
  return { ...(typeof title === 'string' && title ? { title } : {}), description, price };
}

// 同時のリクエストは 1 回の読み取りを共有する。失敗は RETRY_AFTER_MS のあいだ読み直さない。
function cachedListing(config: SellerConfig): Promise<ListingText | null> {
  if (listingRead && Date.now() - listingRead.startedAt < listingRead.ttlMs) {
    return listingRead.listing;
  }
  const read: ListingRead = {
    startedAt: Date.now(),
    ttlMs: RETRY_AFTER_MS,
    listing: readListing(config).catch(() => null),
  };
  void read.listing.then((listing) => {
    if (listing) read.ttlMs = LISTING_TTL_MS;
  });
  listingRead = read;
  return read.listing;
}

// 選んだアダプタが動く設定のときだけ、その応答の schema を返す。
function outputSchema(): Record<string, unknown> | null {
  const adapter = process.env.ADAPTER || 'coo-icp';
  if (adapter === 'coo-icp' && process.env.COO_CANISTER_ID) {
    return {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
  }
  // http アダプタは上流の JSON をそのまま返すので、形を決められない。
  if (adapter === 'http' && process.env.UPSTREAM_URL) {
    return { description: 'JSON returned by the upstream API, relayed as is' };
  }
  return null;
}

/** The document, or null when USDC is off or the config or listing cannot be confirmed. */
export async function openApiDocument(): Promise<Record<string, unknown> | null> {
  const config = sellerConfig();
  const schema = outputSchema();
  if (!config.expectedUsdcRecipient || !schema) return null;
  const listing = await cachedListing(config);
  if (!listing) return null;

  const { host, origin, pathname } = new URL(config.resourceUrl);
  return {
    openapi: '3.1.0',
    info: {
      title: listing.title ?? host,
      version: '1.0.0',
      description: listing.description,
      'x-guidance':
        `Call GET ${pathname}?q=<input>. The first call returns 402 with the x402 payment terms. ` +
        'Pay with an x402 client and retry the same URL. ' +
        'Settlement happens after the upstream responds, so an upstream failure is not settled.',
    },
    servers: [{ url: origin }],
    paths: {
      [pathname]: {
        get: {
          operationId: 'consult',
          summary: listing.description,
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              description: 'Input passed to the upstream for this one paid request',
              schema: { type: 'string', minLength: 1 },
            },
          ],
          'x-payment-info': {
            price: { mode: 'fixed', currency: 'USD', amount: listing.price },
            protocols: [{ x402: {} }],
          },
          responses: {
            '200': {
              description: 'Paid response',
              content: { 'application/json': { schema } },
            },
            '402': {
              description: 'Payment required. The response carries the x402 payment terms.',
            },
          },
        },
      },
    },
  };
}
