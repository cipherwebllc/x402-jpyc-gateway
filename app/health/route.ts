import { getLicenseConfig, LicenseConfigError } from '@/lib/license';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export async function GET(): Promise<Response> {
  try {
    const config = getLicenseConfig();
    return json(200, {
      status: 'ok',
      license: {
        required: true,
        chainId: config.chainId,
        contract: config.contract,
        tokenId: config.tokenId,
        productId: config.productId,
        product: config.product,
      },
    });
  } catch (error) {
    if (error instanceof LicenseConfigError) return json(500, { error: 'license_config_missing' });
    return json(500, { error: 'license_unavailable' });
  }
}
