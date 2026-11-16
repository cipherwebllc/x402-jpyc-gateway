import type { PaymentRequirements } from './types';

// 応答は支払いの条件や結果を含むので、どれも共有キャッシュに載せない。
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function json402(
  accepts: PaymentRequirements[],
  error: string,
  paymentRequiredHeader?: string,
): Response {
  return jsonResponse(
    402,
    { x402Version: 1, accepts, error },
    paymentRequiredHeader === undefined ? {} : { 'PAYMENT-REQUIRED': paymentRequiredHeader },
  );
}
