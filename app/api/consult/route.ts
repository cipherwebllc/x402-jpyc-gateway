import { consult } from '@/lib/purchase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// async にしない: consult の Promise をそのまま返す。async で包むと、その Promise を引き継ぐ分だけ
// 応答の完了が遅れる。
export function GET(request: Request): Promise<Response> {
  return consult(request);
}
