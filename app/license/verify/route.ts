import { LicenseError, LicenseRpcError } from 'openpay-x402-sdk';

import {
  getLicenseGate,
  LicenseConfigError,
  LICENSE_SESSION_TTL_SECONDS,
} from '@/lib/license';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: Record<string, unknown>, cookie?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(request: Request): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json(400, { error: 'invalid_request' });
  }

  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { message?: unknown }).message !== 'string' ||
    typeof (input as { signature?: unknown }).signature !== 'string' ||
    !/^0x[0-9a-fA-F]+$/.test((input as { signature: string }).signature)
  ) {
    return json(400, { error: 'invalid_request' });
  }

  try {
    const gate = getLicenseGate();
    const token = await gate.verify({
      message: (input as { message: string }).message,
      signature: (input as { signature: `0x${string}` }).signature,
    });
    const session = gate.check(token);
    const cookie = [
      `license_session=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${LICENSE_SESSION_TTL_SECONDS}`,
    ].join('; ');
    return json(200, { token, address: session.address, exp: session.exp }, cookie);
  } catch (error) {
    if (error instanceof LicenseConfigError) return json(500, { error: 'license_config_missing' });
    if (error instanceof LicenseRpcError) {
      return json(503, { error: 'license_check_unavailable' });
    }
    if (error instanceof LicenseError) {
      if (error.code === 'no_license') return json(403, { error: 'license_required' });
      return json(400, { error: 'license_verification_failed' });
    }
    return json(500, { error: 'license_verification_failed' });
  }
}
