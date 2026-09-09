import {
  ensureLicense,
  LICENSE_SESSION_TTL_SECONDS,
  type LicenseRuntime,
} from '@/lib/license';
import { licenseFailure, licenseJson } from '@/lib/license-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let license: LicenseRuntime;
  try {
    license = await ensureLicense();
  } catch {
    return licenseJson(500, { error: 'license_unavailable' });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return licenseJson(400, { error: 'invalid_request' });
  }

  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { message?: unknown }).message !== 'string' ||
    typeof (input as { signature?: unknown }).signature !== 'string' ||
    !/^0x[0-9a-fA-F]+$/.test((input as { signature: string }).signature)
  ) {
    return licenseJson(400, { error: 'invalid_request' });
  }

  try {
    const token = await license.gate.verify({
      message: (input as { message: string }).message,
      signature: (input as { signature: `0x${string}` }).signature,
    });
    const session = license.gate.check(token);
    const cookie = [
      `license_session=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${LICENSE_SESSION_TTL_SECONDS}`,
    ].join('; ');
    return licenseJson(200, { token, address: session.address, exp: session.exp }, cookie);
  } catch (error) {
    return licenseFailure(error, license);
  }
}
