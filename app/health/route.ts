import { ensureLicense } from '@/lib/license';
import { licenseJson, licenseMetadata } from '@/lib/license-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const license = await ensureLicense();
    return licenseJson(200, {
      status: 'ok',
      license: { ...licenseMetadata(license), saleActive: license.descriptor.saleActive },
    });
  } catch {
    return licenseJson(500, { error: 'license_unavailable' });
  }
}
