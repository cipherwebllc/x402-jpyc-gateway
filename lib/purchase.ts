// GET / HEAD /api/consult の本体。決済条件を読み、どの rail で払うかを決め (choosePayment)、
// 支払いを予約して (claims.ts)、verify → 上流 → settle を 1 本の手順で動かす。上流が失敗したら settle しない。
// OpenPay の応答は openpay.ts の verifyOutcome / settleOutcome で読み分ける。

import { selectedAdapter } from './adapters';
import {
  claimAuthorization,
  hasValidityWindow,
  jpycAuthorizationClaim,
  jpycTerms,
  MAX_UPSTREAM_SECONDS,
  releaseAuthorization,
  retainAuthorization,
  usdcAuthorizationClaim,
  usdcTerms,
  type AuthorizationClaim,
  type HeldClaim,
} from './claims';
import { json402, jsonResponse } from './http';
import { acceptsFor } from './listing';
import {
  encodePaymentResponse,
  facilitatorSettleBodyFits,
  reservationTokenOf,
  settleOutcome,
  settlePayment,
  verifyOutcome,
  verifyPayment,
  type OpenPayReply,
} from './openpay';
import { decodePaymentHeader, decodePaymentSignature } from './paymentHeader';
import { checkRelayPins, relayPayment } from './relay';
import {
  ARC_NETWORKS,
  isLoggedSellerRejection,
  rejectSellerRequirements,
  sellerConfig,
  validateJpycRequirements,
} from './sellerPins';
import type { PaymentRequirements, UsdcFace, UsdcRail } from './types';
import { isArcPayment, paymentRequiredHeaderFor, usdcFace } from './usdcFace';

// USDC 面がないとき、Base の支払いを名乗る X-PAYMENT は JPYC の facilitator に回さない。
const BASE_NETWORKS = ['base', 'base-sepolia', 'eip155:8453', 'eip155:84532'];

export type PaymentHeaders = { paymentHeader: string | null; paymentSignatureHeader: string | null };

type JpycPurchase = { kind: 'jpyc'; payload: unknown };
type UsdcPurchase = {
  kind: 'usdc';
  face: UsdcFace;
  headers: { paymentSignatureHeader: string } | { paymentHeader: string };
  rail: UsdcRail;
  // 復号した支払い (予約の鍵を作るのに使う)。v2 は relay と同じ緩い規則で復号する。読めなければ undefined。
  payload: unknown;
};
type Purchase = JpycPurchase | UsdcPurchase;
export type PaymentChoice = { kind: 'reply'; response: Response } | Purchase;

/**
 * 支払える全 rail の決済条件を載せた 402。USDC 面があれば PAYMENT-REQUIRED も付ける
 * (USDC 面がなければ JPYC の条件だけで、ヘッダーも付かない)。
 */
export function paymentRequired(
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
  error: string,
): Response {
  return json402(usdc ? [...accepts, usdc.v1Accepts] : accepts, error, paymentRequiredHeaderFor(usdc));
}

// 支払いのヘッダーがあるときだけ呼ぶ (支払いなしの 402 と q の確認は consult が先に済ませる)。
// 空の PAYMENT-SIGNATURE も支払いで、X-PAYMENT より優先する。network は完全一致でだけ比べる。
export function choosePayment(
  { paymentHeader, paymentSignatureHeader }: PaymentHeaders,
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
): PaymentChoice {
  const reply = (error: string): PaymentChoice =>
    ({ kind: 'reply', response: paymentRequired(accepts, usdc, error) });

  if (paymentSignatureHeader !== null) {
    if (!usdc) return reply('payment_invalid');
    const rail = isArcPayment(usdc, paymentSignatureHeader) ? 'arc' : 'base';
    const payload = decodePaymentSignature(paymentSignatureHeader);
    return { kind: 'usdc', face: usdc, headers: { paymentSignatureHeader }, rail, payload };
  }

  const xPayment = paymentHeader ?? '';
  const payload = decodePaymentHeader(xPayment);
  if (payload === undefined) return reply('invalid_payment_payload');
  const isObject = typeof payload === 'object' && payload !== null;
  const network = isObject ? (payload as { network?: unknown }).network : undefined;
  if (!usdc && typeof network === 'string' && BASE_NETWORKS.includes(network)) {
    return reply('payment_invalid');
  }
  // Arc is v2 only: a v1 X-PAYMENT naming an Arc network can never be settled.
  if (typeof network === 'string' && ARC_NETWORKS.includes(network)) {
    return reply('payment_invalid');
  }
  if (usdc !== null && isObject && network === usdc.v1Accepts.network) {
    return { kind: 'usdc', face: usdc, headers: { paymentHeader: xPayment }, rail: 'base', payload };
  }
  return { kind: 'jpyc', payload };
}

