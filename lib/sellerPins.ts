// Seller-owned trust anchors and validation, matching openpay-x402-sdk 0.10.0.
import type { PaymentRequirements, UsdcFace } from './gate';
import { decodePaymentHeader } from './paymentHeader';

export type SellerConfig = {
  resourceId: string;
  resourceUrl: string;
  expectedRecipient: string;
  expectedUsdcRecipient?: string;
};

export type CatalogItem = {
  id: string;
  resource: string;
  accepts: PaymentRequirements[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function address(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

/** Structural equality for JSON values (object key order does not matter). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]));
  }
  const ra = record(a);
  const rb = record(b);
  if (!ra || !rb) return false;
  const keys = Object.keys(ra).sort();
  return sameJson(keys, Object.keys(rb).sort()) && keys.every((key) => sameJson(ra[key], rb[key]));
}

// Arc (Circle Gateway) pins: the Arc network paired with the Base network of the USDC face,
// and the Gateway Wallet that buyers sign for (EIP-712 domain GatewayWalletBatched / 1).
const ARC_BY_BASE_NETWORK: Record<string, { network: string; gatewayWallet: string }> = {
  'eip155:8453': { network: 'eip155:5042', gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE' },
  'eip155:84532': { network: 'eip155:5042002', gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' },
};
export const ARC_NETWORKS = ['eip155:5042', 'eip155:5042002'];
const ARC_USDC = '0x3600000000000000000000000000000000000000';
// Gateway rejects authorizations valid for less than 3 days; OpenPay uses 604900 seconds.
const ARC_MIN_TIMEOUT_SECONDS = 3 * 24 * 60 * 60;
const ARC_MAX_TIMEOUT_SECONDS = 8 * 24 * 60 * 60;

const BURN_RECIPIENTS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000000000000000000000000',
]);

export function rejectSellerRequirements(reason: string): never {
  // Only caller-defined reasons: never log remote bodies, wallets, URLs, or payment data.
  console.error(`[openpay-x402] ${reason}`);
  throw new Error(`OpenPay seller gate: ${reason}`);
}

export function sellerConfig(): SellerConfig {
  const errors: string[] = [];
  const resourceId = process.env.MY_RESOURCE_ID;
  if (!resourceId?.trim()) {
    errors.push('MY_RESOURCE_ID is required from your own OpenPay listing');
  } else if (resourceId !== resourceId.trim()) {
    errors.push('MY_RESOURCE_ID must not contain surrounding whitespace');
  }
  const expectedRecipient = process.env.EXPECTED_RECIPIENT;
  const expectedUsdcRecipient = process.env.EXPECTED_USDC_RECIPIENT || undefined;
  for (const [name, value] of [
    ['EXPECTED_RECIPIENT', expectedRecipient],
    ['EXPECTED_USDC_RECIPIENT', expectedUsdcRecipient],
  ]) {
    if (name === 'EXPECTED_USDC_RECIPIENT' && value === undefined) continue;
    const recipient = address(value);
    if (!recipient) {
      errors.push(`${name} ${name === 'EXPECTED_RECIPIENT' ? 'is required and ' : ''}must be a seller wallet address from your own config`);
    } else if (BURN_RECIPIENTS.has(recipient)) {
      errors.push(`${name} must not be the zero address or a known burn address`);
    }
  }
  const resourceUrl = process.env.MY_RESOURCE_URL;
  if (!resourceUrl) {
    errors.push('MY_RESOURCE_URL is required');
  } else {
    try {
      const url = new URL(resourceUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    } catch {
      errors.push('MY_RESOURCE_URL must be an absolute HTTP(S) URL');
    }
  }
  if (errors.length > 0) rejectSellerRequirements(errors.join('; '));
  return {
    resourceId: resourceId!,
    resourceUrl: resourceUrl!,
    expectedRecipient: expectedRecipient!,
    expectedUsdcRecipient,
  };
}

export function validateJpycRequirements(value: unknown, expectedRecipient: string): void {
  const accept = record(value);
  const split = record(record(accept?.extra)?.openpay);
  if (address(split?.merchant) !== address(expectedRecipient)) {
    rejectSellerRequirements('JPYC recipient mismatch');
  }
  if (split?.mode !== 'forwarder-split' || !address(split.forwarder) ||
      address(accept?.payTo) !== address(split.forwarder)) {
    rejectSellerRequirements('JPYC forwarder mismatch');
  }
}

export function validateJpycListing(value: unknown, config: SellerConfig): asserts value is CatalogItem {
  const item = record(value);
  if (item?.id !== config.resourceId || item.resource !== config.resourceUrl) {
    rejectSellerRequirements('resource identity mismatch');
  }
  if (!Array.isArray(item.accepts) || item.accepts.length === 0) {
    rejectSellerRequirements('resource has no payment requirements');
  }
  for (const accept of item.accepts) {
    validateJpycRequirements(accept, config.expectedRecipient);
  }
}

export function validateUsdcFace(value: unknown, config: SellerConfig): asserts value is UsdcFace {
  if (!config.expectedUsdcRecipient) rejectSellerRequirements('USDC rail is disabled');
  const face = record(value);
  if (face?.resourceId !== config.resourceId) {
    rejectSellerRequirements('USDC resource identity mismatch');
  }
  const decoded = typeof face.paymentRequiredHeader === 'string'
    ? decodePaymentHeader(face.paymentRequiredHeader) : undefined;
  if (decoded === undefined) {
    rejectSellerRequirements('invalid USDC payment requirements header');
  }
  const required = record(decoded);
  if (!Array.isArray(required?.accepts) || required.accepts.length === 0) {
    rejectSellerRequirements('USDC header has no payment requirements');
  }
  const accepts = [face.v1Accepts, face.v2Accept, ...required.accepts].map(record);
  for (const accept of accepts) {
    if (address(accept?.payTo) !== address(config.expectedUsdcRecipient)) {
      rejectSellerRequirements('USDC recipient mismatch');
    }
  }
  const v1 = accepts[0]!;
  const network = v1.network === 'base' ? 'eip155:8453'
    : v1.network === 'base-sepolia' ? 'eip155:84532' : undefined;
  for (const accept of accepts.slice(1)) {
    if (!network || accept?.network !== network || accept.scheme !== v1.scheme ||
        !address(v1.asset) || address(accept.asset) !== address(v1.asset) ||
        accept.amount !== v1.maxAmountRequired) {
      rejectSellerRequirements('USDC requirements mismatch');
    }
  }
}

/**
 * Checks the optional Arc face of a USDC face that already passed validateUsdcFace.
 * Money terms (recipient, network, asset, amount, the header's accepts) throw like the Base
 * face. Signing-domain terms return a reason instead: a wrong Gateway Wallet only makes the
 * buyer's signature invalid, so the caller drops the Arc face and keeps Base and JPYC selling.
 */
export function arcFaceProblem(face: UsdcFace, config: SellerConfig): string | null {
  const arc = record(face.arc);
  const accept = record(arc?.v2Accept);
  const pair = ARC_BY_BASE_NETWORK[String(face.v2Accept.network)];
  if (!accept || !pair || accept.scheme !== 'exact' || accept.network !== pair.network ||
      address(accept.asset) !== ARC_USDC ||
      accept.amount !== face.v1Accepts.maxAmountRequired ||
      address(accept.payTo) !== address(config.expectedUsdcRecipient)) {
    rejectSellerRequirements('Arc requirements mismatch');
  }
  const header = record(typeof arc?.paymentRequiredHeader === 'string'
    ? decodePaymentHeader(arc.paymentRequiredHeader) : undefined);
  if (!Array.isArray(header?.accepts) || header.accepts.length !== 2 ||
      !sameJson(header.accepts[0], face.v2Accept) || !sameJson(header.accepts[1], accept)) {
    rejectSellerRequirements('Arc header mismatch');
  }
  const extra = record(accept.extra);
  if (extra?.name !== 'GatewayWalletBatched' || extra.version !== '1' ||
      address(extra.verifyingContract) !== address(pair.gatewayWallet)) {
    return 'Arc signing domain mismatch';
  }
  const timeout = accept.maxTimeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) ||
      timeout < ARC_MIN_TIMEOUT_SECONDS || timeout > ARC_MAX_TIMEOUT_SECONDS) {
    return 'Arc payment timeout out of range';
  }
  const arcMeta = { ...header };
  const baseMeta = { ...record(decodePaymentHeader(face.paymentRequiredHeader)) };
  delete arcMeta.accepts;
  delete baseMeta.accepts;
  if (!sameJson(arcMeta, baseMeta)) return 'Arc header metadata mismatch';
  return null;
}
