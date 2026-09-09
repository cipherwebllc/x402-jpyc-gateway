import { LicenseError, LicenseRpcError } from 'openpay-x402-sdk';

import type { LicenseRuntime } from '@/lib/license';

export function licenseJson(status: number, body: Record<string, unknown>, cookie?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function licenseMetadata({ descriptor }: LicenseRuntime) {
  const { productId, productUrl, chainId, contract, tokenId } = descriptor;
  return { required: true, product: productId, productUrl, chainId, contract, tokenId };
}

export function licenseRequired({ descriptor }: LicenseRuntime): Response {
  return licenseJson(403, {
    error: 'license_required',
    product: descriptor.productId,
    productUrl: descriptor.productUrl,
  });
}

export function licenseFailure(error: unknown, runtime: LicenseRuntime): Response {
  if (error instanceof LicenseRpcError) {
    return licenseJson(503, { error: 'license_check_unavailable' });
  }
  if (error instanceof LicenseError) {
    switch (error.code) {
      case 'no_license':
        return licenseRequired(runtime);
      case 'invalid_challenge':
      case 'challenge_expired':
      case 'invalid_signature':
      case 'invalid_nonce':
        return licenseJson(400, { error: 'license_verification_failed' });
      case 'nonce_store_error':
      case 'not_ready':
        return licenseJson(503, { error: 'license_check_unavailable' });
    }
  }
  return licenseJson(503, { error: 'license_check_unavailable' });
}
