// OpenPay の USDC relay (Base / Arc) への verify / settle。

import { json402 } from './http';
import { OPENPAY_ORIGIN } from './openpay';
import { arcFaceProblem, rejectSellerRequirements, sellerConfig, validateUsdcFace } from './sellerPins';
import type { PaymentRequirements, UsdcFace, UsdcRail } from './types';
import { paymentRequiredHeaderFor, resetUsdcFaceCache, usdcFace } from './usdcFace';

// async にしない: pin の不一致は呼んだその場で throw し、relay には何も送らない。
export function relayPayment(
  path: 'verify' | 'settle',
  headers: { paymentHeader?: string; paymentSignatureHeader?: string },
  face: UsdcFace,
  jpycAccepts: PaymentRequirements[],
  rail: UsdcRail = 'base',
): Promise<Record<string, unknown> | Response> {
  const config = sellerConfig();
  validateUsdcFace(face, config);
  if (rail === 'arc' && (!face.arc || arcFaceProblem(face, config) !== null)) {
    rejectSellerRequirements('Arc face unavailable');
  }
  // Bind the relay to this request's validated terms, including during settlement. The pin's
  // shape names the rail; the relay answers 409 if the payment was made on another rail.
  const body = JSON.stringify({
    resourceId: config.resourceId,
    paymentRequirements: rail === 'arc' ? face.arc!.v2Accept : face.v1Accepts,
    ...headers,
  });
  return fetch(OPENPAY_ORIGIN + '/api/x402/relay/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then(async (r) => {
    if (r.status === 409) {
      resetUsdcFaceCache();
      // Re-pin changed terms and ask the buyer again without replaying the payment.
      const fresh = await usdcFace({ forPayment: true });
      if (!fresh) rejectSellerRequirements('OpenPay USDC requirements unavailable');
      return json402([...jpycAccepts, fresh.v1Accepts], 'requirements_mismatch', paymentRequiredHeaderFor(fresh));
    }
    return r.json();
  });
}
