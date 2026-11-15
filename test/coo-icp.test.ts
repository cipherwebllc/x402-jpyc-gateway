import { createHash } from 'node:crypto';

import { IDL } from '@icp-sdk/core/candid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK's transport is replaced by a model of coo-icp 0.7.0 (one conversation per caller,
// revisions, Busy / Conflict / Cleared), so the tests exercise what the canister would answer
// rather than the order of mock calls. Candid (IDL) stays real.
type Entry = { revision: bigint; turns: string[]; inFlight: boolean; cleared: boolean };
type SendResult = { Ok: { reply: string; revision: bigint } } | { Err: Record<string, unknown> };

const canister = vi.hoisted(() => ({
  entries: new Map<string, Entry>(),
  /** Model calls wait on this; tests replace it to hold requests in flight. */
  model: (): Promise<void> => Promise.resolve(),
  /** Set to make the next send_message answer this error. */
  failWith: null as Record<string, unknown> | null,
  agentOptions: [] as unknown[],
  actorOptions: [] as unknown[],
  idlFactory: null as null | ((args: { IDL: unknown }) => unknown),
  inFlightNow: 0,
  inFlightMax: 0,
}));

function entryFor(caller: string): Entry {
  let entry = canister.entries.get(caller);
  if (!entry) {
    entry = { revision: 0n, turns: [], inFlight: false, cleared: false };
    canister.entries.set(caller, entry);
  }
  return entry;
}

function clearAs(caller: string): bigint {
  const entry = entryFor(caller);
  entry.turns = [];
  entry.revision += 1n;
  entry.cleared = entry.inFlight;
  return entry.revision;
}

async function sendAs(caller: string, requestId: string, base: bigint, content: string): Promise<SendResult> {
  if (canister.failWith) return { Err: canister.failWith };
  if (!/^[\x21-\x7e]{1,64}$/.test(requestId)) return { Err: { Invalid: 'malformed request id' } };
  const entry = entryFor(caller);
  if (entry.inFlight) return { Err: { Busy: null } };
  if (base !== entry.revision) return { Err: { Conflict: null } };
  entry.inFlight = true;
  entry.cleared = false;
  const context = [...entry.turns];
  canister.inFlightNow += 1;
  canister.inFlightMax = Math.max(canister.inFlightMax, canister.inFlightNow);
  try {
    await canister.model();
  } finally {
    canister.inFlightNow -= 1;
    entry.inFlight = false;
  }
  if (entry.cleared) return { Err: { Cleared: null } };
  const reply = `answer to ${content} (context: ${context.join(' | ') || 'none'})`;
  entry.turns.push(content, reply);
  entry.revision += 1n;
  return { Ok: { reply, revision: entry.revision } };
}

vi.mock('@icp-sdk/core/agent', () => ({
  HttpAgent: {
    create: async (options: { identity: { caller: string } }) => {
      canister.agentOptions.push(options);
      return { caller: options.identity.caller };
    },
  },
  Actor: {
    createActor: (
      idlFactory: (args: { IDL: unknown }) => unknown,
      options: { agent: { caller: string }; canisterId: string },
    ) => {
      canister.idlFactory = idlFactory;
      canister.actorOptions.push(options);
      const { caller } = options.agent;
      return {
        clear_conversation: async () => clearAs(caller),
        send_message: (requestId: string, base: bigint, content: string) => sendAs(caller, requestId, base, content),
      };
    },
  },
}));

vi.mock('@icp-sdk/core/identity', () => ({
  Ed25519KeyIdentity: {
    generate: (seed: Uint8Array) => ({ caller: Buffer.from(seed).toString('hex') }),
  },
}));

const SEED = 'stable secret';
const slotZeroCaller = createHash('sha256').update(SEED).digest('hex');

async function loadAdapter() {
  return (await import('@/lib/adapters/coo-icp')).cooIcpAdapter;
}

/** Holds every model call until `release()`. */
function holdModel(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  canister.model = () => gate;
  return { release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('cooIcpAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    canister.entries.clear();
    canister.model = () => Promise.resolve();
    canister.failWith = null;
    canister.agentOptions.length = 0;
    canister.actorOptions.length = 0;
    canister.idlFactory = null;
    canister.inFlightNow = 0;
    canister.inFlightMax = 0;
    vi.stubEnv('COO_CANISTER_ID', 'aaaaa-aa');
    vi.stubEnv('IC_IDENTITY_SEED', SEED);
    vi.stubEnv('IC_HOST', 'https://ic.example');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers q as an independent exchange and returns the reply', async () => {
    const adapter = await loadAdapter();

    await expect(adapter({ q: 'hello' })).resolves.toEqual({
      answer: 'answer to hello (context: none)',
    });
    expect(canister.actorOptions[0]).toMatchObject({ canisterId: 'aaaaa-aa' });
    expect(canister.agentOptions[0]).toMatchObject({
      host: 'https://ic.example',
      shouldFetchRootKey: false,
      shouldSyncTime: false,
      logToConsole: false,
    });
  });

  it('defaults to the mainnet host', async () => {
    vi.stubEnv('IC_HOST', '');
    await (await loadAdapter())({ q: 'hello' });

    expect(canister.agentOptions[0]).toMatchObject({ host: 'https://icp-api.io' });
  });

  it('does not carry an earlier buyer\'s exchange into the next answer', async () => {
    const adapter = await loadAdapter();
    // Force both requests onto one identity (a freed one goes to the end of the list),
    // the worst case for leaking context.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    await adapter({ q: 'first buyer secret' });
    const second = await adapter({ q: 'second question' }) as { answer: string };

    expect(second.answer).toBe('answer to second question (context: none)');
    expect(canister.entries.size).toBe(1);
  });

  it.each([
    ['COO_CANISTER_ID', 'COO_CANISTER_ID is not set'],
    ['IC_IDENTITY_SEED', 'IC_IDENTITY_SEED is not set'],
  ])('fails without calling the canister when %s is unset', async (name, message) => {
    vi.stubEnv(name, '');
    const adapter = await loadAdapter();

    await expect(adapter({ q: 'hello' })).rejects.toThrow(message);
    expect(canister.agentOptions).toHaveLength(0);
    expect(canister.entries.size).toBe(0);
  });

  it.each([
    [{ Invalid: 'remote text with details' }, 'Invalid'],
    [{ Failed: 'the model said something' }, 'Failed'],
    [{ Busy: null }, 'Busy'],
    [{ Cleared: null }, 'Cleared'],
    [{ InProgress: null }, 'InProgress'],
    [{ Conflict: null }, 'Conflict'],
  ])('throws on %o with only the variant name', async (error, label) => {
    canister.failWith = error;
    const adapter = await loadAdapter();

    const failure = await adapter({ q: 'hello' }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`coo-icp send_message returned ${label}`);
  });

  it('derives its callers from the seed alone, the first being sha256(seed)', async () => {
    const callersOf = async () => {
      vi.resetModules();
      canister.entries.clear();
      const adapter = await loadAdapter();
      const { release } = holdModel();
      const requests = Array.from({ length: 8 }, (_, i) => adapter({ q: `q${i}` }));
      await settle();
      const callers = [...canister.entries.keys()].sort();
      release();
      await Promise.all(requests);
      return callers;
    };

    const first = await callersOf();
    const second = await callersOf();

    expect(first).toHaveLength(8);
    expect(new Set(first).size).toBe(8);
    expect(first).toContain(slotZeroCaller);
    expect(second).toEqual(first);
  });

  it('gives concurrent buyers separate conversations', async () => {
    const adapter = await loadAdapter();
    const { release } = holdModel();

    const requests = ['alpha', 'beta', 'gamma'].map((q) => adapter({ q }));
    await settle();
    expect(canister.inFlightNow).toBe(3);
    expect(canister.entries.size).toBe(3);
    release();

    await expect(Promise.all(requests)).resolves.toEqual([
      { answer: 'answer to alpha (context: none)' },
      { answer: 'answer to beta (context: none)' },
      { answer: 'answer to gamma (context: none)' },
    ]);
  });

  it('queues requests beyond the number of identities instead of sharing one', async () => {
    const adapter = await loadAdapter();
    const { release } = holdModel();

    const requests = Array.from({ length: 11 }, (_, i) => adapter({ q: `q${i}` }));
    await settle();
    expect(canister.inFlightNow).toBe(8);
    release();

    const answers = await Promise.all(requests) as Array<{ answer: string }>;
    expect(answers.map((a) => a.answer)).toEqual(
      Array.from({ length: 11 }, (_, i) => `answer to q${i} (context: none)`),
    );
    expect(canister.inFlightMax).toBe(8);
    expect(canister.entries.size).toBe(8);
  });

  it('frees its identity after a failure', async () => {
    const adapter = await loadAdapter();
    canister.failWith = { Busy: null };
    await Promise.all(Array.from({ length: 8 }, () => adapter({ q: 'x' }).catch(() => undefined)));
    canister.failWith = null;

    const { release } = holdModel();
    const requests = Array.from({ length: 8 }, (_, i) => adapter({ q: `q${i}` }));
    await settle();
    expect(canister.inFlightNow).toBe(8);
    release();
    await expect(Promise.all(requests)).resolves.toHaveLength(8);
  });

  it('fails rather than mixing contexts when another instance uses the same identity', async () => {
    const adapter = await loadAdapter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { release } = holdModel();

    const mine = adapter({ q: 'my question' });
    await settle();
    const [caller] = [...canister.entries.keys()];

    // Another instance, with the same seed, starts its own request on that identity.
    const theirRevision = clearAs(caller);
    release();
    await expect(mine).rejects.toThrow('coo-icp send_message returned Cleared');

    const theirs = await sendAs(caller, 'their-request', theirRevision, 'their question');
    expect(theirs).toEqual({
      Ok: { reply: 'answer to their question (context: none)', revision: theirRevision + 1n },
    });
  });

  it('refuses to run on a conversation another instance moved on', async () => {
    const adapter = await loadAdapter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // The other instance holds the identity's one chat in flight.
    const { release } = holdModel();
    const other = sendAs(slotZeroCaller, 'other', clearAs(slotZeroCaller), 'other question');
    await settle();

    // Our clear cancels theirs; ours is refused while theirs is still in flight.
    await expect(adapter({ q: 'mine' })).rejects.toThrow('coo-icp send_message returned Busy');
    release();
    await expect(other).resolves.toEqual({ Err: { Cleared: null } });
  });

  it('declares the interface coo-icp 0.7.0 serves', async () => {
    await (await loadAdapter())({ q: 'hello' });
    const service = canister.idlFactory!({ IDL }) as IDL.ServiceClass;
    const methods = Object.fromEntries(service._fields);

    expect(Object.keys(methods).sort()).toEqual(['clear_conversation', 'send_message']);
    expect(methods.send_message.annotations).toEqual([]);
    expect(methods.clear_conversation.annotations).toEqual([]);

    // Arguments and results round-trip through Candid with the canister's types.
    const send = methods.send_message;
    const args = IDL.decode(send.argTypes, IDL.encode(send.argTypes, ['request-1', 7n, 'hello']));
    expect(args).toEqual(['request-1', 7n, 'hello']);
    const ChatError = IDL.Variant({
      Invalid: IDL.Text, Failed: IDL.Text, Busy: IDL.Null, Cleared: IDL.Null, InProgress: IDL.Null, Conflict: IDL.Null,
    });
    const canisterResult = IDL.Variant({
      Ok: IDL.Record({ revision: IDL.Nat64, reply: IDL.Text }),
      Err: ChatError,
    });
    for (const value of [{ Ok: { reply: 'hi', revision: 8n } }, { Err: { Busy: null } }, { Err: { Invalid: 'no' } }]) {
      expect(IDL.decode(send.retTypes, IDL.encode([canisterResult], [value]))).toEqual([value]);
    }
    expect(IDL.decode(methods.clear_conversation.retTypes, IDL.encode([IDL.Nat64], [9n]))).toEqual([9n]);
  });

  it('sends a request id the canister accepts', async () => {
    // The model rejects ids that are not 1-64 printable ASCII characters, as the canister does.
    const adapter = await loadAdapter();
    await expect(adapter({ q: 'hello' })).resolves.toMatchObject({ answer: expect.any(String) });
  });
});
