import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLicenseGate,
  LicenseError,
  LicenseRpcError,
  type LicensePublicClient,
} from 'openpay-x402-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import { GET as healthRoute } from '@/app/health/route';
import { GET as challengeRoute } from '@/app/license/challenge/route';
import { POST as verifyRoute } from '@/app/license/verify/route';
import { resetLicenseForTests } from '@/lib/license';
import { register } from '@/instrumentation';

const routeGateMock = vi.hoisted(() => ({
  challenge: vi.fn(),
  verify: vi.fn(),
  check: vi.fn(),
}));

vi.mock('openpay-x402-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openpay-x402-sdk')>();
  return {
    ...actual,
    hasLicense: vi.fn(),
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
});

describe('license HTTP routes', () => {
  beforeEach(() => {
    resetLicenseForTests();
    vi.stubEnv('MY_RESOURCE_URL', resource);
    vi.stubEnv('LICENSE_CHAIN_ID', '137');
    vi.stubEnv('LICENSE_CONTRACT', '0x2222222222222222222222222222222222222222');
    vi.stubEnv('LICENSE_TOKEN_ID', '0x01');
    vi.stubEnv('LICENSE_PRODUCT_ID', 'license-product');
    vi.stubEnv('LICENSE_PRODUCT_URL', 'https://open-pay.jp/products/license-product');
    vi.stubEnv('LICENSE_SESSION_SECRET', 'test-license-session-secret-32-bytes-minimum');
    vi.stubEnv('POLYGON_RPC_URL', 'https://polygon-rpc.example');
    vi.mocked(createLicenseGate).mockReturnValue(routeGateMock);
    routeGateMock.challenge.mockResolvedValue('challenge-message');
    routeGateMock.verify.mockResolvedValue('session-token');
    routeGateMock.check.mockReturnValue({ address, tokenId: 1n, exp: 2_000_000_000 });
  });

  afterEach(() => {
    resetLicenseForTests();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
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
        tokenId: '0x01',
        productId: 'license-product',
        product: 'https://open-pay.jp/products/license-product',
      },
    });
  });

  it('enumerates missing configuration at register time', async () => {
    vi.stubEnv('LICENSE_CHAIN_ID', undefined);
    vi.stubEnv('LICENSE_CONTRACT', undefined);

    await expect(register()).rejects.toThrow(
      /LICENSE_CHAIN_ID, LICENSE_CONTRACT/,
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
    [new LicenseError('invalid_signature', 'test bad signature'), 400, 'license_verification_failed'],
  ] as const)('maps SDK verification errors to generic HTTP responses', async (error, status, code) => {
    routeGateMock.verify.mockRejectedValue(error);

    const res = await verifyRoute(
      licenseRequest({ message: 'challenge-message', signature: '0xabcdef' }),
    );

    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: code });
  });
});
