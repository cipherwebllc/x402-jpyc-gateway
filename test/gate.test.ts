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

  describe('unpaid (probe) cache tier', () => {
    const T0 = 1_000_000;
    const MIN = 60_000;
    const listingFetch = () => vi.fn().mockImplementation(async () => response(listing));

    it('reuses a validated listing for unpaid requests until 30 minutes and refetches at 30 minutes', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = listingFetch();
      vi.stubGlobal('fetch', fetchMock);
      await acceptsFor(resource, { forPayment: false });
      now.mockReturnValue(T0 + 30 * MIN - 1);
      await acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      now.mockReturnValue(T0 + 30 * MIN);
      await acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not extend the listing age on unpaid hits, so a later payment still refetches', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = listingFetch();
      vi.stubGlobal('fetch', fetchMock);
      await acceptsFor(resource, { forPayment: false });
      now.mockReturnValue(T0 + 29 * MIN);
      await acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await acceptsFor(resource, { forPayment: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats omitted options as a payment (5-minute tier)', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = listingFetch();
      vi.stubGlobal('fetch', fetchMock);
      await acceptsFor(resource, { forPayment: false });
      now.mockReturnValue(T0 + 5 * MIN);
      await acceptsFor(resource);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('revalidates the seller pins on every unpaid cache hit', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = listingFetch();
      vi.stubGlobal('fetch', fetchMock);
      await acceptsFor(resource, { forPayment: false });
      now.mockReturnValue(T0 + 10 * MIN);
      vi.stubEnv('EXPECTED_RECIPIENT', attacker);
      await expect(acceptsFor(resource, { forPayment: false })).rejects.toThrow('JPYC recipient mismatch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not cache a listing that fails validation', async () => {
      const poisoned = {
        ...listing,
        accepts: [{ ...catalogAccept, extra: { openpay: { ...catalogAccept.extra.openpay, merchant: attacker } } }],
      };
      const bodies: unknown[] = [poisoned, listing, listing];
      const fetchMock = vi.fn().mockImplementation(async () => response(bodies.shift()));
      vi.stubGlobal('fetch', fetchMock);
      await expect(acceptsFor(resource, { forPayment: false })).rejects.toThrow('JPYC recipient mismatch');
      await expect(acceptsFor(resource, { forPayment: false })).resolves.toEqual([catalogAccept]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent discovery fetches', () => {
    const T0 = 1_000_000;
    const MIN = 60_000;
    const repriced = {
      ...listing,
      accepts: [{ ...catalogAccept, maxAmountRequired: '2010000000000000000' }],
    };

    function deferredFetch() {
      const pending: Array<(res: Response) => void> = [];
      const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, pending };
    }

    it('does not let an older success reinstall a listing that a newer fetch found deleted (404)', async () => {
      const { fetchMock, pending } = deferredFetch();
      const older = acceptsFor(resource, { forPayment: false });
      const newer = acceptsFor(resource, { forPayment: false });
      expect(pending).toHaveLength(2);

      pending[1](response({ error: 'not_found' }, 404));
      await expect(newer).rejects.toThrow('HTTP 404');
      pending[0](response(listing));
      await expect(older).rejects.toThrow('superseded');

      const next = acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      pending[2](response(listing));
      await expect(next).resolves.toEqual([catalogAccept]);
    });

    it('does not let an older 404 erase a listing that a newer fetch already cached', async () => {
      const { fetchMock, pending } = deferredFetch();
      const older = acceptsFor(resource, { forPayment: false });
      const newer = acceptsFor(resource, { forPayment: false });

      pending[1](response(listing));
      await expect(newer).resolves.toEqual([catalogAccept]);
      pending[0](response({ error: 'not_found' }, 404));
      await expect(older).rejects.toThrow('HTTP 404');

      await expect(acceptsFor(resource, { forPayment: false })).resolves.toEqual([catalogAccept]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not let a slow older response overwrite newer terms', async () => {
      const { fetchMock, pending } = deferredFetch();
      const older = acceptsFor(resource);
      const newer = acceptsFor(resource);

      pending[1](response(repriced));
      await expect(newer).resolves.toEqual(repriced.accepts);
      pending[0](response(listing));
      await expect(older).resolves.toEqual(repriced.accepts);

      await expect(acceptsFor(resource)).resolves.toEqual(repriced.accepts);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a poisoned older listing even when a newer valid listing is already cached', async () => {
      const { pending } = deferredFetch();
      const older = acceptsFor(resource);
      const newer = acceptsFor(resource);
      pending[1](response(listing));
      await expect(newer).resolves.toEqual([catalogAccept]);
      pending[0](response({
        ...listing,
        accepts: [{ ...catalogAccept, extra: { openpay: { ...catalogAccept.extra.openpay, merchant: attacker } } }],
      }));
      await expect(older).rejects.toThrow('JPYC recipient mismatch');
    });

    it('measures the listing age from the start of the fetch', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { fetchMock, pending } = deferredFetch();
      const first = acceptsFor(resource);
      now.mockReturnValue(T0 + 4 * MIN);
      pending[0](response(listing));
      await first;

      now.mockReturnValue(T0 + 5 * MIN);
      const paid = acceptsFor(resource);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1](response(listing));
      await paid;
    });

    it('rejects and does not cache a response that arrives after the payment age limit', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { fetchMock, pending } = deferredFetch();
      const slow = acceptsFor(resource);
      now.mockReturnValue(T0 + 5 * MIN);
      pending[0](response(listing));
      await expect(slow).rejects.toThrow('too old');

      const probe = acceptsFor(resource, { forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1](response(listing));
      await expect(probe).resolves.toEqual([catalogAccept]);
    });
  });

  describe('USDC face cache tiers', () => {
    const T0 = 1_000_000;
    const MIN = 60_000;
    const faceFetch = () => vi.fn().mockImplementation(async () => response(validUsdcFace));
    const poisonedFace = {
      ...validUsdcFace,
      v1Accepts: { ...validUsdcFace.v1Accepts, payTo: attacker },
    };

    function deferredFetch() {
      const pending: Array<(res: Response) => void> = [];
      const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, pending };
    }

    it('reuses the face for unpaid requests until 30 minutes and refetches at 30 minutes', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = faceFetch();
      vi.stubGlobal('fetch', fetchMock);
      await usdcFace({ forPayment: false });
      now.mockReturnValue(T0 + 30 * MIN - 1);
      await usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      now.mockReturnValue(T0 + 30 * MIN);
      await usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not extend the face age on unpaid hits, so a later payment still refetches', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = faceFetch();
      vi.stubGlobal('fetch', fetchMock);
      await usdcFace({ forPayment: false });
      now.mockReturnValue(T0 + 29 * MIN);
      await usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await usdcFace({ forPayment: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats omitted options as a payment (5-minute tier)', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const fetchMock = faceFetch();
      vi.stubGlobal('fetch', fetchMock);
      await usdcFace({ forPayment: false });
      now.mockReturnValue(T0 + 5 * MIN - 1);
      await usdcFace();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      now.mockReturnValue(T0 + 5 * MIN);
      await usdcFace();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache an unavailable or invalid face', async () => {
      const bodies: Array<[unknown, number]> = [[{ error: 'relay_unconfigured' }, 503], [poisonedFace, 200], [validUsdcFace, 200]];
      const fetchMock = vi.fn().mockImplementation(async () => response(...bodies.shift()!));
      vi.stubGlobal('fetch', fetchMock);
      await expect(usdcFace({ forPayment: false })).resolves.toBeNull();
      await expect(usdcFace({ forPayment: false })).rejects.toThrow('USDC recipient mismatch');
      await expect(usdcFace({ forPayment: false })).resolves.toEqual(validUsdcFace);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not let an older success reinstall a face that a newer fetch found gone (404)', async () => {
      const { fetchMock, pending } = deferredFetch();
      const older = usdcFace({ forPayment: false });
      const newer = usdcFace({ forPayment: false });
      expect(pending).toHaveLength(2);

      pending[1](response({ error: 'resource_not_found' }, 404));
      await expect(newer).resolves.toBeNull();
      pending[0](response(validUsdcFace));
      await expect(older).resolves.toBeNull();

      const next = usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      pending[2](response({ error: 'resource_not_found' }, 404));
      await expect(next).resolves.toBeNull();
    });

    it('does not let an older 404 erase a face that a newer fetch already cached', async () => {
      const { fetchMock, pending } = deferredFetch();
      const older = usdcFace({ forPayment: false });
      const newer = usdcFace({ forPayment: false });

      pending[1](response(validUsdcFace));
      await expect(newer).resolves.toEqual(validUsdcFace);
      pending[0](response({ error: 'resource_not_found' }, 404));
      await expect(older).resolves.toBeNull();

      await expect(usdcFace({ forPayment: false })).resolves.toEqual(validUsdcFace);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not let a slow older response overwrite newer terms', async () => {
      const repriced = {
        ...validUsdcFace,
        v1Accepts: { ...validUsdcFace.v1Accepts, maxAmountRequired: '2000000' },
        v2Accept: { ...validUsdcFace.v2Accept, amount: '2000000' },
        paymentRequiredHeader: Buffer.from(JSON.stringify({
          x402Version: 2, resource: { url: resource }, accepts: [{ ...v2Accept, amount: '2000000' }],
        })).toString('base64'),
      };
      const { fetchMock, pending } = deferredFetch();
      const older = usdcFace();
      const newer = usdcFace();

      pending[1](response(repriced));
      await expect(newer).resolves.toEqual(repriced);
      pending[0](response(validUsdcFace));
      await expect(older).resolves.toEqual(repriced);

      await expect(usdcFace()).resolves.toEqual(repriced);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('measures the face age from the start of the fetch', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { fetchMock, pending } = deferredFetch();
      const first = usdcFace();
      now.mockReturnValue(T0 + 4 * MIN);
      pending[0](response(validUsdcFace));
      await first;

      now.mockReturnValue(T0 + 5 * MIN);
      const paid = usdcFace();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1](response(validUsdcFace));
      await paid;
    });

    it('returns null and does not cache a face that arrives after the payment age limit', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { fetchMock, pending } = deferredFetch();
      const slow = usdcFace();
      now.mockReturnValue(T0 + 5 * MIN);
      pending[0](response(validUsdcFace));
      await expect(slow).resolves.toBeNull();

      const probe = usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending[1](response(validUsdcFace));
      await expect(probe).resolves.toEqual(validUsdcFace);
    });

    it('lets an older 404 clear the face when the newer fetch ends without a definitive answer (503)', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { fetchMock, pending } = deferredFetch();
      const seed = usdcFace({ forPayment: false });
      pending[0](response(validUsdcFace));
      await seed;

      now.mockReturnValue(T0 + 10 * MIN);
      const older = usdcFace();
      const newer = usdcFace();
      pending[2](response({ error: 'relay_unconfigured' }, 503));
      await expect(newer).resolves.toBeNull();
      pending[1](response({ error: 'resource_not_found' }, 404));
      await expect(older).resolves.toBeNull();

      const probe = usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      pending[3](response({ error: 'resource_not_found' }, 404));
      await expect(probe).resolves.toBeNull();
    });

    it('refuses a poisoned older response even when a newer valid face is already cached', async () => {
      const { pending } = deferredFetch();
      const older = usdcFace();
      const newer = usdcFace();
      pending[1](response(validUsdcFace));
      await expect(newer).resolves.toEqual(validUsdcFace);
      pending[0](response(poisonedFace));
      await expect(older).rejects.toThrow('USDC recipient mismatch');
    });

    it('still refuses a poisoned face that arrives after the age limit', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { pending } = deferredFetch();
      const slow = usdcFace();
      now.mockReturnValue(T0 + 5 * MIN);
      pending[0](response(poisonedFace));
      await expect(slow).rejects.toThrow('USDC recipient mismatch');
    });

    it('invalidates in-flight fetches on reset, as the relay 409 path does', async () => {
      const { fetchMock, pending } = deferredFetch();
      const inFlight = usdcFace({ forPayment: false });
      resetUsdcFaceCache();
      const refetch = usdcFace({ forPayment: true });
      pending[1](response({ error: 'relay_unconfigured' }, 503));
      await expect(refetch).resolves.toBeNull();
      pending[0](response(validUsdcFace));
      await expect(inFlight).resolves.toBeNull();

      const probe = usdcFace({ forPayment: false });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      pending[2](response(validUsdcFace));
      await expect(probe).resolves.toEqual(validUsdcFace);
    });
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
