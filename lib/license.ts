import {
  createLicenseGate,
  hasLicense,
  type LicenseGate,
} from 'openpay-x402-sdk';

const LICENSE_CACHE_TTL_MS = 60_000;
export const LICENSE_SESSION_TTL_SECONDS = 300;

const REQUIRED_LICENSE_ENV = [
  'LICENSE_CHAIN_ID',
  'LICENSE_CONTRACT',
  'LICENSE_TOKEN_ID',
  'LICENSE_PRODUCT_ID',
  'LICENSE_PRODUCT_URL',
  'LICENSE_SESSION_SECRET',
  'POLYGON_RPC_URL',
] as const;

type EvmAddress = `0x${string}`;
type HexTokenId = `0x${string}`;

export type LicenseConfig = {
  chainId: number;
  contract: EvmAddress;
  tokenId: HexTokenId;
  productId: string;
  product: string;
  sessionSecret: string;
  rpcUrl: string;
  origin: string;
  ttlSeconds: number;
};

export class LicenseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseConfigError';
  }
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function licenseOrigin(resourceUrl: string | undefined): string {
  if (!resourceUrl) {
    throw new LicenseConfigError('Invalid license configuration: MY_RESOURCE_URL is required');
  }

  try {
    const url = new URL(resourceUrl);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error();
    return url.origin;
  } catch {
    throw new LicenseConfigError('Invalid license configuration: MY_RESOURCE_URL');
  }
}

export function getLicenseConfig(): LicenseConfig {
  const missing = REQUIRED_LICENSE_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new LicenseConfigError(
      `Missing required license environment variables: ${missing.join(', ')}`,
    );
  }

  const chainIdValue = process.env.LICENSE_CHAIN_ID!;
  const contract = process.env.LICENSE_CONTRACT!;
  const tokenId = process.env.LICENSE_TOKEN_ID!;
  const productId = process.env.LICENSE_PRODUCT_ID!;
  const product = process.env.LICENSE_PRODUCT_URL!;
  const sessionSecret = process.env.LICENSE_SESSION_SECRET!;
  const rpcUrl = process.env.POLYGON_RPC_URL!;
  const invalid: string[] = [];

  const chainId = Number(chainIdValue);
  if (!/^[1-9][0-9]*$/.test(chainIdValue) || !Number.isSafeInteger(chainId)) {
    invalid.push('LICENSE_CHAIN_ID');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract) || /^0x0{40}$/i.test(contract)) {
    invalid.push('LICENSE_CONTRACT');
  }
  if (!/^0x[0-9a-fA-F]+$/.test(tokenId)) {
    invalid.push('LICENSE_TOKEN_ID');
  } else {
    try {
      if (BigInt(tokenId) >= 1n << 256n) invalid.push('LICENSE_TOKEN_ID');
    } catch {
      invalid.push('LICENSE_TOKEN_ID');
    }
  }
  if (!httpUrl(product)) invalid.push('LICENSE_PRODUCT_URL');
  if (Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    invalid.push('LICENSE_SESSION_SECRET');
  }
  if (!httpUrl(rpcUrl)) invalid.push('POLYGON_RPC_URL');

  if (invalid.length > 0) {
    throw new LicenseConfigError(`Invalid license configuration: ${invalid.join(', ')}`);
  }

  return {
    chainId,
    contract: contract as EvmAddress,
    tokenId: tokenId as HexTokenId,
    productId,
    product,
    sessionSecret,
    rpcUrl,
    origin: licenseOrigin(process.env.MY_RESOURCE_URL),
    ttlSeconds: LICENSE_SESSION_TTL_SECONDS,
  };
}

let gate: LicenseGate | null = null;

export function getLicenseGate(): LicenseGate {
  const config = getLicenseConfig();
  if (gate === null) {
    gate = createLicenseGate({
      chainId: config.chainId,
      contract: config.contract,
      tokenId: config.tokenId,
      rpcUrl: config.rpcUrl,
      origin: config.origin,
      session: {
        secret: config.sessionSecret,
        ttlSeconds: config.ttlSeconds,
      },
    });
  }
  return gate;
}

type LicenseCacheEntry = {
  holder: boolean;
  cachedAt: number;
};

const payerCache = new Map<string, LicenseCacheEntry>();

export async function payerHasLicense(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  const cached = payerCache.get(key);
  if (cached && Date.now() - cached.cachedAt < LICENSE_CACHE_TTL_MS) return cached.holder;

  const config = getLicenseConfig();
  const result = await hasLicense({
    address: address as EvmAddress,
    chainId: config.chainId,
    contract: config.contract,
    tokenId: config.tokenId,
    rpcUrl: config.rpcUrl,
  });
  payerCache.set(key, { holder: result.holder, cachedAt: Date.now() });
  return result.holder;
}

export function resetLicenseGate(): void {
  gate = null;
}

export function resetLicenseCache(): void {
  payerCache.clear();
}

export function resetLicenseForTests(): void {
  resetLicenseGate();
  resetLicenseCache();
}
