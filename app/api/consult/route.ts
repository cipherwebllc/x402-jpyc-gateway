import { consult, consultHead } from '@/lib/purchase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 1 回の購入でいちばん長くかかるのは、出品と USDC の条件の取得 5 + 5 秒、verify 35 秒 (+ relay の 409 のあとの
// 取り直し 5 秒)、上流 125 秒、settle 60 秒 (+ 5 秒) のおよそ 240 秒。途中で打ち切られないよう 300 秒にする。
// (Arc は verify のあと 15 分以内に settle を始めないと relay が断るが、240 秒ならその前に終わる。)
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return consult(request);
}

// HEAD を書かないと Next が GET を代わりに動かし、支払いつきの HEAD で verify・上流・settle まで進む。
export function HEAD(request: Request): Promise<Response> {
  return consultHead(request);
}
