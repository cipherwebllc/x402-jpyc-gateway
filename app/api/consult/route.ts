import { LicenseError } from 'openpay-x402-sdk';

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
import {
  ensureLicense,
  payerHasLicense,
  type LicenseRuntime,
} from '@/lib/license';
import { licenseFailure, licenseMetadata, licenseRequired } from '@/lib/license-http';

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
  license: LicenseRuntime,
  paymentRequiredHeader?: string,
): Response {
  return json402(accepts, error, paymentRequiredHeader, licenseMetadata(license));
}

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || cookieValue(request.headers.get('cookie'), 'license_session');
}

async function payerLicenseError(
  verification: VerifyResult,
  license: LicenseRuntime,
): Promise<Response | null> {
  if (typeof verification.payer !== 'string') {
    return jsonError(503, 'license_check_unavailable');
  }
  try {
    if (!(await payerHasLicense(license, verification.payer))) return licenseRequired(license);
    return null;
  } catch (error) {
    return licenseFailure(error, license);
  }
}

export async function GET(request: Request): Promise<Response> {
  let license: LicenseRuntime;
  try {
    license = await ensureLicense();
  } catch {
    return jsonError(500, 'license_unavailable');
  }

  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  const hasPayment = Boolean(paymentHeader) || paymentSignatureHeader !== null;
  const token = sessionToken(request);
  let licensed = false;
  if (token) {
    try {
      license.gate.check(token);
      licensed = true;
    } catch (error) {
      const invalidSession =
        error instanceof LicenseError &&
        (error.code === 'invalid_session' || error.code === 'session_expired');
      if (!invalidSession) return licenseFailure(error, license);
      if (!hasPayment) return licenseRequired(license);
    }
  }

  let accepts: PaymentRequirements[];
  try {
    accepts = await acceptsFor(request.url);
  } catch {
    return jsonError(500, 'accepts_unavailable');
  }

  const usdc = await usdcFace();
  const allAccepts = usdc ? [...accepts, usdc.v1Accepts] : accepts;
  if (!paymentHeader && paymentSignatureHeader === null) {
    return paymentError(
      allAccepts,
      'payment_required',
      license,
      usdc?.paymentRequiredHeader,
    );
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
      return paymentError(
        allAccepts,
        'invalid_payment_payload',
        license,
        usdc?.paymentRequiredHeader,
      );
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
        license,
        usdc?.paymentRequiredHeader,
      );
    }

    if (!licensed) {
      const error = await payerLicenseError(verification, license);
      if (error) return error;
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
        license,
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
      license,
      usdc?.paymentRequiredHeader,
    );
  }

  if (!licensed) {
    const error = await payerLicenseError(verification, license);
    if (error) return error;
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
      license,
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
