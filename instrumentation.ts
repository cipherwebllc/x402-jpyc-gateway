import { getLicenseConfig } from '@/lib/license';

export async function register(): Promise<void> {
  getLicenseConfig();
}
