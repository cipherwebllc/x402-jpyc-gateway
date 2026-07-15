import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createActor: vi.fn(),
  AnonymousIdentity: vi.fn(),
  generateIdentity: vi.fn(),
  candidFunc: vi.fn(),
  candidService: vi.fn(),
}));

vi.mock('@icp-sdk/core/agent', () => ({
  Actor: { createActor: mocks.createActor },
  AnonymousIdentity: mocks.AnonymousIdentity,
  HttpAgent: { create: mocks.createAgent },
}));

vi.mock('@icp-sdk/core/candid', () => ({
  IDL: {
    Func: mocks.candidFunc,
    Service: mocks.candidService,
    Text: 'text',
  },
}));

vi.mock('@icp-sdk/core/identity', () => ({
  Ed25519KeyIdentity: { generate: mocks.generateIdentity },
}));

import { cooIcpAdapter } from '@/lib/adapters/coo-icp';

describe('cooIcpAdapter', () => {
  const anonymousIdentity = { kind: 'anonymous' };
  const agent = { kind: 'agent' };
  const chat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.AnonymousIdentity.mockImplementation(
      class {
        constructor() {
          return anonymousIdentity;
        }
      } as unknown as () => unknown,
    );
    mocks.createAgent.mockResolvedValue(agent);
    mocks.createActor.mockReturnValue({ chat });
    chat.mockResolvedValue('IC answer');
    vi.stubEnv('COO_CANISTER_ID', 'aaaaa-aa');
    vi.stubEnv('IC_HOST', 'https://ic.example');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses an anonymous identity by default and maps q through chat', async () => {
    await expect(cooIcpAdapter({ q: 'hello' })).resolves.toEqual({ answer: 'IC answer' });

    expect(mocks.AnonymousIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.generateIdentity).not.toHaveBeenCalled();
    expect(mocks.createAgent).toHaveBeenCalledWith({
      host: 'https://ic.example',
      identity: anonymousIdentity,
      shouldFetchRootKey: false,
      shouldSyncTime: false,
      logToConsole: false,
    });
    expect(mocks.createActor).toHaveBeenCalledWith(expect.any(Function), {
      agent,
      canisterId: 'aaaaa-aa',
    });
    expect(chat).toHaveBeenCalledWith('hello');
  });

  it('derives a deterministic Ed25519 identity from IC_IDENTITY_SEED', async () => {
    const identity = { kind: 'ed25519' };
    mocks.generateIdentity.mockReturnValue(identity);
    vi.stubEnv('IC_IDENTITY_SEED', 'stable secret');
    vi.stubEnv('IC_HOST', '');

    await cooIcpAdapter({ q: 'hello' });

    const expectedSeed = createHash('sha256').update('stable secret').digest();
    expect(Array.from(mocks.generateIdentity.mock.calls[0][0])).toEqual(Array.from(expectedSeed));
    expect(mocks.createAgent).toHaveBeenCalledWith({
      host: 'https://icp-api.io',
      identity,
      shouldFetchRootKey: false,
      shouldSyncTime: false,
      logToConsole: false,
    });
  });
});
