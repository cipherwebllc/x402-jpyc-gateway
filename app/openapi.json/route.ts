import { openApiDocument } from '@/lib/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export async function GET(): Promise<Response> {
  let document: Record<string, unknown> | null;
  try {
    document = await openApiDocument();
  } catch {
    document = null;
  }
  return document ? json(200, document) : json(404, { error: 'openapi_unavailable' });
}
