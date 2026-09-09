import {
  createLicenseGate,
  hasLicense,
  resolveLicense,
  type LicenseDescriptor,
  type LicenseGate,
} from 'openpay-x402-sdk';

const LICENSE_CACHE_TTL_MS = 60_000;
const DESCRIPTOR_TTL_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 30_000;
export const LICENSE_SESSION_TTL_SECONDS = 300;

export type LicenseConfig = Readonly<{
  product: string;
  sessionSecret: string;
  rpcUrl?: string;
  origin: string;
  audience: string;
}>;

export type LicenseRuntime = Readonly<{
  descriptor: Readonly<LicenseDescriptor>;
  gate: LicenseGate;
  config: LicenseConfig;
  resolvedAt: number;
}>;

export class LicenseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseConfigError';
  }
}

export function getLicenseConfig(): LicenseConfig {
  const required = ['LICENSE_PRODUCT_ID', 'LICENSE_SESSION_SECRET', 'MY_RESOURCE_URL'] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new LicenseConfigError(`Missing required license environment variables: ${missing.join(', ')}`);
  }

  const product = process.env.LICENSE_PRODUCT_ID!;
  const sessionSecret = process.env.LICENSE_SESSION_SECRET!;
  const rpcUrl = process.env.POLYGON_RPC_URL || undefined;
  const origin = process.env.LICENSE_ORIGIN || 'https://open-pay.jp';
  const invalid: string[] = [];
  if (!/^h_[0-9a-f]{32}$/.test(product)) invalid.push('LICENSE_PRODUCT_ID');
  if (Buffer.byteLength(sessionSecret, 'utf8') < 32) invalid.push('LICENSE_SESSION_SECRET');

  let descriptorOrigin = '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error();
    descriptorOrigin = url.origin;
  } catch {
    invalid.push('LICENSE_ORIGIN');
  }

  if (rpcUrl) {
    try {
      const url = new URL(rpcUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      invalid.push('POLYGON_RPC_URL');
    }
  }

  let audience = '';
  try {
    const url = new URL(process.env.MY_RESOURCE_URL!);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password) throw new Error();
    audience = url.origin;
  } catch {
    invalid.push('MY_RESOURCE_URL');
  }

  if (invalid.length) {
    throw new LicenseConfigError(`Invalid license configuration: ${invalid.join(', ')}`);
  }
  return { product, sessionSecret, ...(rpcUrl ? { rpcUrl } : {}), origin: descriptorOrigin, audience };
}

function identity(descriptor: Readonly<LicenseDescriptor>) {
  const { chainId, contract, tokenId } = descriptor;
  return { chainId, contract, tokenId };
}

function identityKey(descriptor: Readonly<LicenseDescriptor>): string {
  return `${descriptor.chainId}:${descriptor.contract.toLowerCase()}:${descriptor.tokenId}`;
}

let currentRuntime: LicenseRuntime | null = null;
let pending: Promise<LicenseRuntime> | null = null;
let retryAfter = 0;

export function ensureLicense(): Promise<LicenseRuntime> {
  if (pending) return pending;
  const previous = currentRuntime;
  if (previous && (Date.now() - previous.resolvedAt < DESCRIPTOR_TTL_MS || Date.now() < retryAfter)) {
    return Promise.resolve(previous);
  }

  // Defer validation too, so synchronous failures also release the single-flight promise.
  pending = Promise.resolve().then(async () => {
    const config = previous?.config ?? getLicenseConfig();
    const descriptor = Object.freeze(await resolveLicense({ product: config.product, origin: config.origin }));
    const unchanged = previous !== null && identityKey(previous.descriptor) === identityKey(descriptor);
    let gate = previous?.gate;
    if (!unchanged) {
      gate = createLicenseGate({
        ...identity(descriptor),
        ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
        session: {
          secret: config.sessionSecret,
          ttlSeconds: LICENSE_SESSION_TTL_SECONDS,
          origin: config.audience,
        },
      });
      await gate.ready();
    }

    const next: LicenseRuntime = { descriptor, gate: gate!, config, resolvedAt: Date.now() };
    // Publish only a fully ready gate; existing requests keep their captured runtime.
    if (!unchanged) resetLicenseCache();
    currentRuntime = next;
    retryAfter = 0;
    return next;
  }).catch((error: unknown) => {
    if (!previous) throw error;
    retryAfter = Date.now() + REFRESH_COOLDOWN_MS;
    return previous;
  }).finally(() => {
    pending = null;
  });
  return pending;
}

const payerCache = new Map<string, { holder: boolean; cachedAt: number }>();
let cacheGeneration = 0;

export async function payerHasLicense(runtime: LicenseRuntime, address: string): Promise<boolean> {
  const key = `${identityKey(runtime.descriptor)}:${address.toLowerCase()}`;
  const cached = payerCache.get(key);
  if (cached && Date.now() - cached.cachedAt < LICENSE_CACHE_TTL_MS) return cached.holder;

  const generation = cacheGeneration;
  // Rejections (especially LicenseRpcError) propagate without caching a verdict.
  const result = await hasLicense({
    ...identity(runtime.descriptor),
    address: address as `0x${string}`,
    ...(runtime.config.rpcUrl ? { rpcUrl: runtime.config.rpcUrl } : {}),
  });
  if (generation === cacheGeneration && currentRuntime?.gate === runtime.gate) {
    payerCache.set(key, { holder: result.holder, cachedAt: Date.now() });
  }
  return result.holder;
}

export function resetLicenseCache(): void {
  payerCache.clear();
  cacheGeneration++;
}

export function resetLicenseForTests(): void {
  currentRuntime = null;
  pending = null;
  retryAfter = 0;
  resetLicenseCache();
}
