import { ensureLicense } from '@/lib/license';

export async function register(): Promise<void> {
  await ensureLicense();
}
