import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';
import {
  acceptsFor, resetAcceptsCache, resetUsdcFaceCache, usdcFace,
  verifyPayment, settlePayment, relayPayment,
} from '@/lib/gate';
import {
  OPENPAY, resource, resourceId, merchant, usdcMerchant, attacker, listing, catalogAccept,
  usdcFace as validUsdcFace, v2Accept, response, paymentPayload,
} from './fixtures';

beforeEach(() => {
  resetAcceptsCache();
  resetUsdcFaceCache();
  vi.stubEnv('MY_RESOURCE_ID', resourceId);
  vi.stubEnv('MY_RESOURCE_URL', resource);
  vi.stubEnv('EXPECTED_RECIPIENT', merchant);
  vi.stubEnv('EXPECTED_USDC_RECIPIENT', usdcMerchant);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('seller configuration', () => {
  it.each(['MY_RESOURCE_ID', 'EXPECTED_RECIPIENT', 'MY_RESOURCE_URL'])('rejects missing %s at startup and before fetching', async (name) => {
    vi.stubEnv(name, undefined);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(register()).rejects.toThrow(`${name} is required`);
    await expect(acceptsFor(resource)).rejects.toThrow(`${name} is required`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['MY_RESOURCE_ID', ''], ['MY_RESOURCE_ID', '   '],
    ['EXPECTED_RECIPIENT', ''], ['EXPECTED_RECIPIENT', '0xmerchant'],
  ])('rejects invalid %s (%s)', async (name, value) => {
    vi.stubEnv(name, value);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await expect(register()).rejects.toThrow(`${name} is required`);
  });

  it.each([undefined, ''])('allows JPYC-only startup with USDC pin %s and never fetches its face', async (value) => {
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', value);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(register()).resolves.toBeUndefined();
    await expect(usdcFace()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['0xnot-an-address', '   '])('rejects a configured invalid USDC pin (%s)', async (value) => {
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', value);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await expect(register()).rejects.toThrow('EXPECTED_USDC_RECIPIENT must be a seller wallet address');
  });

  it.each([' resource-id', 'resource-id ', '\tresource-id\n'])('rejects surrounding ID whitespace (%s) before fetching', async (value) => {
    vi.stubEnv('MY_RESOURCE_ID', value);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(acceptsFor(resource)).rejects.toThrow('MY_RESOURCE_ID must not contain surrounding whitespace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports all configuration problems together without including their values', async () => {
    vi.stubEnv('MY_RESOURCE_ID', undefined);
    vi.stubEnv('EXPECTED_RECIPIENT', undefined);
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', 'invalid-private-setting');
    vi.stubEnv('MY_RESOURCE_URL', undefined);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await expect(register()).rejects.toThrow(
      'MY_RESOURCE_ID is required from your own OpenPay listing; ' +
      'EXPECTED_RECIPIENT is required and must be a seller wallet address from your own config; ' +
      'EXPECTED_USDC_RECIPIENT must be a seller wallet address from your own config; ' +
      'MY_RESOURCE_URL is required',
    );
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).not.toContain('invalid-private-setting');
  });

  it.each(['EXPECTED_RECIPIENT', 'EXPECTED_USDC_RECIPIENT'])('rejects zero and known burn addresses for %s', async (name) => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    for (const value of [
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
      '0xDeaD000000000000000000000000000000000000',
    ]) {
      vi.stubEnv(name, value);
      await expect(register()).rejects.toThrow(`${name} must not be the zero address or a known burn address`);
    }
  });

  it('starts with valid seller-owned pins without making a discovery request', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(register()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pinned discovery', () => {
  it.each([
    ['wrong ID', { ...listing, id: 'another-id' }, 'resource identity mismatch'],
    ['wrong URL', { ...listing, resource: `${resource}/other` }, 'resource identity mismatch'],
    ['missing accepts', { id: resourceId, resource }, 'resource has no payment requirements'],
    ['empty accepts', { ...listing, accepts: [] }, 'resource has no payment requirements'],
    ['missing extra', { ...listing, accepts: [{ ...catalogAccept, extra: undefined }] }, 'JPYC recipient mismatch'],
    ['missing merchant with valid forwarder split', { ...listing, accepts: [{ ...catalogAccept, extra: { openpay: { ...catalogAccept.extra.openpay, merchant: undefined } } }] }, 'JPYC recipient mismatch'],
    ['second recipient', { ...listing, accepts: [catalogAccept, { ...catalogAccept, extra: { openpay: { ...catalogAccept.extra.openpay, merchant: attacker } } }] }, 'JPYC recipient mismatch'],
    ['payTo differs from forwarder', { ...listing, accepts: [{ ...catalogAccept, payTo: attacker }] }, 'JPYC forwarder mismatch'],
    ['invalid forwarder', { ...listing, accepts: [{ ...catalogAccept, payTo: 'invalid', extra: { openpay: { ...catalogAccept.extra.openpay, forwarder: 'invalid' } } }] }, 'JPYC forwarder mismatch'],
    ['wrong split mode', { ...listing, accepts: [{ ...catalogAccept, extra: { openpay: { ...catalogAccept.extra.openpay, mode: 'direct' } } }] }, 'JPYC forwarder mismatch'],
  ])('rejects %s and never caches it', async (_label, value, error) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(value)).mockResolvedValueOnce(response(listing));
    vi.stubGlobal('fetch', fetchMock);

    await expect(acceptsFor(resource)).rejects.toThrow(error);
    expect(console.error).toHaveBeenCalledWith(`[openpay-x402] ${error}`);
    await expect(acceptsFor(resource)).resolves.toEqual([catalogAccept]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs invalid discovery JSON without response data and never caches it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('private-invalid-response', { status: 200 }))
      .mockResolvedValueOnce(response(listing));
    vi.stubGlobal('fetch', fetchMock);
    await expect(acceptsFor(resource)).rejects.toThrow('invalid discovery response');
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[openpay-x402] invalid discovery response');
    await expect(acceptsFor(resource)).resolves.toEqual([catalogAccept]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, 'OpenPay listing not found or not public (HTTP 404)'],
    [500, 'OpenPay temporarily unavailable (HTTP 500)'],
    [503, 'OpenPay temporarily unavailable (HTTP 503)'],
    [429, 'OpenPay discovery request failed (HTTP 429)'],
  ])('distinguishes HTTP %s and does not cache failure', async (status, message) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, status)).mockResolvedValueOnce(response(listing));
    vi.stubGlobal('fetch', fetchMock);
    await expect(acceptsFor(resource)).rejects.toThrow(message);
    await expect(acceptsFor(resource)).resolves.toEqual([catalogAccept]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('encodes the ID as one path segment without URL fallback', async () => {
    vi.stubEnv('MY_RESOURCE_ID', 'seller/id?query#fragment');
    const fetchMock = vi.fn().mockResolvedValue(response({ ...listing, id: 'seller/id?query#fragment' }));
    vi.stubGlobal('fetch', fetchMock);
    await acceptsFor(resource);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${OPENPAY}/api/discovery/seller%2Fid%3Fquery%23fragment`, { cache: 'no-store' });
  });

  it('caches validated requirements for five minutes and revalidates after expiry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = vi.fn().mockImplementation(async () => response(listing));
    vi.stubGlobal('fetch', fetchMock);
    await acceptsFor(resource);
    now.mockReturnValue(1_299_999);
    await acceptsFor(resource);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_300_000);
    await acceptsFor(resource);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cannot reuse cached requirements after the configured recipient changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(listing));
    vi.stubGlobal('fetch', fetchMock);
    await acceptsFor(resource);
    vi.stubEnv('EXPECTED_RECIPIENT', attacker);
    await expect(acceptsFor(resource)).rejects.toThrow('JPYC recipient mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('compares wallet addresses case-insensitively', async () => {
    vi.stubEnv('EXPECTED_RECIPIENT', `0x${merchant.slice(2).toUpperCase()}`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(listing)));
    await expect(acceptsFor(resource)).resolves.toEqual([catalogAccept]);
  });
});

describe('facilitator boundary', () => {
  it.each([
    ['verify', verifyPayment], ['settle', settlePayment],
  ] as const)('refuses a substituted merchant immediately before %s without calling the facilitator', (_label, pay) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ isValid: true, success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const poisoned = {
      ...catalogAccept,
      extra: { openpay: { ...catalogAccept.extra.openpay, merchant: attacker } },
    };
    expect(() => pay(paymentPayload, poisoned)).toThrow('JPYC recipient mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('USDC trust validation', () => {
  const header = (accepts: unknown[]) => Buffer.from(JSON.stringify({ accepts })).toString('base64');
  it.each([
    ['resource identity', { ...validUsdcFace, resourceId: 'another-id' }, 'USDC resource identity mismatch'],
    ['v1 recipient', { ...validUsdcFace, v1Accepts: { ...validUsdcFace.v1Accepts, payTo: attacker } }, 'USDC recipient mismatch'],
    ['v2 recipient', { ...validUsdcFace, v2Accept: { ...v2Accept, payTo: attacker } }, 'USDC recipient mismatch'],
    ['header recipient', { ...validUsdcFace, paymentRequiredHeader: header([v2Accept, { ...v2Accept, payTo: attacker }]) }, 'USDC recipient mismatch'],
    ['missing v2', { ...validUsdcFace, v2Accept: undefined }, 'USDC recipient mismatch'],
    ['malformed header', { ...validUsdcFace, paymentRequiredHeader: 'not-base64-json' }, 'invalid USDC payment requirements header'],
    ['invalid base64 character', { ...validUsdcFace, paymentRequiredHeader: `!${validUsdcFace.paymentRequiredHeader}` }, 'invalid USDC payment requirements header'],
    ['base64 whitespace', { ...validUsdcFace, paymentRequiredHeader: `${validUsdcFace.paymentRequiredHeader}\n` }, 'invalid USDC payment requirements header'],
    ['empty header accepts', { ...validUsdcFace, paymentRequiredHeader: header([]) }, 'USDC header has no payment requirements'],
    ['v1 network', { ...validUsdcFace, v1Accepts: { ...validUsdcFace.v1Accepts, network: 'unknown' } }, 'USDC requirements mismatch'],
    ['v2 network', { ...validUsdcFace, v2Accept: { ...v2Accept, network: 'eip155:137' } }, 'USDC requirements mismatch'],
    ['v2 asset', { ...validUsdcFace, v2Accept: { ...v2Accept, asset: attacker } }, 'USDC requirements mismatch'],
    ['v2 scheme', { ...validUsdcFace, v2Accept: { ...v2Accept, scheme: 'other' } }, 'USDC requirements mismatch'],
    ['v2 amount', { ...validUsdcFace, v2Accept: { ...v2Accept, amount: '1' } }, 'USDC requirements mismatch'],
    ['header network', { ...validUsdcFace, paymentRequiredHeader: header([{ ...v2Accept, network: 'eip155:137' }]) }, 'USDC requirements mismatch'],
    ['header asset', { ...validUsdcFace, paymentRequiredHeader: header([{ ...v2Accept, asset: attacker }]) }, 'USDC requirements mismatch'],
    ['header amount', { ...validUsdcFace, paymentRequiredHeader: header([{ ...v2Accept, amount: '1' }]) }, 'USDC requirements mismatch'],
  ])('rejects %s outside availability fallback and never caches it', async (_label, value, error) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(value)).mockResolvedValueOnce(response(validUsdcFace));
    vi.stubGlobal('fetch', fetchMock);
    await expect(usdcFace()).rejects.toThrow(error);
    expect(console.error).toHaveBeenCalledWith(`[openpay-x402] ${error}`);
    await expect(usdcFace()).resolves.toEqual(validUsdcFace);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cannot reuse a cached face after the configured recipient changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(validUsdcFace));
    vi.stubGlobal('fetch', fetchMock);
    await usdcFace();
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', attacker);
    await expect(usdcFace()).rejects.toThrow('USDC recipient mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not offer a cached USDC face or relay a payment after USDC is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(validUsdcFace));
    vi.stubGlobal('fetch', fetchMock);
    await usdcFace();
    vi.stubEnv('EXPECTED_USDC_RECIPIENT', undefined);
    await expect(usdcFace()).resolves.toBeNull();
    for (const path of ['verify', 'settle'] as const) {
      expect(() => relayPayment(path, { paymentSignatureHeader: 'signature' }, validUsdcFace, [catalogAccept]))
        .toThrow('USDC rail is disabled');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
