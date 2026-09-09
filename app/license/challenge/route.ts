import { ensureLicense, type LicenseRuntime } from '@/lib/license';
import { licenseFailure, licenseJson } from '@/lib/license-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let license: LicenseRuntime;
  try {
    license = await ensureLicense();
  } catch {
    return licenseJson(500, { error: 'license_unavailable' });
  }

  const address = new URL(request.url).searchParams.get('address');
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    return licenseJson(400, { error: 'invalid_address' });
  }

  try {
    const message = await license.gate.challenge(address as `0x${string}`);
    return licenseJson(200, { message });
  } catch (error) {
    if (error instanceof TypeError) return licenseJson(400, { error: 'invalid_address' });
    return licenseFailure(error, license);
  }
}