// 1 つの rail の予約の鍵と verify / settle。OpenPay の応答をそのまま返す (読み分けは consult がする)。
// Response が返ったらそのまま返す (USDC の 409 → 402 requirements_mismatch)。
// throw するのは、pin や設定が合わず OpenPay に何も送らなかったときと、USDC の relay が 409 で断ったあとに
// 決済条件を取り直せなかった (取れない・pin が合わない) とき。どちらも請求はない。
type PurchaseRail = {
  name: 'jpyc' | UsdcRail;
  // この支払いの予約の鍵 (claims.ts)。
  claim: AuthorizationClaim;
  verify(): Promise<OpenPayReply | Response>;
  // verify が通ったときに、その応答を渡す (JPYC は予約の token をここで受け取る)。
  verified(reply: OpenPayReply): void;
  settle(): Promise<OpenPayReply | Response>;
  // 支払いが通らず、OpenPay が理由を返さなかったときの error。OpenPay の 2 つのリファレンスゲートに
  // 合わせて、rail ごとに文字列が違う。
  invalidFallback: 'invalid_payment' | 'payment_invalid';
  // 決済の結果 (settle の本文) を買い手に渡すヘッダー。
  receiptHeaders(receipt: Record<string, unknown>): Record<string, string>;
};

type Prepared = { kind: 'reply'; response: Response } | { kind: 'rail'; rail: PurchaseRail };

// verify の前の確かめ。OpenPay には何も送らず、予約もまだ取らない。順番に:
// 出品者の pin (合わなければ throw → 500)、出品の条件から鍵が作れるか (作れなければ throw → 500)、
// 支払いから鍵が作れるか (作れなければ 402)、JPYC は settle の本文が facilitator の上限に収まるか (収まらなければ 400)。
function prepareJpyc(
  payload: unknown,
  accept: PaymentRequirements,
  invalidPayload: () => Prepared,
): Prepared {
  validateJpycRequirements(accept, sellerConfig().expectedRecipient);
  const terms = jpycTerms(accept);
  if (!terms) rejectSellerRequirements('JPYC payment terms not claimable');
  const claim = jpycAuthorizationClaim(payload, terms);
  if (!claim) return invalidPayload();
  if (!facilitatorSettleBodyFits(payload, accept)) {
    return { kind: 'reply', response: jsonResponse(400, { error: 'q_too_long' }) };
  }

  let reservationToken: string | undefined;
  const rail: PurchaseRail = {
    name: 'jpyc',
    claim,
    verify: () => verifyPayment(payload, accept),
    verified: (reply) => {
      // token は今の facilitator ではどの結果も変えない (渡しても渡さなくても同じ)。facilitator が token を
      // 必須にしたときのために渡しておき、返らなかったことを記録する。
      const token = reservationTokenOf(reply);
      if (token.kind === 'token') reservationToken = token.token;
      else if (token.kind === 'absent') console.warn('[openpay-x402] verify ok without reservation token (jpyc)');
      else console.warn('[openpay-x402] verify returned malformed reservation token (jpyc)');
    },
    settle: () => settlePayment(payload, accept, reservationToken),
    invalidFallback: 'invalid_payment',
    receiptHeaders: (receipt) => ({ 'X-PAYMENT-RESPONSE': encodePaymentResponse(receipt) }),
  };
  return { kind: 'rail', rail };
}

function prepareUsdc(
  { face, headers, rail, payload }: UsdcPurchase,
  jpycAccepts: PaymentRequirements[],
  invalidPayload: () => Prepared,
): Prepared {
  checkRelayPins(face, rail);
  // Base の v1 の条件は network を 'base' と書くので、鍵には同じ条件の v2 (CAIP-2) を使う。
  const terms = usdcTerms(rail === 'arc' ? face.arc?.v2Accept : face.v2Accept);
  if (!terms) rejectSellerRequirements('USDC payment terms not claimable');
  const claim = usdcAuthorizationClaim(payload, terms);
  if (!claim) return invalidPayload();

  // PAYMENT-SIGNATURE で払うのは x402 v2 のクライアントで、結果は PAYMENT-RESPONSE から読む。
  const isV2 = 'paymentSignatureHeader' in headers;
  return {
    kind: 'rail',
    rail: {
      name: rail,
      claim,
      verify: () => relayPayment('verify', headers, face, jpycAccepts, rail),
      verified: () => {},
      settle: () => relayPayment('settle', headers, face, jpycAccepts, rail),
      invalidFallback: 'payment_invalid',
      receiptHeaders: (receipt) => {
        const paymentResponse = encodePaymentResponse(receipt);
        return {
          'X-PAYMENT-RESPONSE': paymentResponse,
          ...(isV2 ? { 'PAYMENT-RESPONSE': paymentResponse } : {}),
        };
      },
    },
  };
}

