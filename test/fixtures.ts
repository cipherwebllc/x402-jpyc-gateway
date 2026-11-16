export const OPENPAY = 'https://open-pay.jp';
export const resource = 'https://gateway.example.com/api/consult';
export const resourceId = 'resource-id';
export const merchant = `0x${'ab'.repeat(20)}`;
export const usdcMerchant = `0x${'cd'.repeat(20)}`;
export const attacker = '0x1111111111111111111111111111111111111111';
// Polygon の JPYC と OpenPay の forwarder (本番と同じ値)。
const forwarder = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
export const feeReceiver = `0x${'ee'.repeat(20)}`;
export const buyer = `0x${'33'.repeat(20)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;
// どの場面の時計よりも先 (2100-01-01)。支払いの有効期限そのものは専用のテストで確かめる。
export const VALID_BEFORE = '4102444800';
const hex32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

export const catalogAccept = {
  scheme: 'exact',
  network: 'eip155:137',
  maxAmountRequired: '1010000000000000000',
  resource,
  description: 'Consultation',
  mimeType: 'application/json',
  payTo: forwarder,
  maxTimeoutSeconds: 600,
  asset: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
  extra: {
    openpay: {
      mode: 'forwarder-split',
      forwarder,
      merchant,
      merchantValue: '1000000000000000000',
      feeReceiver,
      feeValue: '10000000000000000',
    },
  },
};

export const listing = { id: resourceId, resource, accepts: [catalogAccept] };
const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

/**
 * 買い手が X-PAYMENT に入れる JPYC の支払い (OpenPay の facilitator が受け取る形)。
 * n を変えると別の支払い (intentSalt が違う) になる。
 */
export function jpycPayment(n = 1, authorization: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:137',
    payload: {
      signature: SIGNATURE,
      authorization: { from: buyer, validAfter: '0', validBefore: VALID_BEFORE, intentSalt: hex32(n), ...authorization },
    },
  };
}
export const jpycPaymentHeader = (n = 1, authorization: Record<string, unknown> = {}) =>
  base64Json(jpycPayment(n, authorization));
export const paymentPayload = jpycPayment();
export const paymentHeader = base64Json(paymentPayload);
export const usdcAccept = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource,
  description: 'Consultation',
  mimeType: 'application/json',
  payTo: usdcMerchant,
  maxTimeoutSeconds: 300,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  extra: { name: 'USDC', version: '2' },
};
export const v2Accept = {
  scheme: usdcAccept.scheme,
  network: 'eip155:8453',
  amount: usdcAccept.maxAmountRequired,
  payTo: usdcMerchant,
  asset: usdcAccept.asset,
  maxTimeoutSeconds: usdcAccept.maxTimeoutSeconds,
  extra: usdcAccept.extra,
};
export const paymentRequiredHeader = Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: { url: resource },
  accepts: [v2Accept],
})).toString('base64');
export const usdcFace = { resourceId, v1Accepts: usdcAccept, v2Accept, paymentRequiredHeader };

export function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const arcV2Accept = {
  scheme: 'exact',
  network: 'eip155:5042',
  amount: usdcAccept.maxAmountRequired,
  asset: '0x3600000000000000000000000000000000000000',
  payTo: usdcMerchant,
  maxTimeoutSeconds: 604_900,
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  },
};

export function arcHeaderFor(accepts: unknown[], over: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: resource },
    accepts,
    ...over,
  })).toString('base64');
}

export const arcPaymentRequiredHeader = arcHeaderFor([v2Accept, arcV2Accept]);

export function usdcFaceWithArc(arcAccept: Record<string, unknown> = arcV2Accept, header?: string) {
  return {
    ...usdcFace,
    arc: { v2Accept: arcAccept, paymentRequiredHeader: header ?? arcHeaderFor([v2Accept, arcAccept]) },
  };
}

/** USDC (EIP-3009) の authorization。n を変えると別の支払い (nonce が違う) になる。 */
export function usdcAuthorization(n: number, over: Record<string, unknown> = {}) {
  return {
    from: buyer,
    to: usdcMerchant,
    value: usdcAccept.maxAmountRequired,
    validAfter: '0',
    validBefore: VALID_BEFORE,
    nonce: hex32(n),
    ...over,
  };
}

/** 買い手が X-PAYMENT に入れる Base の USDC の支払い (x402 v1)。 */
export function usdcV1Payment(n = 0x1001, authorization: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: { signature: SIGNATURE, authorization: usdcAuthorization(n, authorization) },
  };
}
export const usdcV1PaymentHeader = (n = 0x1001, authorization: Record<string, unknown> = {}) =>
  base64Json(usdcV1Payment(n, authorization));

/** 買い手が PAYMENT-SIGNATURE に入れる支払い (x402 v2)。accepted で Base か Arc かが決まる。 */
export function paymentSignatureFor(
  accepted: unknown,
  n = 0x2001,
  authorization: Record<string, unknown> = {},
): string {
  return base64Json({
    x402Version: 2,
    accepted,
    payload: { authorization: usdcAuthorization(n, authorization), signature: SIGNATURE },
  });
}
