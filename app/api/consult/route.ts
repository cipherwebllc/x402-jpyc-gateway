import { jsonResponse } from '@/lib/http';
import { acceptsFor } from '@/lib/listing';
import { choosePayment, paymentRequired, runPurchase } from '@/lib/purchase';
import type { PaymentRequirements, UsdcFace } from '@/lib/types';
import { usdcFace } from '@/lib/usdcFace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  // 402 ゲートと掲載値の鮮度 (5 分 / 30 分) は必ずこの 1 変数から決める。
  const hasPayment = Boolean(paymentHeader) || paymentSignatureHeader !== null;

  let accepts: PaymentRequirements[];
  let usdc: UsdcFace | null;
  try {
    accepts = await acceptsFor(request.url, { forPayment: hasPayment });
    usdc = await usdcFace({ forPayment: hasPayment });
  } catch {
    return jsonResponse(500, { error: 'accepts_unavailable' });
  }

  if (!hasPayment) {
    return paymentRequired(accepts, usdc, 'payment_required');
  }

  const q = new URL(request.url).searchParams.get('q');
  if (!q) {
    return jsonResponse(400, { error: 'q_required' });
  }

  const choice = choosePayment({ paymentHeader, paymentSignatureHeader }, accepts, usdc);
  if (choice.kind === 'reply') return choice.response;
  return runPurchase(choice, q, accepts, usdc);
}
