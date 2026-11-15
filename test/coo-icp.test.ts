import { createHash } from 'node:crypto';

import { IDL } from '@icp-sdk/core/candid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK's transport is replaced by a model of coo-icp 0.7.0 (one conversation per caller,
// revisions, Busy / Conflict / Cleared), so the tests exercise what the canister would answer
// rather than the order of mock calls. Candid (IDL) stays real.
type Entry = { revision: bigint; turns: string[]; inFlight: boolean; cleared: boolean };
type SendResult = { Ok: { reply: string; revision: bigint } } | { Err: Record<string, unknown> };

type Step = 'create' | 'clear_conversation' | 'send_message';

const canister = vi.hoisted(() => ({
  entries: new Map<string, Entry>(),
  /** Model calls wait on this; tests replace it to hold requests in flight. */
  model: (): Promise<void> => Promise.resolve(),
  /**
   * Runs as each remote step starts, with the `fetch` the adapter gave the SDK; tests replace it
   * to make a step throw or hang on the network.
   */
  network: (() => Promise.resolve()) as (step: Step, fetch: typeof globalThis.fetch) => Promise<void>,
  /** Set to make the next send_message answer this error. */
  failWith: null as Record<string, unknown> | null,
  /** Canister methods the adapter called, in order. */
  calls: [] as string[],
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

type FakeAgent = { caller: string; fetch: typeof globalThis.fetch };

vi.mock('@icp-sdk/core/agent', () => ({
  HttpAgent: {
    create: async (options: { identity: { caller: string }; fetch: typeof globalThis.fetch }) => {
      canister.agentOptions.push(options);
      await canister.network('create', options.fetch);
      return { caller: options.identity.caller, fetch: options.fetch } satisfies FakeAgent;
    },
  },
  Actor: {
    createActor: (
      idlFactory: (args: { IDL: unknown }) => unknown,
      options: { agent: FakeAgent; canisterId: string },
    ) => {
      canister.idlFactory = idlFactory;
      canister.actorOptions.push(options);
      const { caller, fetch } = options.agent;
      return {
        clear_conversation: async () => {
          canister.calls.push('clear_conversation');
          await canister.network('clear_conversation', fetch);
          return clearAs(caller);
        },
        send_message: async (requestId: string, base: bigint, content: string) => {
          canister.calls.push('send_message');
          await canister.network('send_message', fetch);
          return sendAs(caller, requestId, base, content);
        },
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
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Starts eight requests held in the model, so every identity is taken. */
async function takeAllIdentities(adapter: Awaited<ReturnType<typeof loadAdapter>>) {
  const { release } = holdModel();
  const requests = Array.from({ length: 8 }, (_, i) => adapter({ q: `q${i}` }));
  await settle();
  expect(canister.inFlightNow).toBe(8);
  return { requests, release };
}

describe('cooIcpAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    canister.entries.clear();
    canister.model = () => Promise.resolve();
    canister.network = () => Promise.resolve();
    canister.failWith = null;
    canister.calls.length = 0;
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
      fetch: expect.any(Function),
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

  it.each<[string, () => void]>([
    ['send_message returns an Err', () => { canister.failWith = { Busy: null }; }],
    ['HttpAgent.create rejects', () => {
      canister.network = async (step) => { if (step === 'create') throw new Error('agent unavailable'); };
    }],
    ['clear_conversation throws', () => {
      canister.network = async (step) => { if (step === 'clear_conversation') throw new Error('transport failed'); };
    }],
  ])('frees its identity after a failure (%s)', async (_, fail) => {
    const adapter = await loadAdapter();
    // Eight at once take every identity, so each one goes through the failure.
    fail();
    const failures = await Promise.all(
      Array.from({ length: 8 }, () => adapter({ q: 'x' }).then(() => null, (e: unknown) => e)),
    );
    expect(failures.every((e) => e instanceof Error)).toBe(true);
    canister.failWith = null;
    canister.network = () => Promise.resolve();

    const { requests, release } = await takeAllIdentities(adapter);
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
    const ours = Object.fromEntries(service._fields);

    // The canister's side, written out here from its candid:service rather than taken from the adapter:
    //   send_message : (text, nat64, text) -> (variant { Ok : record { reply : text; revision : nat64 }; Err : ChatError })
    //   clear_conversation : () -> (nat64)
    const ChatError = IDL.Variant({
      Invalid: IDL.Text, Failed: IDL.Text, Busy: IDL.Null, Cleared: IDL.Null, InProgress: IDL.Null, Conflict: IDL.Null,
    });
    const theirs = {
      send_message: IDL.Func(
        [IDL.Text, IDL.Nat64, IDL.Text],
        [IDL.Variant({ Ok: IDL.Record({ reply: IDL.Text, revision: IDL.Nat64 }), Err: ChatError })],
        [],
      ),
      clear_conversation: IDL.Func([], [IDL.Nat64], []),
    };

    expect(Object.keys(ours).sort()).toEqual(['clear_conversation', 'send_message']);
    // Both are update calls; a query would not keep the conversation.
    expect(ours.send_message.annotations).toEqual([]);
    expect(ours.clear_conversation.annotations).toEqual([]);
    expect(ours.clear_conversation.argTypes).toHaveLength(0);

    // What the adapter sends, the canister reads ...
    const args = ['request-1', 7n, 'hello'];
    expect(IDL.decode(theirs.send_message.argTypes, IDL.encode(ours.send_message.argTypes, args))).toEqual(args);
    // ... and what the canister answers, the adapter reads.
    const results = [
      { Ok: { reply: 'hi', revision: 8n } },
      { Err: { Invalid: 'no' } }, { Err: { Failed: 'no' } }, { Err: { Busy: null } },
      { Err: { Cleared: null } }, { Err: { InProgress: null } }, { Err: { Conflict: null } },
    ];
    for (const value of results) {
      expect(IDL.decode(ours.send_message.retTypes, IDL.encode(theirs.send_message.retTypes, [value]))).toEqual([value]);
    }
    const cleared = IDL.encode(theirs.clear_conversation.retTypes, [9n]);
    expect(IDL.decode(ours.clear_conversation.retTypes, cleared)).toEqual([9n]);
  });

  it('sends a request id the canister accepts', async () => {
    // The model rejects ids that are not 1-64 printable ASCII characters, as the canister does.
    const adapter = await loadAdapter();
    await expect(adapter({ q: 'hello' })).resolves.toMatchObject({ answer: expect.any(String) });
  });

  describe('deadline and queue limit', () => {
    const DEADLINE_MS = 120_000;
    const asError = (e: unknown) => e;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('releases requests whose network call hangs at the deadline', async () => {
      // Only the deadline's signal ends this fetch, so the requests end only if the adapter wires
      // the signal into the SDK's fetch.
      const hungFetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('fetch without a signal'));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      vi.stubGlobal('fetch', hungFetch);
      canister.network = async (step, fetch) => {
        if (step === 'send_message') await fetch('https://ic.example/api/v4/canister/aaaaa-aa/call', { method: 'POST' });
      };
      const adapter = await loadAdapter();

      let settled = 0;
      const requests = Array.from({ length: 8 }, (_, i) => adapter({ q: `q${i}` })
        .then(() => null, asError)
        .finally(() => { settled += 1; }));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(hungFetch).toHaveBeenCalledTimes(8);
      expect(settled).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      const failures = await Promise.all(requests);
      expect(failures.map((e) => (e as Error).message)).toEqual(Array(8).fill('coo-icp deadline exceeded'));

      // Every identity came back.
      canister.network = () => Promise.resolve();
      const { requests: later, release } = await takeAllIdentities(adapter);
      release();
      await expect(Promise.all(later)).resolves.toHaveLength(8);
    });

    it('keeps a signal the SDK passes as well as the deadline', async () => {
      const seen: AbortSignal[] = [];
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        seen.push(init!.signal!);
        return new Response();
      });
      const sdk = new AbortController();
      canister.network = async (step, fetch) => {
        if (step === 'clear_conversation') await fetch('https://ic.example/', { signal: sdk.signal });
      };
      await (await loadAdapter())({ q: 'hello' });

      expect(seen).toHaveLength(1);
      expect(seen[0].aborted).toBe(false);
      sdk.abort();
      expect(seen[0].aborted).toBe(true);
    });

    it('keeps a signal the SDK put inside a Request', async () => {
      const seen: AbortSignal[] = [];
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        seen.push(init!.signal!);
        return new Response();
      });
      const sdk = new AbortController();
      canister.network = async (step, fetch) => {
        if (step === 'clear_conversation') await fetch(new Request('https://ic.example/', { signal: sdk.signal }));
      };
      await (await loadAdapter())({ q: 'hello' });

      expect(seen[0].aborted).toBe(false);
      sdk.abort();
      expect(seen[0].aborted).toBe(true);
    });

    it('still ends a call at the deadline when the SDK passes its own signal', async () => {
      const sdk = new AbortController();
      vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }));
      canister.network = async (step, fetch) => {
        if (step === 'send_message') await fetch('https://ic.example/', { method: 'POST', signal: sdk.signal });
      };
      const request = (await loadAdapter())({ q: 'hello' }).then(() => null, asError);

      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(((await request) as Error).message).toBe('coo-icp deadline exceeded');
    });

    it('leaves no timer behind after a success or a failure', async () => {
      const adapter = await loadAdapter();
      await adapter({ q: 'ok' });
      expect(vi.getTimerCount()).toBe(0);

      canister.failWith = { Busy: null };
      await adapter({ q: 'fails' }).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('hands freed identities to waiters in the order they arrived', async () => {
      const adapter = await loadAdapter();
      // One identity is freed at a time, so the order of the answers is the order of service.
      const gates: Array<() => void> = [];
      canister.model = () => new Promise<void>((resolve) => { gates.push(resolve); });
      const served: string[] = [];
      const start = (q: string) => adapter({ q }).then(() => { served.push(q); });

      const holders = Array.from({ length: 8 }, (_, i) => start(`h${i}`));
      await settle();
      const waiters = ['w0', 'w1', 'w2'].map(start);
      await settle();

      // Free one holder at a time; each freed identity must go to the oldest waiter.
      for (let i = 0; i < 3; i += 1) {
        gates[i]();
        await settle();
        gates[8 + i]();
        await settle();
      }
      expect(served.filter((q) => q.startsWith('w'))).toEqual(['w0', 'w1', 'w2']);
      gates.slice(3, 8).forEach((open) => open());
      await Promise.all([...holders, ...waiters]);
    });

    it('drops a waiter whose deadline passes in the queue without giving it an identity', async () => {
      const adapter = await loadAdapter();
      // These hold their identities past the deadline (their model call ignores the abort).
      const { requests: holders, release } = await takeAllIdentities(adapter);
      const waiter = adapter({ q: 'waiting' }).then(() => null, asError);

      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(((await waiter) as Error).message).toBe('coo-icp deadline exceeded');
      release();
      await Promise.allSettled(holders);
      expect(canister.agentOptions).toHaveLength(8);

      // All eight identities are still usable: none went to the dropped waiter.
      const { requests: later, release: releaseLater } = await takeAllIdentities(adapter);
      releaseLater();
      await expect(Promise.all(later)).resolves.toHaveLength(8);
      expect(canister.agentOptions).toHaveLength(16);
    });

    it('refuses a request at once when 32 are already waiting', async () => {
      const adapter = await loadAdapter();
      const { requests: holders, release } = await takeAllIdentities(adapter);
      const waiters = Array.from({ length: 32 }, (_, i) => adapter({ q: `w${i}` }));

      await expect(adapter({ q: 'one too many' })).rejects.toThrow('coo-icp is busy');
      expect(canister.agentOptions).toHaveLength(8);

      release();
      const answers = await Promise.all([...holders, ...waiters]) as Array<{ answer: string }>;
      expect(answers).toHaveLength(40);
      expect(answers.at(-1)!.answer).toBe('answer to w31 (context: none)');
    });

    it('does not send when clear_conversation returns after the deadline', async () => {
      let finishClear!: () => void;
      const slowClear = new Promise<void>((resolve) => { finishClear = resolve; });
      canister.network = (step) => (step === 'clear_conversation' ? slowClear : Promise.resolve());
      const adapter = await loadAdapter();

      const request = adapter({ q: 'too late' }).then(() => null, asError);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      finishClear();

      expect(((await request) as Error).message).toBe('coo-icp deadline exceeded');
      expect(canister.calls).toEqual(['clear_conversation']);
      expect(canister.inFlightMax).toBe(0);

      // Its identity came back.
      canister.network = () => Promise.resolve();
      await expect(adapter({ q: 'next' })).resolves.toEqual({ answer: 'answer to next (context: none)' });
    });
  });
});
