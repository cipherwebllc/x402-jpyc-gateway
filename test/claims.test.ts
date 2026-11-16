// 支払いの予約 (lib/claims.ts) の単体テスト: 鍵の作り方、期限の窓、取り直しと外し方、覚えておく上限。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimAuthorization,
  hasValidityWindow,
  jpycAuthorizationClaim,
  jpycTerms,
  MAX_UPSTREAM_SECONDS,
  releaseAuthorization,
  resetClaims,
  retainAuthorization,
  SETTLEMENT_GRACE_SECONDS,
  usdcAuthorizationClaim,
  usdcTerms,
  type AuthorizationClaim,
  type JpycTerms,
} from '@/lib/claims';

import {
  arcV2Accept, catalogAccept, jpycPayment, paymentSignatureFor, usdcAccept, usdcV1Payment, v2Accept,
} from './fixtures';

const NOW = 1_800_000_000;
const WINDOW = MAX_UPSTREAM_SECONDS + SETTLEMENT_GRACE_SECONDS;
const decode = (header: string): unknown => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
const terms = jpycTerms(catalogAccept) as JpycTerms;
const baseTerms = usdcTerms(v2Accept)!;
const claimFor = (validBefore: number, key = 'k'): AuthorizationClaim => ({ key, validBefore: BigInt(validBefore) });

