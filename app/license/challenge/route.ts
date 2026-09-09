import { getLicenseGate, LicenseConfigError } from '@/lib/license';

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

export async function GET(request: Request): Promise<Response> {
  const address = new URL(request.url).searchParams.get('address');
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    return json(400, { error: 'invalid_address' });
  }

  try {
    const message = await getLicenseGate().challenge(address as `0x${string}`);
    return json(200, { message });
  } catch (error) {
    if (error instanceof TypeError) return json(400, { error: 'invalid_address' });
    if (error instanceof LicenseConfigError) return json(500, { error: 'license_config_missing' });
    return json(500, { error: 'license_challenge_unavailable' });
  }
}
