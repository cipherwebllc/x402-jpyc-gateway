import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLicenseGate,
  hasLicense,
  resolveLicense,
  LicenseError,
  LicenseRpcError,
  type LicensePublicClient,
} from 'openpay-x402-sdk';
import { keccak256, toBytes } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

import { GET as consultRoute } from '@/app/api/consult/route';
import { GET as healthRoute } from '@/app/health/route';
import { GET as challengeRoute } from '@/app/license/challenge/route';
import { POST as verifyRoute } from '@/app/license/verify/route';
import { resetAcceptsCache, resetUsdcFaceCache } from '@/lib/gate';
import { ensureLicense, payerHasLicense, resetLicenseForTests } from '@/lib/license';
import { descriptor, product } from './fixtures/license';
import { register } from '@/instrumentation';

const routeGateMock = vi.hoisted(() => ({
  ready: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  check: vi.fn(),
}));

vi.mock('openpay-x402-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openpay-x402-sdk')>();
  return {
    ...actual,
    hasLicense: vi.fn(),
    resolveLicense: vi.fn(),
    createLicenseGate: vi.fn(() => routeGateMock),
  };
});

const resource = 'https://gateway.example.com/api/consult';
const address = '0x1111111111111111111111111111111111111111';

function licenseRequest(body: unknown): Request {
  return new Request('https://gateway.example.com/license/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('openpay-x402-sdk license session', () => {
  it('completes challenge, wallet signature, verification, and synchronous check', async () => {
    const actual = await vi.importActual<typeof import('openpay-x402-sdk')>(
      'openpay-x402-sdk',
    );
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const publicClient = {
      getChainId: vi.fn().mockResolvedValue(137),
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn().mockResolvedValue(1n),
    } as unknown as LicensePublicClient;
    const gate = actual.createLicenseGate({
      chainId: 137,
      contract: '0x2222222222222222222222222222222222222222',
      tokenId: '0x01',
      publicClient,
      origin: 'https://gateway.example.com',
      session: { secret: 'test-only-session-secret-at-least-32-bytes', ttlSeconds: 300 },
    });

    const message = await gate.challenge(account.address);
    const signature = await account.signMessage({ message });
    const token = await gate.verify({ message, signature });
    const session = gate.check(token);

    expect(session.address).toBe(account.address);
    expect(session.tokenId).toBe(1n);
    expect(session.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(publicClient.getChainId).toHaveBeenCalledOnce();
    expect(publicClient.getBlockNumber).toHaveBeenCalledOnce();
    expect(publicClient.readContract).toHaveBeenCalledOnce();
  });

  it('resolves a product once and completes the real SDK session round trip', async () => {
    const actual = await vi.importActual<typeof import('openpay-x402-sdk')>('openpay-x402-sdk');
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const resolved = { ...descriptor, tokenId: keccak256(toBytes(`openpay:license:${product}`)) };
    const fetchDescriptor = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(resolved), { headers: { 'content-type': 'application/json' } }),
    );
    const publicClient = {
      getChainId: vi.fn().mockResolvedValue(137),
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn().mockResolvedValue(1n),
    } as unknown as LicensePublicClient;
    const gate = actual.createLicenseGate({
      product,
      origin: 'https://descriptor.example.com',
      fetch: fetchDescriptor,
      publicClient,
      session: {
        secret: 'test-only-session-secret-at-least-32-bytes',
        ttlSeconds: 300,
        origin: 'https://gateway.example.com',
      },
    });

    expect(() => gate.check('not-yet-ready')).toThrow(expect.objectContaining({ code: 'not_ready' }));
    const readyResults = await Promise.all([gate.ready(), gate.ready(), gate.ready()]);
    for (const result of readyResults) expect(result).toEqual(resolved);
    expect(fetchDescriptor).toHaveBeenCalledExactlyOnceWith(
      `https://descriptor.example.com/api/license/products/${product}`,
      expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }),
    );

    const message = await gate.challenge(account.address);
    expect(parseSiweMessage(message)).toMatchObject({
      domain: 'gateway.example.com',
      uri: 'https://gateway.example.com',
      chainId: 137,
      resources: [`urn:openpay:license:137:${resolved.contract}:${resolved.tokenId}`],
    });
    const signature = await account.signMessage({ message });
    const token = await gate.verify({ message, signature });
    const session = gate.check(token);
    expect(session).toEqual({
      address: account.address,
      tokenId: BigInt(resolved.tokenId),
      exp: expect.any(Number),
    });
    expect(session.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(publicClient.readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: resolved.contract,
      functionName: 'balanceOf',
      args: [account.address, BigInt(resolved.tokenId)],
      blockNumber: 1n,
    }));
    expect(publicClient.getChainId).toHaveBeenCalledOnce();
    expect(publicClient.getBlockNumber).toHaveBeenCalledExactlyOnceWith({ cacheTime: 0 });
    expect(await gate.ready()).toEqual(resolved);
    await gate.challenge(account.address);
    expect(gate.check(token)).toEqual(session);
    expect(fetchDescriptor).toHaveBeenCalledOnce();
  });

});