beforeEach(() => {
  resetClaims();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('claim keys', () => {
  it('reads the JPYC listing terms, and refuses a listing whose terms are not canonical', () => {
    expect(terms).not.toBeNull();
    const split = catalogAccept.extra.openpay;
    for (const accept of [
      { ...catalogAccept, asset: 'JPYC' },
      { ...catalogAccept, extra: { openpay: { ...split, merchantValue: '1e18' } } },
      { ...catalogAccept, extra: { openpay: { ...split, feeValue: 10 } } },
      { ...catalogAccept, extra: { openpay: { ...split, feeReceiver: undefined } } },
      { ...catalogAccept, extra: {} },
      null,
    ]) {
      expect(jpycTerms(accept)).toBeNull();
    }
  });

  it('builds one JPYC key per authorization, whatever the letter case or leading zeros', () => {
    const claim = jpycAuthorizationClaim(jpycPayment(1), terms)!;
    expect(claim.validBefore).toBe(4102444800n);
    const same = jpycPayment(1, { from: jpycPayment(1).payload.authorization.from.toUpperCase().replace('0X', '0x') });
    expect(jpycAuthorizationClaim({ ...same, network: 'eip155:0137' }, terms)!.key).toBe(claim.key);
    expect(jpycAuthorizationClaim(jpycPayment(2), terms)!.key).not.toBe(claim.key);
  });

  it('cannot build a JPYC key from a payment the facilitator would not read', () => {
    for (const payment of [
      null,
      'payment',
      { network: 'eip155:137', authorization: 'payment' },
      { ...jpycPayment(1), network: 'polygon' },
      jpycPayment(1, { intentSalt: '0x01' }),
      jpycPayment(1, { validBefore: 4102444800 }),
      jpycPayment(1, { validAfter: '-1' }),
      jpycPayment(1, { from: 'buyer' }),
    ]) {
      expect(jpycAuthorizationClaim(payment, terms)).toBeNull();
    }
  });

  it('gives the same USDC key to one nonce sent as v1 X-PAYMENT and as v2 PAYMENT-SIGNATURE', () => {
    const v1 = usdcAuthorizationClaim(usdcV1Payment(0x55), baseTerms)!;
    const v2 = usdcAuthorizationClaim(decode(paymentSignatureFor(v2Accept, 0x55)), baseTerms)!;
    expect(v2.key).toBe(v1.key);
    expect(usdcAuthorizationClaim(usdcV1Payment(0x56), baseTerms)!.key).not.toBe(v1.key);
  });

  it('keys an Arc authorization by the Arc terms, apart from the same authorization on Base', () => {
    const payment = decode(paymentSignatureFor(arcV2Accept, 0x77));
    const arc = usdcAuthorizationClaim(payment, usdcTerms(arcV2Accept)!)!;
    const base = usdcAuthorizationClaim(payment, baseTerms)!;
    expect(arc.key).not.toBe(base.key);
  });

  it('takes the USDC network from the CAIP-2 terms only (the v1 terms say "base")', () => {
    expect(usdcTerms(usdcAccept)).toBeNull();
    expect(usdcTerms(v2Accept)).toEqual({ network: 'eip155:8453', asset: v2Accept.asset.toLowerCase() });
  });

  it('cannot build a USDC key without a nonce, a payer or a decimal validBefore', () => {
    for (const payment of [
      undefined,
      { payload: {} },
      usdcV1Payment(1, { nonce: undefined }),
      usdcV1Payment(1, { nonce: '0x1234' }),
      usdcV1Payment(1, { from: undefined }),
      usdcV1Payment(1, { validBefore: 4102444800 }),
    ]) {
      expect(usdcAuthorizationClaim(payment, baseTerms)).toBeNull();
    }
  });
});

describe('claimAuthorization', () => {
  it(`needs ${WINDOW} seconds left before validBefore`, () => {
    expect(claimAuthorization(claimFor(NOW + WINDOW - 1))).toEqual({ ok: false, reason: 'insufficient_validity_window' });
    expect(claimAuthorization(claimFor(NOW + WINDOW)).ok).toBe(true);
    expect(hasValidityWindow(claimFor(NOW + WINDOW))).toBe(true);
    expect(hasValidityWindow(claimFor(NOW + WINDOW - 1))).toBe(false);
  });

  it('counts a part of a second as a whole second already gone', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 1);
    expect(claimAuthorization(claimFor(NOW + WINDOW)).ok).toBe(false);
  });

  it('refuses a second claim on the same key until it is released', () => {
    const first = claimAuthorization(claimFor(NOW + 1000));
    expect(first.ok).toBe(true);
    expect(claimAuthorization(claimFor(NOW + 1000))).toEqual({ ok: false, reason: 'authorization_reserved' });
    expect(claimAuthorization(claimFor(NOW + 1000, 'other')).ok).toBe(true);
    if (first.ok) releaseAuthorization(first.claim);
    expect(claimAuthorization(claimFor(NOW + 1000)).ok).toBe(true);
  });

  it('lets only the owner release or retain a claim', () => {
    const first = claimAuthorization(claimFor(NOW + WINDOW + 10));
    if (!first.ok) throw new Error('not claimed');
    retainAuthorization(first.claim);
    // The retained claim expires, and another request claims the same key again.
    vi.spyOn(Date, 'now').mockReturnValue((NOW + WINDOW + 10) * 1000);
    const later = claimFor(NOW + 2 * WINDOW + 10);
    expect(claimAuthorization(later).ok).toBe(true);
    releaseAuthorization(first.claim);
    retainAuthorization(first.claim);
    expect(claimAuthorization(later)).toEqual({ ok: false, reason: 'authorization_reserved' });
    // The new claim is still being processed: past its validBefore it is still held (the stale retain did not
    // give it an expiry).
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 2 * WINDOW + 10) * 1000);
    expect(claimAuthorization(claimFor(NOW + 3 * WINDOW + 10))).toEqual({ ok: false, reason: 'authorization_reserved' });
  });

  it('reports a reserved key before a short window (a replay near expiry is never asked to pay again)', () => {
    expect(claimAuthorization(claimFor(NOW + WINDOW)).ok).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 1) * 1000);
    expect(claimAuthorization(claimFor(NOW + WINDOW))).toEqual({ ok: false, reason: 'authorization_reserved' });
  });

  it('never forgets a claim still being processed, even past validBefore', () => {
    expect(claimAuthorization(claimFor(NOW + 1000)).ok).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 10 * 86_400) * 1000);
    // The same key re-signed with a later validBefore (a USDC nonce) is still reserved.
    expect(claimAuthorization(claimFor(NOW + 11 * 86_400))).toEqual({ ok: false, reason: 'authorization_reserved' });
  });

  it('forgets a retained claim at validBefore', () => {
    const first = claimAuthorization(claimFor(NOW + 1000));
    if (!first.ok) throw new Error('not claimed');
    retainAuthorization(first.claim);
    // The same key (a USDC nonce re-signed with a later validBefore) is still reserved just before…
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 1000 - 1) * 1000);
    expect(claimAuthorization(claimFor(NOW + 1000 + WINDOW))).toEqual({ ok: false, reason: 'authorization_reserved' });
    // …and free at validBefore of the claim that held it.
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 1000) * 1000);
    expect(claimAuthorization(claimFor(NOW + 1000 + WINDOW)).ok).toBe(true);
  });

  it('forgets a retained claim 8 days after it was taken, even when validBefore is later', () => {
    const farFuture = NOW + 365 * 86_400;
    const first = claimAuthorization(claimFor(farFuture));
    if (!first.ok) throw new Error('not claimed');
    retainAuthorization(first.claim);
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 8 * 86_400 - 1) * 1000);
    expect(claimAuthorization(claimFor(farFuture))).toEqual({ ok: false, reason: 'authorization_reserved' });
    vi.spyOn(Date, 'now').mockReturnValue((NOW + 8 * 86_400) * 1000);
    expect(claimAuthorization(claimFor(farFuture)).ok).toBe(true);
  });
});
