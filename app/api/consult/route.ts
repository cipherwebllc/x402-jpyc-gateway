import { selectedAdapter } from '@/lib/adapters';
import {
  acceptsFor,
  decodePaymentHeader,
  encodePaymentResponse,
  json402,
  settlePayment,
  verifyPayment,
  type PaymentRequirements,
} from '@/lib/gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function paymentError(accepts: PaymentRequirements[], error: string): Response {
  return json402(accepts, error);
}

export async function GET(request: Request): Promise<Response> {
  let accepts: PaymentRequirements[];
  try {
    accepts = await acceptsFor(request.url);
  } catch {
    return jsonError(500, 'accepts_unavailable');
  }

  const paymentHeader = request.headers.get('X-PAYMENT');
  if (!paymentHeader) {
    return paymentError(accepts, 'payment_required');
  }

  const q = new URL(request.url).searchParams.get('q');
  if (!q) {
    return jsonError(400, 'q_required');
  }

  const paymentPayload = decodePaymentHeader(paymentHeader);
  if (paymentPayload === undefined) {
    return paymentError(accepts, 'invalid_payment_payload');
  }

  let verification;
  try {
    verification = await verifyPayment(paymentPayload, accepts[0]);
  } catch {
    return jsonError(500, 'payment_verification_failed');
  }
  if (verification.isValid !== true) {
    return paymentError(accepts, verification.invalidReason ?? 'invalid_payment');
  }

  let serializedBody: string;
  try {
    const result = await selectedAdapter()({ q });
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error('adapter result is not JSON serializable');
    serializedBody = serialized;
  } catch {
    return jsonError(502, 'upstream_error');
  }

  let settlement;
  try {
    settlement = await settlePayment(paymentPayload, accepts[0]);
  } catch {
    return jsonError(500, 'payment_settlement_failed');
  }
  if (settlement.success !== true) {
    return paymentError(accepts, settlement.errorReason ?? 'settlement_failed');
  }

  return new Response(serializedBody, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'X-PAYMENT-RESPONSE': encodePaymentResponse(settlement),
    },
  });
}