// 握りつぶさずに残す失敗の記録。書くのは、ここで決めた固定の言葉と rail の名前、HTTP の状態だけ。
// q・回答・支払いのヘッダー・ウォレット・URL・相手の本文・例外のメッセージは書かない。
function logFailure(what: string, rail: PurchaseRail, reply?: OpenPayReply): void {
  const status = reply === undefined ? '' : reply.status === null ? ', no response' : `, HTTP ${reply.status}`;
  console.error(`[openpay-x402] ${what} (${rail.name}${status})`);
}

// catch した例外の記録。出品や pin の不一致は sellerPins が理由を記録済みなので、それ以外のときだけ書く。
function logUnexpected(error: unknown, what: string): void {
  if (!isLoggedSellerRejection(error)) console.error(`[openpay-x402] ${what} (unexpected error)`);
}

function hasPaymentHeaders(paymentHeader: string | null, paymentSignatureHeader: string | null): boolean {
  return Boolean(paymentHeader) || paymentSignatureHeader !== null;
}

// 上流を待つ上限。期限までの残りが「これ + settle の猶予」より短い支払いは、予約の時点で断っている (claims.ts)。
export const UPSTREAM_DEADLINE_MS = MAX_UPSTREAM_SECONDS * 1000;

type Upstream =
  | { kind: 'done'; body: string }
  | { kind: 'failed' }
  /** 上限まで待っても終わらなかった。finished は、上流の呼び出しが (成功でも失敗でも) 終わったときに解決する。 */
  | { kind: 'timed_out'; finished: Promise<void> };

async function runUpstream(q: string): Promise<Upstream> {
  const work = (async () => {
    const serialized = JSON.stringify(await selectedAdapter()({ q }));
    if (serialized === undefined) throw new Error('adapter result is not JSON serializable');
    return serialized;
  })();
  const finished = work.then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), UPSTREAM_DEADLINE_MS);
  });
  try {
    const outcome = await Promise.race([
      work.then((body): Upstream => ({ kind: 'done', body }), (): Upstream => ({ kind: 'failed' })),
      deadline,
    ]);
    return outcome === 'timed_out' ? { kind: 'timed_out', finished } : outcome;
  } finally {
    clearTimeout(timer);
  }
}

// 要求が終わったときに予約をどうするか。settle を送る前に終われば外す (請求していないので、同じ支払いで出直せる)。
// settle を送ったら、結果にかかわらず残す。上流が時間切れのときは、上流の呼び出しが終わってから外す
// (先に外すと、同じ支払いで上流が同時に 2 回動きうる)。
type Retention = { then: 'release' | 'retain' | 'release_when_upstream_ends' };

