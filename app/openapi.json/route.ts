import { jsonResponse } from '@/lib/http';
import { openApiDocument } from '@/lib/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let document: Record<string, unknown> | null;
  try {
    document = await openApiDocument();
  } catch {
    document = null;
  }
  return document ? jsonResponse(200, document) : jsonResponse(404, { error: 'openapi_unavailable' });
}
