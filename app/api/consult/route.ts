import { selectedAdapter } from '@/lib/adapters';
import {
  acceptsFor,
  decodePaymentHeader,
  encodePaymentResponse,
  json402,
  relayPayment,
  settlePayment,
  usdcFace,
  verifyPayment,
  type PaymentRequirements,
  type SettleResult,
  type VerifyResult,
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

function paymentError(
  accepts: PaymentRequirements[],
  error: string,
  paymentRequiredHeader?: string,
): Response {
  return json402(accepts, error, paymentRequiredHeader);
}

export async function GET(request: Request): Promise<Response> {
  let accepts: PaymentRequirements[];
  try {
    accepts = await acceptsFor(request.url);
  } catch {
    return jsonError(500, 'accepts_unavailable');
  }

  const usdc = await usdcFace();
  const allAccepts = usdc ? [...accepts, usdc.v1Accepts] : accepts;
  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  if (!paymentHeader && paymentSignatureHeader === null) {
    return paymentError(allAccepts, 'payment_required', usdc?.paymentRequiredHeader);
  }

  const q = new URL(request.url).searchParams.get('q');
  if (!q) {
    return jsonError(400, 'q_required');
  }

  let paymentPayload: unknown;
  let isUsdcRail = usdc !== null && paymentSignatureHeader !== null;
  if (!isUsdcRail) {
    paymentPayload = decodePaymentHeader(paymentHeader ?? '');
    if (paymentPayload === undefined) {
      return paymentError(allAccepts, 'invalid_payment_payload', usdc?.paymentRequiredHeader);
    }
    isUsdcRail =
      usdc !== null &&
      typeof paymentPayload === 'object' &&
      paymentPayload !== null &&
      (paymentPayload as { network?: unknown }).network === usdc.v1Accepts.network;
  }

  if (isUsdcRail) {
    const relayHeaders =
      paymentSignatureHeader !== null
        ? { paymentSignatureHeader }
        : { paymentHeader: paymentHeader! };

    let verification: VerifyResult;
    try {
      verification = (await relayPayment('verify', relayHeaders)) as VerifyResult;
    } catch {
      return jsonError(500, 'payment_verification_failed');
    }
    if (verification?.isValid !== true) {
      return paymentError(
        allAccepts,
        verification?.invalidReason ?? 'payment_invalid',
        usdc?.paymentRequiredHeader,
      );
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

    let settlement: SettleResult;
    try {
      settlement = (await relayPayment('settle', relayHeaders)) as SettleResult;
    } catch {
      return jsonError(500, 'payment_settlement_failed');
    }
    if (settlement?.success !== true) {
      return paymentError(
        allAccepts,
        settlement?.errorReason ?? 'settlement_failed',
        usdc?.paymentRequiredHeader,
      );
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

  let verification;
  try {
    verification = await verifyPayment(paymentPayload, accepts[0]);
  } catch {
    return jsonError(500, 'payment_verification_failed');
  }
  if (verification.isValid !== true) {
    return paymentError(
      allAccepts,
      verification.invalidReason ?? 'invalid_payment',
      usdc?.paymentRequiredHeader,
    );
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
    return paymentError(
      allAccepts,
      settlement.errorReason ?? 'settlement_failed',
      usdc?.paymentRequiredHeader,
    );
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
