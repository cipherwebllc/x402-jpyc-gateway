import { consult, consultHead } from '@/lib/purchase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return consult(request);
}

// HEAD を書かないと Next が GET を代わりに動かし、支払いつきの HEAD で verify・上流・settle まで進む。
export function HEAD(request: Request): Promise<Response> {
  return consultHead(request);
}
