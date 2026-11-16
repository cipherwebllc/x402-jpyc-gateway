// OpenPay の USDC relay (Base / Arc) への verify / settle。

import { json402 } from './http';
import { postToOpenPay, SETTLE_TIMEOUT_MS, VERIFY_TIMEOUT_MS, type OpenPayReply } from './openpay';
import { arcFaceProblem, rejectSellerRequirements, sellerConfig, validateUsdcFace } from './sellerPins';
import type { PaymentRequirements, UsdcFace, UsdcRail } from './types';
import { paymentRequiredHeaderFor, resetUsdcFaceCache, usdcFace } from './usdcFace';

/** USDC の決済条件が出品者の pin に合うか。合わなければ理由を記録して throw する。 */
export function checkRelayPins(face: UsdcFace, rail: UsdcRail): void {
  const config = sellerConfig();
  validateUsdcFace(face, config);
  if (rail === 'arc' && (!face.arc || arcFaceProblem(face, config) !== null)) {
    rejectSellerRequirements('Arc face unavailable');
  }
}

// async にしない: pin の不一致は呼んだその場で throw し、relay には何も送らない。
export function relayPayment(
  path: 'verify' | 'settle',
  headers: { paymentHeader?: string; paymentSignatureHeader?: string },
  face: UsdcFace,
  jpycAccepts: PaymentRequirements[],
  rail: UsdcRail = 'base',
): Promise<OpenPayReply | Response> {
  checkRelayPins(face, rail);
  const config = sellerConfig();
  // Bind the relay to this request's validated terms, including during settlement. The pin's
  // shape names the rail; the relay answers 409 if the payment was made on another rail.
  const body = JSON.stringify({
    resourceId: config.resourceId,
    paymentRequirements: rail === 'arc' ? face.arc!.v2Accept : face.v1Accepts,
    ...headers,
  });
  return postToOpenPay(
    '/api/x402/relay/' + path,
    body,
    path === 'verify' ? VERIFY_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
  ).then(async (reply) => {
    if (reply.status !== 409) return reply;
    resetUsdcFaceCache();
    // Re-pin changed terms and ask the buyer again without replaying the payment.
    const fresh = await usdcFace({ forPayment: true });
    if (!fresh) rejectSellerRequirements('OpenPay USDC requirements unavailable');
    return json402([...jpycAccepts, fresh.v1Accepts], 'requirements_mismatch', paymentRequiredHeaderFor(fresh));
  });
}
