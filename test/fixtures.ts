export const OPENPAY = 'https://open-pay.jp';
export const resource = 'https://gateway.example.com/api/consult';
export const resourceId = 'resource-id';
export const merchant = `0x${'ab'.repeat(20)}`;
export const usdcMerchant = `0x${'cd'.repeat(20)}`;
export const attacker = '0x1111111111111111111111111111111111111111';
const forwarder = '0x2222222222222222222222222222222222222222';

export const catalogAccept = {
  scheme: 'exact',
  network: 'eip155:137',
  maxAmountRequired: '1010000000000000000',
  resource,
  description: 'Consultation',
  mimeType: 'application/json',
  payTo: forwarder,
  asset: '0xE7C3e3dC199E8F12B5A0D0D62cD3E2D5b21A4c29',
  extra: {
    openpay: {
      mode: 'forwarder-split',
      forwarder,
      merchant,
      merchantValue: '1000000000000000000',
    },
  },
};

export const listing = { id: resourceId, resource, accepts: [catalogAccept] };
export const paymentPayload = { authorization: 'payment' };
export const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
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
