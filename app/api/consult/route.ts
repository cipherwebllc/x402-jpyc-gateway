import { LicenseError, LicenseRpcError } from 'openpay-x402-sdk';

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
  getLicenseConfig,
  getLicenseGate,
  payerHasLicense,
  type LicenseConfig,
} from '@/lib/license';

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
  config: LicenseConfig,
  paymentRequiredHeader?: string,
): Response {
  return json402(accepts, error, paymentRequiredHeader, {
    required: true,
    product: config.product,
    contract: config.contract,
    tokenId: config.tokenId,
    chainId: config.chainId,
  });
}

function licenseRequired(config: LicenseConfig): Response {
  return new Response(
    JSON.stringify({
      error: 'license_required',
      product: config.product,
      contract: config.contract,
      tokenId: config.tokenId,
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  );
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
  config: LicenseConfig,
): Promise<Response | null> {
  if (typeof verification.payer !== 'string') {
    return jsonError(503, 'license_check_unavailable');
  }
  try {
    if (!(await payerHasLicense(verification.payer))) return licenseRequired(config);
    return null;
  } catch (error) {
    if (error instanceof LicenseRpcError) return jsonError(503, 'license_check_unavailable');
    return jsonError(503, 'license_check_unavailable');
  }
}

export async function GET(request: Request): Promise<Response> {
  let licenseConfig: LicenseConfig;
  try {
    licenseConfig = getLicenseConfig();
  } catch {
    return jsonError(500, 'license_config_missing');
  }

  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  const hasPayment = Boolean(paymentHeader) || paymentSignatureHeader !== null;
  const token = sessionToken(request);
  let licensed = false;
  if (token) {
    try {
      getLicenseGate().check(token);
      licensed = true;
    } catch (error) {
      const invalidSession =
        error instanceof LicenseError &&
        (error.code === 'invalid_session' || error.code === 'session_expired');
      if (!invalidSession) return jsonError(500, 'license_check_unavailable');
      if (!hasPayment) return licenseRequired(licenseConfig);
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
      licenseConfig,
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
        licenseConfig,
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
        licenseConfig,
        usdc?.paymentRequiredHeader,
      );
    }

    if (!licensed) {
      const error = await payerLicenseError(verification, licenseConfig);
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
        licenseConfig,
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
      licenseConfig,
      usdc?.paymentRequiredHeader,
    );
  }

  if (!licensed) {
    const error = await payerLicenseError(verification, licenseConfig);
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
      licenseConfig,
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
