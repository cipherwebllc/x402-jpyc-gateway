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