describe('license HTTP routes', () => {
  beforeEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
    resetLicenseForTests();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('LICENSE_PRODUCT_ID', product);
    vi.stubEnv('LICENSE_SESSION_SECRET', 'test-license-session-secret-32-bytes-minimum');
    vi.mocked(resolveLicense).mockResolvedValue(descriptor);
    vi.mocked(hasLicense).mockResolvedValue({ holder: true, balance: 1n, blockNumber: 1n });
    routeGateMock.ready.mockResolvedValue(undefined);
    vi.mocked(createLicenseGate).mockReturnValue(routeGateMock);
    routeGateMock.challenge.mockResolvedValue('challenge-message');
    routeGateMock.verify.mockResolvedValue('session-token');
    routeGateMock.check.mockReturnValue({ address, tokenId: 1n, exp: 2_000_000_000 });
  });

  afterEach(() => {
    resetAcceptsCache();
    resetUsdcFaceCache();
    resetLicenseForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('returns a no-store challenge for a valid address', async () => {
    const res = await challengeRoute(
      new Request(`https://gateway.example.com/license/challenge?address=${address}`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ message: 'challenge-message' });
    expect(routeGateMock.challenge).toHaveBeenCalledWith(address);
  });

  it('reports only public license metadata from health', async () => {
    const res = await healthRoute();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      license: {
        required: true,
        chainId: 137,
        contract: '0x2222222222222222222222222222222222222222',
        tokenId: descriptor.tokenId,
        product,
        productUrl: descriptor.productUrl,
        saleActive: true,
      },
    });
  });

  it('enumerates missing configuration at register time', async () => {
    vi.stubEnv('LICENSE_PRODUCT_ID', undefined);
    vi.stubEnv('LICENSE_SESSION_SECRET', undefined);

    await expect(register()).rejects.toThrow(
      /LICENSE_PRODUCT_ID, LICENSE_SESSION_SECRET/,
    );
  });

  it('returns invalid_address without creating a challenge', async () => {
    const res = await challengeRoute(
      new Request('https://gateway.example.com/license/challenge?address=not-an-address'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_address' });
    expect(routeGateMock.challenge).not.toHaveBeenCalled();
  });

  it('verifies a signature and returns the session cookie and public session fields', async () => {
    const res = await verifyRoute(
      licenseRequest({ message: 'challenge-message', signature: '0xabcdef' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      token: 'session-token',
      address,
      exp: 2_000_000_000,
    });
    expect(res.headers.get('set-cookie')).toBe(
      'license_session=session-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
    );
    expect(routeGateMock.verify).toHaveBeenCalledWith({
      message: 'challenge-message',
      signature: '0xabcdef',
    });
    expect(routeGateMock.check).toHaveBeenCalledWith('session-token');
  });

  it.each([
    [new LicenseError('no_license', 'test no license'), 403, 'license_required'],
    [new LicenseRpcError('test RPC unavailable'), 503, 'license_check_unavailable'],
    [new LicenseError('nonce_store_error', 'private nonce details'), 503, 'license_check_unavailable'],
    [new LicenseError('not_ready', 'private gate details'), 503, 'license_check_unavailable'],
    [new LicenseError('invalid_challenge', 'private challenge details'), 400, 'license_verification_failed'],
    [new LicenseError('challenge_expired', 'private expiry details'), 400, 'license_verification_failed'],
    [new LicenseError('invalid_nonce', 'private nonce details'), 400, 'license_verification_failed'],
    [new LicenseError('invalid_signature', 'test bad signature'), 400, 'license_verification_failed'],
  ] as const)('maps SDK verification errors to generic HTTP responses', async (error, status, code) => {
    routeGateMock.verify.mockRejectedValue(error);

    const res = await verifyRoute(
      licenseRequest({ message: 'challenge-message', signature: '0xabcdef' }),
    );

    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(code === 'license_required'
      ? { error: code, product, productUrl: descriptor.productUrl }
      : { error: code });
  });

  it.each([
    ['LICENSE_PRODUCT_ID', 'h_0123456789ABCDEF0123456789abcdef'],
    ['LICENSE_PRODUCT_ID', 'license-product'],
    ['LICENSE_PRODUCT_ID', `h_${'a'.repeat(31)}`],
    ['LICENSE_SESSION_SECRET', 'a'.repeat(31)],
    ['LICENSE_SESSION_SECRET', 'あ'.repeat(10)],
    ['LICENSE_ORIGIN', 'http://localhost'],
    ['LICENSE_ORIGIN', 'https://example.com/path'],
    ['LICENSE_ORIGIN', 'https://example.com?query=1'],
    ['LICENSE_ORIGIN', 'https://example.com#fragment'],
    ['LICENSE_ORIGIN', 'https://user:password@example.com'],
    ['POLYGON_RPC_URL', 'not-a-url'],
    ['MY_RESOURCE_URL', undefined],
    ['MY_RESOURCE_URL', 'http://remote.example.com/api/consult'],
  ])('rejects invalid %s configuration before discovery', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(register()).rejects.toThrow(name);
    expect(resolveLicense).not.toHaveBeenCalled();
    expect(createLicenseGate).not.toHaveBeenCalled();
  });

  it('uses the two required license values, default authority and gateway audience', async () => {
    vi.stubEnv('LICENSE_SESSION_SECRET', 'あ'.repeat(11));
    const license = await ensureLicense();
    expect(resolveLicense).toHaveBeenCalledExactlyOnceWith({ product, origin: 'https://open-pay.jp' });
    expect(createLicenseGate).toHaveBeenCalledExactlyOnceWith({
      chainId: descriptor.chainId,
      contract: descriptor.contract,
      tokenId: descriptor.tokenId,
      session: { secret: expect.any(String), ttlSeconds: 300, origin: 'https://gateway.example.com' },
    });
    expect(license.descriptor).toEqual(descriptor);
    expect(routeGateMock.ready).toHaveBeenCalledOnce();
  });

  it('passes optional discovery and RPC origins independently of the signing audience', async () => {
    vi.stubEnv('LICENSE_ORIGIN', 'https://descriptor.example.com/');
    vi.stubEnv('POLYGON_RPC_URL', 'https://rpc.example.com');
    const license = await ensureLicense();
    await payerHasLicense(license, address);
    expect(resolveLicense).toHaveBeenCalledExactlyOnceWith({ product, origin: 'https://descriptor.example.com' });
    expect(createLicenseGate).toHaveBeenCalledWith(expect.objectContaining({
      rpcUrl: 'https://rpc.example.com',
      session: expect.objectContaining({ origin: 'https://gateway.example.com' }),
    }));
    expect(hasLicense).toHaveBeenCalledExactlyOnceWith({
      chainId: descriptor.chainId, contract: descriptor.contract, tokenId: descriptor.tokenId,
      rpcUrl: 'https://rpc.example.com', address,
    });
  });

  it('shares concurrent initialization and waits for gate readiness before publishing', async () => {
    let finishReady!: () => void;
    routeGateMock.ready.mockReturnValue(new Promise<void>((resolve) => { finishReady = resolve; }));
    let published = false;
    const first = ensureLicense();
    const second = ensureLicense();
    expect(second).toBe(first);
    const observed = first.then(() => { published = true; });
    await vi.waitFor(() => expect(routeGateMock.ready).toHaveBeenCalledOnce());
    expect(published).toBe(false);
    finishReady();
    const [one, two] = await Promise.all([first, second]);
    await observed;
    expect(two).toBe(one);
    expect(await ensureLicense()).toBe(one);
    expect(resolveLicense).toHaveBeenCalledOnce();
    expect(createLicenseGate).toHaveBeenCalledOnce();
  });

  it('discards initialization rejected by gate.ready and permits a later retry', async () => {
    routeGateMock.ready.mockRejectedValueOnce(new LicenseError('not_ready', 'private details'));
    await expect(ensureLicense()).rejects.toMatchObject({ code: 'not_ready' });
    expect((await ensureLicense()).gate).toBe(routeGateMock);
    expect(resolveLicense).toHaveBeenCalledTimes(2);
    expect(routeGateMock.ready).toHaveBeenCalledTimes(2);
  });

  it.each(['network_error', 'http_error', 'redirect', 'invalid_response'] as const)(
    'fails startup and the route on descriptor %s, then retries successfully', async (code) => {
      const failure = new LicenseError(code, 'private descriptor URL and environment details', {
        cause: new Error('private cause'),
      });
      // Both attempts must fail; a one-shot rejection would accidentally let the route initialize.
      vi.mocked(resolveLicense).mockRejectedValue(failure);
      await expect(register()).rejects.toBe(failure);
      const failed = await consultRoute(new Request(resource));
      expect(failed.status).toBe(500);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      expect(await failed.json()).toEqual({ error: 'license_unavailable' });
      expect(resolveLicense).toHaveBeenCalledTimes(2);
      expect(createLicenseGate).not.toHaveBeenCalled();

      vi.mocked(resolveLicense).mockResolvedValue(descriptor);
      vi.stubEnv('MY_RESOURCE_ID', undefined);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        items: [{ resource, accepts: [{ scheme: 'exact', resource }] }],
      }))));
      await expect(register()).resolves.toBeUndefined();
      const recovered = await consultRoute(new Request(resource));
      expect(recovered.status).toBe(402);
      expect(recovered.headers.get('cache-control')).toBe('no-store');
      expect(resolveLicense).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['environment', 'discovery'] as const)('initializes before input parsing in all four routes (%s failure)', async (failure) => {
    if (failure === 'environment') vi.stubEnv('LICENSE_PRODUCT_ID', undefined);
    else vi.mocked(resolveLicense).mockRejectedValue(new LicenseError('network_error', 'private URL'));
    const requests = [
      () => consultRoute(new Request(resource)),
      () => healthRoute(),
      () => challengeRoute(new Request('https://gateway.example.com/license/challenge')),
      () => verifyRoute(new Request('https://gateway.example.com/license/verify', { method: 'POST', body: 'invalid JSON' })),
    ];
    for (const route of requests) {
      const res = await route();
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'license_unavailable' });
    }
    expect(routeGateMock.challenge).not.toHaveBeenCalled();
    expect(routeGateMock.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['rpc_error', 503, 'license_check_unavailable'],
    ['nonce_store_error', 503, 'license_check_unavailable'],
    ['not_ready', 503, 'license_check_unavailable'],
    ['no_license', 403, 'license_required'],
    ['invalid_challenge', 400, 'license_verification_failed'],
    ['challenge_expired', 400, 'license_verification_failed'],
    ['invalid_signature', 400, 'license_verification_failed'],
    ['invalid_nonce', 400, 'license_verification_failed'],
  ] as const)('maps challenge SDK %s to a fixed response', async (code, status, expectedError) => {
    routeGateMock.challenge.mockRejectedValue(code === 'rpc_error'
      ? new LicenseRpcError('private RPC URL') : new LicenseError(code, 'private details'));
    const res = await challengeRoute(new Request(`https://gateway.example.com/license/challenge?address=${address}`));
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(expectedError === 'license_required'
      ? { error: expectedError, product, productUrl: descriptor.productUrl }
      : { error: expectedError });
  });

  it('refreshes metadata after five minutes while retaining the gate, nonce store and ownership cache', async () => {
    vi.useFakeTimers();
    const original = await ensureLicense();
    vi.advanceTimersByTime(299_999);
    expect(await ensureLicense()).toBe(original);
    await payerHasLicense(original, address);
    const updated = { ...descriptor, saleActive: false, registered: false, remaining: 0,
      productUrl: `https://open-pay.jp/@updated?product=${product}` };
    vi.mocked(resolveLicense).mockResolvedValue(updated);
    vi.advanceTimersByTime(1);
    const first = ensureLicense();
    const second = ensureLicense();
    expect(second).toBe(first);
    const refreshed = await first;
    expect(refreshed.descriptor).toEqual(updated);
    expect(refreshed.gate).toBe(original.gate);
    expect(refreshed.resolvedAt - original.resolvedAt).toBe(300_000);
    expect(original.descriptor).toEqual(descriptor);
    await payerHasLicense(refreshed, address);
    expect(hasLicense).toHaveBeenCalledOnce();
    expect(resolveLicense).toHaveBeenCalledTimes(2);
    expect(createLicenseGate).toHaveBeenCalledOnce();
    expect(routeGateMock.ready).toHaveBeenCalledOnce();
    const health = await healthRoute();
    expect(await health.json()).toMatchObject({ license: { saleActive: false, productUrl: updated.productUrl } });
  });

  it.each(['contract', 'chainId'] as const)('atomically replaces a changed %s identity and clears ownership cache', async (field) => {
    vi.useFakeTimers();
    const original = await ensureLicense();
    vi.advanceTimersByTime(299_999);
    await payerHasLicense(original, address);
    const updated = { ...descriptor, ...(field === 'contract'
      ? { contract: '0x3333333333333333333333333333333333333333' as const }
      : { chainId: 80002 as const }) };
    vi.mocked(resolveLicense).mockResolvedValue(updated);
    const newGate = { ...routeGateMock, ready: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createLicenseGate).mockReturnValue(newGate);
    vi.advanceTimersByTime(1);
    const results = await Promise.all([ensureLicense(), ensureLicense()]);
    expect(results[0]).toBe(results[1]);
    const refreshed = results[0];
    expect(refreshed.gate).toBe(newGate);
    expect(refreshed.descriptor).toEqual(updated);
    expect(original.descriptor).toEqual(descriptor);
    await payerHasLicense(refreshed, address);
    // Revisiting the old captured identity must also miss: its still-fresh cache was cleared.
    await payerHasLicense(original, address);
    expect(hasLicense).toHaveBeenCalledTimes(3);
    expect(hasLicense).toHaveBeenNthCalledWith(2, {
      address, chainId: updated.chainId, contract: updated.contract, tokenId: updated.tokenId,
    });
    expect(resolveLicense).toHaveBeenCalledTimes(2);
    expect(createLicenseGate).toHaveBeenCalledTimes(2);
    expect(newGate.ready).toHaveBeenCalledOnce();
  });

  it('retains last-known-good state on refresh failure and retries only after 30 seconds', async () => {
    vi.useFakeTimers();
    const original = await ensureLicense();
    vi.advanceTimersByTime(300_000);
    vi.mocked(resolveLicense).mockRejectedValue(new LicenseError('network_error', 'private details'));
    const first = ensureLicense();
    expect(ensureLicense()).toBe(first);
    expect(await first).toBe(original);
    vi.advanceTimersByTime(29_999);
    expect(await ensureLicense()).toBe(original);
    expect(resolveLicense).toHaveBeenCalledTimes(2);
    vi.mocked(resolveLicense).mockResolvedValue({ ...descriptor, saleActive: false });
    vi.advanceTimersByTime(1);
    const recovered = await ensureLicense();
    expect(recovered.descriptor.saleActive).toBe(false);
    expect(recovered.gate).toBe(original.gate);
    expect(resolveLicense).toHaveBeenCalledTimes(3);
  });

  it('keeps the old runtime and ownership cache when a replacement gate cannot become ready', async () => {
    vi.useFakeTimers();
    const original = await ensureLicense();
    vi.advanceTimersByTime(299_999);
    await payerHasLicense(original, address);
    vi.mocked(resolveLicense).mockResolvedValue({
      ...descriptor, contract: '0x3333333333333333333333333333333333333333',
    });
    vi.mocked(createLicenseGate).mockReturnValue({
      ...routeGateMock, ready: vi.fn().mockRejectedValue(new LicenseError('not_ready', 'private details')),
    });
    vi.advanceTimersByTime(1);
    expect(await ensureLicense()).toBe(original);
    expect(await ensureLicense()).toBe(original);
    await payerHasLicense(original, address);
    expect(hasLicense).toHaveBeenCalledOnce();
    expect(resolveLicense).toHaveBeenCalledTimes(2);
  });

  it('shares ownership cache entries across address casing', async () => {
    const license = await ensureLicense();
    await payerHasLicense(license, `0x${'ab'.repeat(20)}`);
    await payerHasLicense(license, `0x${'AB'.repeat(20)}`);
    expect(hasLicense).toHaveBeenCalledOnce();
  });

});