// 失敗の 402 は rail によらず、支払える全 rail の決済条件で返す。
export async function consult(request: Request): Promise<Response> {
  const paymentHeader = request.headers.get('X-PAYMENT');
  const paymentSignatureHeader = request.headers.get('PAYMENT-SIGNATURE');
  // 402 ゲートと掲載値の鮮度 (5 分 / 30 分) は必ずこの 1 変数から決める。
  const hasPayment = hasPaymentHeaders(paymentHeader, paymentSignatureHeader);

  let accepts: PaymentRequirements[];
  let usdc: UsdcFace | null;
  try {
    accepts = await acceptsFor(request.url, { forPayment: hasPayment });
    usdc = await usdcFace({ forPayment: hasPayment });
  } catch (error) {
    logUnexpected(error, 'payment terms unavailable');
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

  const invalidPayload = (): Prepared =>
    ({ kind: 'reply', response: paymentRequired(accepts, usdc, 'invalid_payment_payload') });
  let prepared: Prepared;
  try {
    prepared = choice.kind === 'jpyc'
      ? prepareJpyc(choice.payload, accepts[0], invalidPayload)
      : prepareUsdc(choice, accepts, invalidPayload);
  } catch (error) {
    // pin や出品の条件が合わない。OpenPay には何も送っておらず、請求もない。
    logUnexpected(error, 'payment not checked');
    return jsonResponse(500, { error: 'payment_verification_failed' });
  }
  if (prepared.kind === 'reply') return prepared.response;
  const { rail } = prepared;

  const claimed = claimAuthorization(rail.claim);
  if (!claimed.ok) {
    if (claimed.reason === 'insufficient_validity_window') {
      console.warn(`[openpay-x402] claim refused: insufficient validity window (${rail.name})`);
      return paymentRequired(accepts, usdc, 'insufficient_validity_window');
    }
    // 402 にしない: 402 は「払い直して」の意味になる。この支払いはここで処理中か、もう settle まで進んだ。
    console.warn(`[openpay-x402] claim refused: authorization reserved (${rail.name})`);
    return jsonResponse(409, {
      error: 'authorization_reserved',
      message: 'This payment authorization is already being processed or was already used here. Do not pay again.',
    });
  }

  const retention: Retention = { then: 'release' };
  try {
    return await sell(rail, claimed.claim, retention, q, accepts, usdc);
  } finally {
    if (retention.then === 'release') releaseAuthorization(claimed.claim);
    else if (retention.then === 'retain') retainAuthorization(claimed.claim);
  }
}

// 予約を取ったあとの verify → 上流 → settle。
async function sell(
  rail: PurchaseRail,
  held: HeldClaim,
  retention: Retention,
  q: string,
  accepts: PaymentRequirements[],
  usdc: UsdcFace | null,
): Promise<Response> {
  let verifyReply: OpenPayReply | Response;
  try {
    verifyReply = await rail.verify();
  } catch (error) {
    // pin や設定が合わず OpenPay に何も送っていないか、relay が 409 で断ったあとに決済条件を取り直せなかった。
    // どちらも請求していない。
    logUnexpected(error, 'verify not sent or refused by OpenPay');
    return jsonResponse(500, { error: 'payment_verification_failed' });
  }
  if (verifyReply instanceof Response) return verifyReply;
  const verification = verifyOutcome(verifyReply);
  if (verification.kind === 'unavailable') {
    // 何も動かしていないし、請求もしていない。払い直しではなく、時間をおいた再試行を促す。
    logFailure('verify unavailable', rail, verifyReply);
    return jsonResponse(503, { error: 'payment_service_unavailable' });
  }
  if (verification.kind === 'rejected') {
    return paymentRequired(accepts, usdc, verification.reason ?? rail.invalidFallback);
  }
  // verify を待つ間に、支払いの期限までの残りが上流と settle に足りなくなっていないか。
  if (!hasValidityWindow(rail.claim)) {
    console.warn(`[openpay-x402] claim refused after verify: insufficient validity window (${rail.name})`);
    return paymentRequired(accepts, usdc, 'insufficient_validity_window');
  }
  rail.verified(verifyReply);

  const upstream = await runUpstream(q);
  if (upstream.kind === 'timed_out') {
    // Vercel がこの応答のあとでインスタンスを止めると、外すのはその再開まで遅れる (そのあいだの再送は 409)。
    // 安全な側に倒れるので、そのままにする。
    retention.then = 'release_when_upstream_ends';
    void upstream.finished.then(() => releaseAuthorization(held));
    logFailure('upstream timed out, not charged', rail);
    return jsonResponse(502, { error: 'upstream_error' });
  }
  if (upstream.kind === 'failed') {
    logFailure('upstream failed, not charged', rail);
    return jsonResponse(502, { error: 'upstream_error' });
  }

  let settleReply: OpenPayReply | Response;
  try {
    // rail.settle() は、pin が合わなければ OpenPay に何も送らずにその場で throw する (予約は外れる)。
    // 呼び出しが返ったら settle を送ったので、ここから先は結果にかかわらず予約を残す。
    const settling = rail.settle();
    retention.then = 'retain';
    settleReply = await settling;
  } catch (error) {
    // pin や設定が合わず OpenPay に何も送っていないか、relay が 409 で断ったあとに決済条件を取り直せなかった。
    // どちらも請求していない。
    logUnexpected(error, 'settle not sent or refused by OpenPay');
    return jsonResponse(500, { error: 'payment_settlement_failed' });
  }
  if (settleReply instanceof Response) return settleReply;
  const settlement = settleOutcome(settleReply);
  switch (settlement.kind) {
    case 'settled':
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...rail.receiptHeaders(settlement.receipt),
        },
      });
    case 'rejected':
      return paymentRequired(accepts, usdc, settlement.reason ?? 'settlement_failed');
    case 'pending':
      // 決済される見込みなので 402 にしない (402 は「もう一度払って」の意味になり、二重払いを招く)。
      logFailure('settle pending, content not delivered', rail, settleReply);
      return jsonResponse(
        502,
        { error: 'settlement_pending' },
        settlement.receipt ? rail.receiptHeaders(settlement.receipt) : {},
      );
    case 'unknown':
      // 決済されたかどうかが分からない。「失敗」とは言わず、払い直しも求めない。
      logFailure('settle outcome unknown, content not delivered', rail, settleReply);
      return jsonResponse(500, { error: 'settlement_unknown' });
  }
}

// HEAD は本文を返せないので、何も売らない。支払いのヘッダーがなければ GET と同じ 402 (ヘッダーだけ) を返し、
// 支払いのヘッダーがあれば OpenPay を呼ばずに 405 で断る (verify・上流・settle を動かさない)。
export async function consultHead(request: Request): Promise<Response> {
  if (hasPaymentHeaders(request.headers.get('X-PAYMENT'), request.headers.get('PAYMENT-SIGNATURE'))) {
    return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
  }
  const response = await consult(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
