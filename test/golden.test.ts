// Golden (characterisation) tests: they freeze what GET /api/consult and GET /openapi.json do today,
// so a behaviour-preserving refactor can be checked against them unchanged. Each scenario records the
// responses, every outgoing fetch, every adapter call and every console line, plus their order, and
// compares the whole record with the snapshot.
//
// Isolation: module state (listing / USDC face caches, the Arc problem log, the OpenAPI read) is reset
// with vi.resetModules() before every test, and the route handlers are imported dynamically per test.
// This file imports nothing from lib/ except '@/lib/adapters' (mocked), so lib internals may move.
// In vitest 4 resetModules re-evaluates the route modules but keeps the mocked '@/lib/adapters'
// instance (the mock factory result is cached), so the mock is reset and re-wired in every test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as fx from './fixtures';

vi.mock('@/lib/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adapters')>()),
  selectedAdapter: vi.fn(),
}));

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-11-15T00:00:00Z');
const SEC = 1_000;
const MIN = 60 * SEC;
const REQUEST_ORIGIN = 'https://untrusted-request-host.example';
const REPRICED = '2000000';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const USDC_V1_PAYMENT = fx.usdcV1PaymentHeader();
const SIG_BASE = fx.paymentSignatureFor(fx.v2Accept);
const SIG_ARC = fx.paymentSignatureFor(fx.arcV2Accept);
// A second, different payment per rail, for scenarios that pay twice.
const JPYC_PAYMENT_2 = fx.jpycPaymentHeader(2);
const USDC_V1_PAYMENT_2 = fx.usdcV1PaymentHeader(0x1002);
const SIG_BASE_2 = fx.paymentSignatureFor(fx.v2Accept, 0x2002);
const SIG_ARC_2 = fx.paymentSignatureFor(fx.arcV2Accept, 0x2002);
const xPayment = (value: string) => ({ 'X-PAYMENT': value });
const signature = (value: string) => ({ 'PAYMENT-SIGNATURE': value });
const xPaymentOn = (network: string) => xPayment(b64({ network, authorization: 'usdc-payment' }));

/** Base64 of JSON whose padded form ends with '=', with the padding removed. */
function unpadded(build: (filler: string) => unknown): string {
  for (let filler = ''; ; filler += 'x') {
    const padded = b64(build(filler));
    if (padded.endsWith('=')) return padded.replace(/=+$/, '');
  }
}

type Json = Record<string, unknown>;
const split = fx.catalogAccept.extra.openpay;
const jpycAccept = (over: Json) => ({ ...fx.catalogAccept, ...over });
const jpycSplit = (over: Json) => jpycAccept({ extra: { openpay: { ...split, ...over } } });
const listingWith = (over: Json) => ({ ...fx.listing, ...over });
const repricedJpyc = jpycAccept({
  maxAmountRequired: '2010000000000000000',
  extra: { openpay: { ...split, merchantValue: '2000000000000000000' } },
});
const paidListing = { ...fx.listing, description: 'Consultation', usdc: { priceUsd: '0.05' } };
const arcAccept = (over: Json) => ({ ...fx.arcV2Accept, ...over });
const arcExtra = (over: Json) => arcAccept({ extra: { ...fx.arcV2Accept.extra, ...over } });
const badArcContract = fx.usdcFaceWithArc(arcExtra({ verifyingContract: fx.attacker }));

type Face = {
  resourceId: string;
  v1Accepts: Json;
  v2Accept: Json;
  paymentRequiredHeader: string;
  arc?: { v2Accept: Json; paymentRequiredHeader: string };
};

/** A consistent USDC face at another price or recipient (optionally with a matching Arc face). */
function usdcFaceFor({ amount, arc = false, payTo = fx.usdcMerchant }: { amount: string; arc?: boolean; payTo?: string }): Face {
  const v1Accepts = { ...fx.usdcAccept, maxAmountRequired: amount, payTo };
  const v2 = { ...fx.v2Accept, amount, payTo };
  const face: Face = {
    resourceId: fx.resourceId,
    v1Accepts,
    v2Accept: v2,
    paymentRequiredHeader: b64({ x402Version: 2, resource: { url: fx.resource }, accepts: [v2] }),
  };
  if (!arc) return face;
  const arcV2 = { ...fx.arcV2Accept, amount };
  return { ...face, arc: { v2Accept: arcV2, paymentRequiredHeader: fx.arcHeaderFor([v2, arcV2]) } };
}

// Long strings that recur in outputs are shown as <<NAME>> in the snapshots. The substitution is exact
// (whole-string match), so any byte that differs leaves the raw value in the record and fails the test.
const LEGEND: Record<string, string> = {
  JPYC_ACCEPT: JSON.stringify({ ...fx.catalogAccept, resource: `${fx.resource}?q=hello` }),
  USDC_V1_ACCEPT: JSON.stringify(fx.usdcAccept),
  USDC_V1_ACCEPT_REPRICED: JSON.stringify(usdcFaceFor({ amount: REPRICED }).v1Accepts),
  ARC_V2_ACCEPT: JSON.stringify(fx.arcV2Accept),
  PAYMENT_REQUIRED_BASE: fx.paymentRequiredHeader,
  PAYMENT_REQUIRED_BASE_ARC: fx.arcPaymentRequiredHeader,
  PAYMENT_REQUIRED_BASE_REPRICED: usdcFaceFor({ amount: REPRICED }).paymentRequiredHeader,
  PAYMENT_REQUIRED_BASE_ARC_REPRICED: usdcFaceFor({ amount: REPRICED, arc: true }).arc!.paymentRequiredHeader,
  X_PAYMENT_JPYC: fx.paymentHeader,
  X_PAYMENT_JPYC_2: JPYC_PAYMENT_2,
  // The facilitator is sent the decoded payment, not the header.
  JPYC_PAYMENT: JSON.stringify(fx.paymentPayload),
  JPYC_PAYMENT_2: JSON.stringify(fx.jpycPayment(2)),
  X_PAYMENT_USDC_BASE: USDC_V1_PAYMENT,
  X_PAYMENT_USDC_BASE_2: USDC_V1_PAYMENT_2,
  PAYMENT_SIGNATURE_BASE: SIG_BASE,
  PAYMENT_SIGNATURE_BASE_2: SIG_BASE_2,
  PAYMENT_SIGNATURE_ARC: SIG_ARC,
  PAYMENT_SIGNATURE_ARC_2: SIG_ARC_2,
};
const LEGEND_BY_LENGTH = Object.entries(LEGEND).sort(([, a], [, b]) => b.length - a.length);

function legend(text: string): string {
  let out = text;
  for (const [name, value] of LEGEND_BY_LENGTH) out = out.split(value).join(`<<${name}>>`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stubbed OpenPay
// ---------------------------------------------------------------------------------------------

type Route =
  | 'discovery' | 'requirements' | 'facilitatorVerify' | 'facilitatorSettle' | 'relayVerify' | 'relaySettle';

const ROUTE_BY_URL: Record<string, Route> = {
  [`${fx.OPENPAY}/api/discovery/${fx.resourceId}`]: 'discovery',
  [`${fx.OPENPAY}/api/x402/relay/requirements?resourceId=${fx.resourceId}`]: 'requirements',
  [`${fx.OPENPAY}/api/facilitator/verify`]: 'facilitatorVerify',
  [`${fx.OPENPAY}/api/facilitator/settle`]: 'facilitatorSettle',
  [`${fx.OPENPAY}/api/x402/relay/verify`]: 'relayVerify',
  [`${fx.OPENPAY}/api/x402/relay/settle`]: 'relaySettle',
};

/** A fetch that waits until the test releases it, so the test decides the completion order. */
type Hold = { reached: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void };

function hold(): Hold {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { reached, arrive, released, release };
}

type Reply =
  | { json: unknown; status: number }
  | { text: string; status: number }
  | { throws: true }
  | { held: Hold; then: Reply };
/** One reply, or successive replies (the last one repeats). */
type Replies = Partial<Record<Route, Reply | Reply[]>>;

const json = (body: unknown, status = 200): Reply => ({ json: body, status });
const text = (body: string, status = 200): Reply => ({ text: body, status });
const THROWS: Reply = { throws: true };
const held = (gate: Hold, then: Reply): Reply => ({ held: gate, then });

async function reply(r: Reply): Promise<Response> {
  if ('held' in r) {
    r.held.arrive();
    await r.held.released;
    return reply(r.then);
  }
  if ('throws' in r) throw new TypeError('fetch failed');
  if ('text' in r) return new Response(r.text, { status: r.status, headers: { 'content-type': 'text/plain' } });
  return fx.response(r.json, r.status);
}

type Config = 'off' | 'base' | 'arc';

function defaultReplies(config: Config): Replies {
  return {
    discovery: json(fx.listing),
    // Served even when USDC is off, so a stray requirements read would change the outcome.
    requirements: json(config === 'arc' ? fx.usdcFaceWithArc() : fx.usdcFace),
    facilitatorVerify: json({ isValid: true }),
    facilitatorSettle: json({ success: true, transaction: '0xjpycsettled', network: 'eip155:137' }),
    relayVerify: json({ isValid: true }),
    relaySettle: json({ success: true, transaction: '0xusdcsettled', network: 'base' }),
  };
}

// ---------------------------------------------------------------------------------------------
// Recording harness
// ---------------------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;
type Handler = 'consult' | 'head' | 'openapi';
type AdapterMode = 'answer' | 'rejects' | 'undefined' | 'null' | 'bigint' | 'selectThrows';
type Opts = { replies?: Replies; env?: Env; adapter?: AdapterMode };
type Target = { path?: string; headers?: Record<string, string> };

const BASE_ENV: Env = {
  MY_RESOURCE_URL: fx.resource,
  MY_RESOURCE_ID: fx.resourceId,
  EXPECTED_RECIPIENT: fx.merchant,
  EXPECTED_USDC_RECIPIENT: undefined,
  ADAPTER: 'coo-icp',
  COO_CANISTER_ID: 'golden-canister-id',
  IC_IDENTITY_SEED: 'golden-placeholder-seed',
  IC_HOST: undefined,
  UPSTREAM_URL: undefined,
  NEXT_RUNTIME: undefined,
};

function stubEnv(env: Env): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

const KNOWN_INIT = ['method', 'headers', 'body', 'cache', 'signal'];

function bodyText(body: BodyInit | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return legend(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return legend(new TextDecoder().decode(body));
  return `[${Object.prototype.toString.call(body)}]`;
}

function fetchRecord(input: RequestInfo | URL, init: RequestInit = {}) {
  const request = input instanceof Request ? input : undefined;
  const otherInit = Object.keys(init).filter((key) => !KNOWN_INIT.includes(key)).sort();
  return {
    url: request ? request.url : String(input),
    method: (init.method ?? request?.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(new Headers(init.headers ?? request?.headers)),
    body: init.body === undefined && request ? '[Request body]' : bodyText(init.body),
    cache: init.cache ?? request?.cache ?? null,
    hasSignal: init.signal !== undefined && init.signal !== null ? true : request !== undefined,
    ...(request ? { inputType: 'Request' } : {}),
    ...(otherInit.length > 0
      ? { otherInit: Object.fromEntries(otherInit.map((key) => [key, String(init[key as keyof RequestInit])])) }
      : {}),
  };
}

async function responseRecord(res: unknown) {
  if (!(res instanceof Response)) return { returned: Object.prototype.toString.call(res) };
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => [name, legend(value)]),
    body: legend(await res.text()),
  };
}

function thrownRecord(error: unknown) {
  return error instanceof Error
    ? { threw: error.constructor.name, message: error.message }
    : { threw: typeof error, message: String(error) };
}

function clock(): string {
  const ms = Date.now() - T0;
  const minutes = Math.floor(ms / MIN);
  const seconds = String(Math.floor((ms % MIN) / SEC)).padStart(2, '0');
  return `+${minutes}:${seconds}.${String(ms % SEC).padStart(3, '0')}`;
}

type World = {
  consult(label: string, target?: Target): Promise<void>;
  head(label: string, target?: Target): Promise<void>;
  openapi(label: string): Promise<void>;
  /** Moves the faked clock to T0 + offset. */
  at(offsetMs: number): void;
  replies(replies: Replies): void;
  env(env: Env): void;
  /** Waits until a held fetch is reached; fails if the request finishes first. */
  reach(gate: Hold, pending: Promise<void>): Promise<void>;
  record(): unknown;
};

async function world(config: Config, opts: Opts = {}): Promise<World> {
  const requests: Json[] = [];
  const fetches: ReturnType<typeof fetchRecord>[] = [];
  const adapterCalls: unknown[][] = [];
  const consoleErrors: unknown[][] = [];
  const otherConsole: unknown[][] = [];
  const timeline: string[] = [];
  const queues: Partial<Record<Route, Reply[]>> = {};
  const adapterMode: AdapterMode = opts.adapter ?? 'answer';

  const setReplies = (replies: Replies) => {
    for (const route of Object.keys(replies) as Route[]) {
      const r = replies[route]!;
      queues[route] = Array.isArray(r) ? [...r] : [r];
    }
  };

  stubEnv({ EXPECTED_USDC_RECIPIENT: config === 'off' ? undefined : fx.usdcMerchant, ...opts.env });
  setReplies({ ...defaultReplies(config), ...opts.replies });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = fetchRecord(input, init);
    fetches.push(entry);
    const route = ROUTE_BY_URL[entry.url];
    timeline.push(`fetch ${route ?? entry.url}`);
    if (!route) throw new Error(`unexpected fetch ${entry.url}`);
    const queue = queues[route]!;
    return reply(queue.length > 1 ? queue.shift()! : queue[0]);
  }));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
    timeline.push('console.error');
  });
  for (const method of ['warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      otherConsole.push([method, ...args]);
      timeline.push(`console.${method}`);
    });
  }

  const adapters = await import('@/lib/adapters');
  const selectedAdapter = vi.mocked(adapters.selectedAdapter);
  selectedAdapter.mockReset();
  selectedAdapter.mockImplementation(() => {
    timeline.push('selectedAdapter');
    if (adapterMode === 'selectThrows') throw new Error('unknown adapter');
    return async (...args: [{ q: string }]) => {
      adapterCalls.push(args);
      timeline.push('adapter');
      if (adapterMode === 'rejects') throw new Error('upstream unavailable');
      if (adapterMode === 'undefined') return undefined;
      if (adapterMode === 'null') return null;
      if (adapterMode === 'bigint') return { answer: BigInt(1) };
      return { answer: 'answer' };
    };
  });
  const { GET: consultGet, HEAD: consultHead } = await import('@/app/api/consult/route');
  // Called with a Request so a future handler that reads it keeps working; today it takes none.
  const openapiGet = (await import('@/app/openapi.json/route')).GET as unknown as (
    request: Request,
  ) => Promise<Response>;

  async function send(label: string, handler: Handler, url: string, headers: Record<string, string>) {
    const entry: Json = {
      label,
      at: clock(),
      ...(handler === 'head' ? { method: 'HEAD' } : {}),
      url,
      ...(Object.keys(headers).length > 0
        ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, legend(v)])) }
        : {}),
    };
    requests.push(entry);
    timeline.push(`▶ ${label}`);
    try {
      const request = new Request(url, { headers, ...(handler === 'head' ? { method: 'HEAD' } : {}) });
      const handle = { consult: consultGet, head: consultHead, openapi: openapiGet }[handler];
      entry.response = await responseRecord(await handle(request));
    } catch (error) {
      entry.response = thrownRecord(error);
    }
  }

  return {
    consult: (label, target = {}) =>
      send(label, 'consult', `${REQUEST_ORIGIN}/api/consult${target.path ?? '?q=hello'}`, target.headers ?? {}),
    head: (label, target = {}) =>
      send(label, 'head', `${REQUEST_ORIGIN}/api/consult${target.path ?? '?q=hello'}`, target.headers ?? {}),
    openapi: (label) => send(label, 'openapi', `${REQUEST_ORIGIN}/openapi.json`, {}),
    at: (offsetMs) => vi.setSystemTime(T0 + offsetMs),
    replies: setReplies,
    env: stubEnv,
    reach: async (gate, pending) => {
      await Promise.race([
        gate.reached,
        pending.then(() => { throw new Error('request finished before reaching the held fetch'); }),
      ]);
    },
    record: () => ({
      requests,
      timeline,
      fetches,
      adapterCalls,
      consoleErrors,
      ...(otherConsole.length > 0 ? { otherConsole } : {}),
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  // Only Date is faked: timers, AbortSignal.timeout and promise jobs stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
  stubEnv(BASE_ENV);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------------------------

type Case = Opts & Target & { config: Config; handler?: Handler };
type Sequence = { config: Config; opts?: Opts; run: (w: World) => Promise<void> };

function cases(title: string, table: Record<string, Case>): void {
  describe(title, () => {
    for (const [name, c] of Object.entries(table)) {
      it(name, async () => {
        const w = await world(c.config, c);
        if (c.handler === 'openapi') await w.openapi('request');
        else if (c.handler === 'head') await w.head('request', c);
        else await w.consult('request', c);
        expect(w.record()).toMatchSnapshot();
      });
    }
  });
}

function sequences(title: string, table: Record<string, Sequence>): void {
  describe(title, () => {
    for (const [name, s] of Object.entries(table)) {
      it(name, async () => {
        const w = await world(s.config, s.opts);
        await s.run(w);
        expect(w.record()).toMatchSnapshot();
      });
    }
  });
}

const seq = (config: Config, run: (w: World) => Promise<void>, opts: Opts = {}): Sequence => ({ config, run, opts });
const CONFLICT = json({ error: 'requirements_mismatch' }, 409);
const NOT_FOUND = json({ error: 'not_found' }, 404);
const faceReply = (arc: boolean) => json(arc ? fx.usdcFaceWithArc() : fx.usdcFace);
const repricedReply = (arc: boolean) => json(usdcFaceFor({ amount: REPRICED, arc }));

it('environment: AbortSignal.timeout still fires while Date is faked', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const signal = AbortSignal.timeout(5);
  await new Promise((resolve) => signal.addEventListener('abort', resolve));
  expect(signal.aborted).toBe(true);
  expect(Date.now()).toBe(T0);
});

it('legend of the <<NAME>> placeholders used in the snapshots', () => {
  expect(LEGEND).toMatchSnapshot();
});

// ---------------------------------------------------------------------------------------------
// 1. Unpaid requests
// ---------------------------------------------------------------------------------------------

cases('1. unpaid GET /api/consult', {
  'USDC off': { config: 'off' },
  'USDC on, Base-only face': { config: 'base' },
  'USDC on, Base + Arc face': { config: 'arc' },
  'no query string': { config: 'base', path: '' },
  'percent-encoded query, extra parameter and fragment': { config: 'base', path: '?q=%E3%81%82&x=1#frag' },
  'raw unicode, space and angle brackets in the query': { config: 'base', path: '?q=あ b&a=<b>' },
  'listing with two accepts': {
    config: 'base',
    replies: { discovery: json(listingWith({ accepts: [fx.catalogAccept, repricedJpyc] })) },
  },
  'empty X-PAYMENT header alone is unpaid': { config: 'base', headers: xPayment('') },
  'empty X-PAYMENT header without q is still unpaid': { config: 'base', path: '', headers: xPayment('') },
});

// ---------------------------------------------------------------------------------------------
// 2. Payment terms failures
// ---------------------------------------------------------------------------------------------

cases('2. terms failures', {
  'discovery 404': { config: 'base', replies: { discovery: NOT_FOUND } },
  'discovery 400': { config: 'base', replies: { discovery: json({ error: 'bad_request' }, 400) } },
  'discovery 500': { config: 'base', replies: { discovery: json({ error: 'internal' }, 500) } },
  'discovery 503': { config: 'base', replies: { discovery: json({ error: 'unavailable' }, 503) } },
  'discovery 503 with USDC off': { config: 'off', replies: { discovery: json({ error: 'unavailable' }, 503) } },
  'discovery fetch throws': { config: 'base', replies: { discovery: THROWS } },
  'discovery non-JSON body': { config: 'base', replies: { discovery: text('<html>oops</html>') } },
  'discovery JSON null': { config: 'base', replies: { discovery: json(null) } },
  'listing with another id': { config: 'base', replies: { discovery: json(listingWith({ id: 'other-resource-id' })) } },
  'listing with another resource URL': {
    config: 'base',
    replies: { discovery: json(listingWith({ resource: 'https://attacker.example/api/consult' })) },
  },
  'listing merchant is not EXPECTED_RECIPIENT': {
    config: 'base',
    replies: { discovery: json(listingWith({ accepts: [jpycSplit({ merchant: fx.attacker })] })) },
  },
  'listing forwarder differs from payTo': {
    config: 'base',
    replies: { discovery: json(listingWith({ accepts: [jpycAccept({ payTo: fx.attacker })] })) },
  },
  'listing split mode is not forwarder-split': {
    config: 'base',
    replies: { discovery: json(listingWith({ accepts: [jpycSplit({ mode: 'direct' })] })) },
  },
  'listing with empty accepts': { config: 'base', replies: { discovery: json(listingWith({ accepts: [] })) } },
  'listing whose second accept fails the pins': {
    config: 'base',
    replies: { discovery: json(listingWith({ accepts: [fx.catalogAccept, jpycSplit({ merchant: fx.attacker })] })) },
  },
  'listing pin failure on a paid JPYC request': {
    config: 'base',
    headers: xPayment(fx.paymentHeader),
    replies: { discovery: json(listingWith({ accepts: [jpycSplit({ merchant: fx.attacker })] })) },
  },
  'requirements 404 (JPYC-only 402)': { config: 'base', replies: { requirements: NOT_FOUND } },
  'requirements 500 (JPYC-only 402)': { config: 'base', replies: { requirements: json({ error: 'internal' }, 500) } },
  'requirements fetch throws (JPYC-only 402)': { config: 'base', replies: { requirements: THROWS } },
  'requirements non-JSON body (JPYC-only 402)': { config: 'base', replies: { requirements: text('oops') } },
  'requirements JSON null': { config: 'base', replies: { requirements: json(null) } },
  'USDC face with another resourceId': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, resourceId: 'other-resource-id' }) },
  },
  'USDC face v1 recipient mismatch': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, payTo: fx.attacker } }) },
  },
  'USDC face header recipient mismatch': {
    config: 'base',
    replies: {
      requirements: json({
        ...fx.usdcFace,
        paymentRequiredHeader: b64({ x402Version: 2, accepts: [{ ...fx.v2Accept, payTo: fx.attacker }] }),
      }),
    },
  },
  'USDC face v2 amount mismatch': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, v2Accept: { ...fx.v2Accept, amount: REPRICED } }) },
  },
  'USDC face v1 network is not Base': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, network: 'polygon' } }) },
  },
  'USDC face with an undecodable header': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, paymentRequiredHeader: 'not base64!' }) },
  },
  'USDC face header without accepts': {
    config: 'base',
    replies: { requirements: json({ ...fx.usdcFace, paymentRequiredHeader: b64({ x402Version: 2, accepts: [] }) }) },
  },
  'USDC face trust failure on a paid JPYC request': {
    config: 'base',
    headers: xPayment(fx.paymentHeader),
    replies: { requirements: json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, payTo: fx.attacker } }) },
  },
  'Arc money mismatch: Arc recipient': {
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcAccept({ payTo: fx.attacker }))) },
  },
  'Arc money mismatch: Arc amount': {
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcAccept({ amount: REPRICED }))) },
  },
  'Arc header lists only Arc': {
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(fx.arcV2Accept, fx.arcHeaderFor([fx.arcV2Accept]))) },
  },
  'Arc signing domain name mismatch (Arc dropped)': {
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcExtra({ name: 'USD Coin' }))) },
  },
  'Arc payment timeout out of range (Arc dropped)': {
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcAccept({ maxTimeoutSeconds: 300 }))) },
  },
  'Arc header metadata mismatch (Arc dropped)': {
    config: 'arc',
    replies: {
      requirements: json(fx.usdcFaceWithArc(
        fx.arcV2Accept,
        fx.arcHeaderFor([fx.v2Accept, fx.arcV2Accept], { resource: { url: 'https://other.example' } }),
      )),
    },
  },
});

sequences('2b. Arc signing-domain problem log', {
  'wrong verifyingContract: Arc dropped and logged once across requests': seq('arc', async (w) => {
    await w.consult('unpaid');
    await w.consult('unpaid again');
    await w.consult('Arc payment while Arc is dropped', { headers: signature(SIG_ARC) });
    w.at(31 * MIN);
    await w.consult('unpaid after the face expired');
  }, { replies: { requirements: json(badArcContract) } }),
  'wrong verifyingContract: a relay 409 face reset and refetch of the same face': seq('arc', async (w) => {
    await w.consult('unpaid');
    await w.consult('Arc payment answered 409', { headers: signature(SIG_ARC) });
    await w.consult('unpaid again');
  }, { replies: { requirements: json(badArcContract), relayVerify: CONFLICT } }),
  'two different Arc problems are each logged once': seq('arc', async (w) => {
    await w.consult('wrong contract');
    w.at(31 * MIN);
    w.replies({ requirements: json(fx.usdcFaceWithArc(arcAccept({ maxTimeoutSeconds: 300 }))) });
    await w.consult('timeout out of range');
    w.at(62 * MIN);
    w.replies({ requirements: json(badArcContract) });
    await w.consult('wrong contract again');
  }, { replies: { requirements: json(badArcContract) } }),
});

// ---------------------------------------------------------------------------------------------
// 3. Paid pre-checks
// ---------------------------------------------------------------------------------------------

cases('3. paid pre-checks', {
  'q missing with X-PAYMENT': { config: 'base', path: '', headers: xPayment(fx.paymentHeader) },
  'q empty with X-PAYMENT': { config: 'base', path: '?q=', headers: xPayment(fx.paymentHeader) },
  'q missing with PAYMENT-SIGNATURE, USDC off': { config: 'off', path: '', headers: signature(SIG_BASE) },
  'PAYMENT-SIGNATURE with USDC off': { config: 'off', headers: signature(SIG_BASE) },
  'empty PAYMENT-SIGNATURE with USDC off': { config: 'off', headers: signature('') },
  'empty PAYMENT-SIGNATURE with USDC on (Base)': { config: 'base', headers: signature('') },
  'empty PAYMENT-SIGNATURE with USDC on (Arc)': { config: 'arc', headers: signature('') },
  'X-PAYMENT not base64, USDC off': { config: 'off', headers: xPayment('not valid base64') },
  'X-PAYMENT not base64, USDC on': { config: 'base', headers: xPayment('not valid base64') },
  'X-PAYMENT base64 of non-JSON, USDC off': { config: 'off', headers: xPayment(Buffer.from('not json').toString('base64')) },
  'X-PAYMENT base64 of non-JSON, USDC on': { config: 'base', headers: xPayment(Buffer.from('not json').toString('base64')) },
  'X-PAYMENT unpadded base64': {
    config: 'base',
    headers: xPayment(unpadded((filler) => ({ ...fx.paymentPayload, filler }))),
  },
  'X-PAYMENT base64 of JSON null': { config: 'base', headers: xPayment(b64(null)) },
  'X-PAYMENT network base, USDC off': { config: 'off', headers: xPaymentOn('base') },
  'X-PAYMENT network base-sepolia, USDC off': { config: 'off', headers: xPaymentOn('base-sepolia') },
  'X-PAYMENT network eip155:8453, USDC off': { config: 'off', headers: xPaymentOn('eip155:8453') },
  'X-PAYMENT network eip155:84532, USDC off': { config: 'off', headers: xPaymentOn('eip155:84532') },
  'X-PAYMENT network base-sepolia, USDC on (JPYC rail)': { config: 'base', headers: xPaymentOn('base-sepolia') },
  'X-PAYMENT network eip155:8453, USDC on (JPYC rail)': { config: 'base', headers: xPaymentOn('eip155:8453') },
  'X-PAYMENT network eip155:5042, USDC off': { config: 'off', headers: xPaymentOn('eip155:5042') },
  'X-PAYMENT network eip155:5042, USDC on (Base face)': { config: 'base', headers: xPaymentOn('eip155:5042') },
  'X-PAYMENT network eip155:5042, USDC on (Arc face)': { config: 'arc', headers: xPaymentOn('eip155:5042') },
  'X-PAYMENT network eip155:5042002, USDC on (Arc face)': { config: 'arc', headers: xPaymentOn('eip155:5042002') },
  'X-PAYMENT and PAYMENT-SIGNATURE, USDC off': {
    config: 'off',
    headers: { ...xPayment(fx.paymentHeader), ...signature(SIG_BASE) },
  },
  'X-PAYMENT and PAYMENT-SIGNATURE, USDC on (Base)': {
    config: 'base',
    headers: { ...xPayment(fx.paymentHeader), ...signature(SIG_BASE) },
  },
  'X-PAYMENT and Arc PAYMENT-SIGNATURE, USDC on (Arc)': {
    config: 'arc',
    headers: { ...xPayment(fx.paymentHeader), ...signature(SIG_ARC) },
  },
});

// ---------------------------------------------------------------------------------------------
// 4. JPYC purchase (X-PAYMENT, OpenPay facilitator)
// ---------------------------------------------------------------------------------------------

const JPYC_CASES: Record<string, Opts & Target> = {
  'success': {},
  'verify isValid false with invalidReason': {
    replies: { facilitatorVerify: json({ isValid: false, invalidReason: 'authorization_invalid' }) },
  },
  'verify isValid false without invalidReason': { replies: { facilitatorVerify: json({ isValid: false }) } },
  'verify body JSON null': { replies: { facilitatorVerify: json(null) } },
  'verify body a string': { replies: { facilitatorVerify: json('valid') } },
  'verify fetch throws': { replies: { facilitatorVerify: THROWS } },
  'verify non-JSON body': { replies: { facilitatorVerify: text('Bad Gateway', 502) } },
  'adapter rejects': { adapter: 'rejects' },
  'adapter returns undefined': { adapter: 'undefined' },
  'adapter returns null': { adapter: 'null' },
  'adapter returns a BigInt': { adapter: 'bigint' },
  'selectedAdapter throws': { adapter: 'selectThrows' },
  'settle success false with errorReason': {
    replies: { facilitatorSettle: json({ success: false, errorReason: 'settlement_declined' }) },
  },
  'settle success false without errorReason': { replies: { facilitatorSettle: json({ success: false }) } },
  'settle body JSON null': { replies: { facilitatorSettle: json(null) } },
  'settle fetch throws': { replies: { facilitatorSettle: THROWS } },
  'settle non-JSON body': { replies: { facilitatorSettle: text('Bad Gateway', 502) } },
  'listing with two accepts pays accepts[0]': {
    replies: { discovery: json(listingWith({ accepts: [fx.catalogAccept, repricedJpyc] })) },
  },
  'q needing encoding': { path: '?q=%E3%81%82%20b&x=1' },
};

const JPYC_CONFIGS: Array<[Config, string[]]> = [
  ['off', Object.keys(JPYC_CASES)],
  ['base', ['success', 'verify isValid false with invalidReason', 'verify body JSON null', 'adapter rejects',
    'settle success false with errorReason']],
  ['arc', ['success', 'verify isValid false with invalidReason']],
];

for (const [config, names] of JPYC_CONFIGS) {
  cases(`4. JPYC purchase, USDC ${config}`, Object.fromEntries(names.map((name) => [
    name,
    { config, headers: xPayment(fx.paymentHeader), ...JPYC_CASES[name] },
  ])));
}

// ---------------------------------------------------------------------------------------------
// 5. USDC purchase (OpenPay relay): Base v1, Base v2, Arc v2
// ---------------------------------------------------------------------------------------------

function usdcCases(arc: boolean): Record<string, Opts> {
  const face = faceReply(arc);
  return {
    'success': {},
    'relay verify isValid false with invalidReason': {
      replies: { relayVerify: json({ isValid: false, invalidReason: 'authorization_already_used' }) },
    },
    'relay verify isValid false without invalidReason': { replies: { relayVerify: json({ isValid: false }) } },
    'relay verify body JSON null': { replies: { relayVerify: json(null) } },
    'relay verify non-JSON body': { replies: { relayVerify: text('Bad Gateway', 502) } },
    'relay verify 409, requirements refetch succeeds': {
      replies: { relayVerify: CONFLICT, requirements: [face, repricedReply(arc)] },
    },
    'relay verify 409, requirements refetch 404': { replies: { relayVerify: CONFLICT, requirements: [face, NOT_FOUND] } },
    'relay verify 409, requirements refetch poisoned': {
      replies: {
        relayVerify: CONFLICT,
        requirements: [face, json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, payTo: fx.attacker } })],
      },
    },
    'relay verify fetch throws': { replies: { relayVerify: THROWS } },
    'adapter rejects': { adapter: 'rejects' },
    'adapter returns undefined': { adapter: 'undefined' },
    'relay settle success false with errorReason': {
      replies: { relaySettle: json({ success: false, errorReason: 'usdc_settlement_declined' }) },
    },
    'relay settle success false without errorReason': { replies: { relaySettle: json({ success: false }) } },
    'relay settle body JSON null': { replies: { relaySettle: json(null) } },
    'relay settle non-JSON body': { replies: { relaySettle: text('Bad Gateway', 502) } },
    'relay settle 409, requirements refetch succeeds': {
      replies: { relaySettle: CONFLICT, requirements: [face, repricedReply(arc)] },
    },
    'relay settle 409, requirements refetch 404': { replies: { relaySettle: CONFLICT, requirements: [face, NOT_FOUND] } },
    'relay settle fetch throws': { replies: { relaySettle: THROWS } },
  };
}

const USDC_RAILS: Array<[string, Config, Record<string, string>]> = [
  ['Base v1 (X-PAYMENT on base)', 'base', xPayment(USDC_V1_PAYMENT)],
  ['Base v2 (PAYMENT-SIGNATURE)', 'base', signature(SIG_BASE)],
  ['Arc v2 (PAYMENT-SIGNATURE)', 'arc', signature(SIG_ARC)],
];

for (const [rail, config, headers] of USDC_RAILS) {
  cases(`5. USDC purchase, ${rail}`, Object.fromEntries(Object.entries(usdcCases(config === 'arc')).map(
    ([name, opts]) => [name, { config, headers, ...opts }],
  )));
}

cases('5b. USDC rail selection', {
  'Base v2 payment while the Arc face is served': { config: 'arc', headers: signature(SIG_BASE) },
  'Arc payment with the accepted terms in another key order': {
    config: 'arc',
    headers: signature(fx.paymentSignatureFor(Object.fromEntries(Object.entries(fx.arcV2Accept).reverse()))),
  },
  'Arc payment with an unpadded PAYMENT-SIGNATURE': {
    config: 'arc',
    headers: signature(unpadded((filler) => ({
      x402Version: 2, accepted: fx.arcV2Accept, payload: { signature: '0x00', filler },
    }))),
  },
  'Arc payment for other Arc terms (Base rail)': {
    config: 'arc',
    headers: signature(fx.paymentSignatureFor(arcAccept({ amount: '1' }))),
  },
  'Arc payment while only the Base face is served (Base rail)': { config: 'base', headers: signature(SIG_ARC) },
  'unparseable PAYMENT-SIGNATURE while the Arc face is served': { config: 'arc', headers: signature('raw-signature') },
  'Base v1 X-PAYMENT while the Arc face is served': { config: 'arc', headers: xPayment(USDC_V1_PAYMENT) },
});

// ---------------------------------------------------------------------------------------------
// 6. HTTP status vs body on the payment calls (r.ok is not checked today)
// ---------------------------------------------------------------------------------------------

const STATUS_ENDPOINTS: Array<[Route, Config, Record<string, string>, Json, Json]> = [
  ['facilitatorVerify', 'off', xPayment(fx.paymentHeader),
    { isValid: true }, { isValid: false, invalidReason: 'facilitator_rejected' }],
  ['facilitatorSettle', 'off', xPayment(fx.paymentHeader),
    { success: true, transaction: '0xstatus' }, { success: false, errorReason: 'facilitator_rejected' }],
  ['relayVerify', 'base', signature(SIG_BASE),
    { isValid: true }, { isValid: false, invalidReason: 'relay_rejected' }],
  ['relaySettle', 'base', signature(SIG_BASE),
    { success: true, transaction: '0xstatus' }, { success: false, errorReason: 'relay_rejected' }],
];

cases('6. status vs body', Object.fromEntries(STATUS_ENDPOINTS.flatMap(([route, config, headers, ok, ko]) =>
  [202, 400, 429, 500, 503].flatMap((status) => [
    [`${route} HTTP ${status} with a success-shaped body`, { config, headers, replies: { [route]: json(ok, status) } }],
    [`${route} HTTP ${status} with a failure-shaped body`, { config, headers, replies: { [route]: json(ko, status) } }],
  ])),
));

// ---------------------------------------------------------------------------------------------
// 7. Odd bodies and reason values from verify / settle, on both rails
// ---------------------------------------------------------------------------------------------

const ODD_RAILS: Array<[string, Config, Record<string, string>, Route, Route]> = [
  ['JPYC', 'off', xPayment(fx.paymentHeader), 'facilitatorVerify', 'facilitatorSettle'],
  ['USDC', 'base', signature(SIG_BASE), 'relayVerify', 'relaySettle'],
];
const ODD_BODIES: Array<[string, unknown]> = [['42', 42], ['true', true], ['[]', []], ['"ok"', 'ok']];
const ODD_REASONS: Array<[string, unknown]> = [
  ['""', ''], ['false', false], ['0', 0], ['{"a":1}', { a: 1 }], ['a 200-character string', 'r'.repeat(200)],
  ['null', null],
];

cases('7. odd verify / settle bodies', Object.fromEntries(ODD_RAILS.flatMap(([rail, config, headers, verify, settle]) => [
  ...ODD_BODIES.flatMap(([label, body]) => [
    [`${rail} verify body ${label}`, { config, headers, replies: { [verify]: json(body) } }],
    [`${rail} settle body ${label}`, { config, headers, replies: { [settle]: json(body) } }],
  ]),
  ...ODD_REASONS.flatMap(([label, reason]) => [
    [`${rail} verify invalidReason ${label}`,
      { config, headers, replies: { [verify]: json({ isValid: false, invalidReason: reason }) } }],
    [`${rail} settle errorReason ${label}`,
      { config, headers, replies: { [settle]: json({ success: false, errorReason: reason }) } }],
  ]),
])));

// ---------------------------------------------------------------------------------------------
// 8. Cache tiers on one module instance (unpaid 30 minutes / paid 5 minutes)
// ---------------------------------------------------------------------------------------------

const JPYC_PAID = { headers: xPayment(fx.paymentHeader) };
const JPYC_PAID_2 = { headers: xPayment(JPYC_PAYMENT_2) };
const BASE_V2_PAID = { headers: signature(SIG_BASE) };
const BASE_V2_PAID_2 = { headers: signature(SIG_BASE_2) };

sequences('8. cache tiers', {
  'two unpaid requests: one discovery and one requirements fetch': seq('base', async (w) => {
    await w.consult('first');
    await w.consult('second', { path: '?q=again' });
  }),
  'unpaid, then JPYC paid after 4 minutes (cached) and 6 minutes (refetched)': seq('base', async (w) => {
    await w.consult('unpaid');
    w.at(4 * MIN);
    await w.consult('paid at 4:00', JPYC_PAID);
    w.at(6 * MIN);
    await w.consult('paid at 6:00', JPYC_PAID_2);
  }),
  'unpaid, then USDC v2 paid after 4 minutes (cached) and 6 minutes (refetched)': seq('base', async (w) => {
    await w.consult('unpaid');
    w.at(4 * MIN);
    await w.consult('paid at 4:00', BASE_V2_PAID);
    w.at(6 * MIN);
    await w.consult('paid at 6:00', BASE_V2_PAID_2);
  }),
  'unpaid at 0, 29 and 31 minutes': seq('base', async (w) => {
    await w.consult('at 0');
    w.at(29 * MIN);
    await w.consult('at 29:00');
    w.at(31 * MIN);
    await w.consult('at 31:00');
  }),
  'unpaid boundary: 29:59.999 cached, 30:00.000 refetched': seq('base', async (w) => {
    await w.consult('at 0');
    w.at(30 * MIN - 1);
    await w.consult('at 29:59.999');
    w.at(30 * MIN);
    await w.consult('at 30:00.000');
  }),
  'paid boundary (JPYC): 4:59.999 cached, 5:00.000 refetched': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.at(5 * MIN - 1);
    await w.consult('paid at 4:59.999', JPYC_PAID);
    w.at(5 * MIN);
    await w.consult('paid at 5:00.000', JPYC_PAID_2);
  }),
  'paid boundary (USDC v1): 4:59.999 cached, 5:00.000 refetched': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.at(5 * MIN - 1);
    await w.consult('paid at 4:59.999', { headers: xPayment(USDC_V1_PAYMENT) });
    w.at(5 * MIN);
    await w.consult('paid at 5:00.000', { headers: xPayment(USDC_V1_PAYMENT_2) });
  }),
  'paid boundary (Arc v2): 4:59.999 cached, 5:00.000 refetched': seq('arc', async (w) => {
    await w.consult('unpaid at 0');
    w.at(5 * MIN - 1);
    await w.consult('paid at 4:59.999', { headers: signature(SIG_ARC) });
    w.at(5 * MIN);
    await w.consult('paid at 5:00.000', { headers: signature(SIG_ARC_2) });
  }),
  'a paid refetch restarts the unpaid 30-minute window': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.at(6 * MIN);
    await w.consult('paid at 6:00', JPYC_PAID);
    w.at(36 * MIN - 1);
    await w.consult('unpaid at 35:59.999');
    w.at(36 * MIN);
    await w.consult('unpaid at 36:00.000');
  }),
  'repriced listing: unpaid keeps the cached terms, paid uses the fresh ones': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ discovery: json(listingWith({ accepts: [repricedJpyc] })) });
    w.at(10 * MIN);
    await w.consult('unpaid at 10:00');
    await w.consult('paid at 10:00', JPYC_PAID);
    await w.consult('unpaid after the payment');
  }),
  'repriced USDC face: unpaid keeps the cached terms, paid uses the fresh ones': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ requirements: repricedReply(false) });
    w.at(10 * MIN);
    await w.consult('unpaid at 10:00');
    await w.consult('paid at 10:00', BASE_V2_PAID);
    await w.consult('unpaid after the payment');
  }),
  'discovery 404 after a cached listing drops it': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ discovery: NOT_FOUND });
    w.at(10 * MIN);
    await w.consult('paid at 10:00 (404)', JPYC_PAID);
    w.at(11 * MIN);
    await w.consult('unpaid at 11:00 (404)');
    w.replies({ discovery: json(fx.listing) });
    w.at(12 * MIN);
    await w.consult('unpaid at 12:00 (listing back)');
  }),
  'discovery 503 after a cached listing keeps it for unpaid requests': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ discovery: json({ error: 'unavailable' }, 503) });
    w.at(10 * MIN);
    await w.consult('paid at 10:00 (503)', JPYC_PAID);
    w.at(20 * MIN);
    await w.consult('unpaid at 20:00');
  }),
  'requirements 404 after a cached face drops it': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ requirements: NOT_FOUND });
    w.at(10 * MIN);
    await w.consult('paid at 10:00 (404)', BASE_V2_PAID);
    w.at(11 * MIN);
    await w.consult('unpaid at 11:00');
  }),
  'requirements 503 after a cached face keeps it for unpaid requests': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.replies({ requirements: json({ error: 'unavailable' }, 503) });
    w.at(10 * MIN);
    await w.consult('paid at 10:00 (503)', BASE_V2_PAID);
    w.at(11 * MIN);
    await w.consult('unpaid at 11:00');
  }),
  'cache hits re-check the seller pins': seq('base', async (w) => {
    await w.consult('unpaid at 0');
    w.at(MIN);
    w.env({ EXPECTED_USDC_RECIPIENT: fx.attacker });
    await w.consult('USDC pin changed');
    w.env({ EXPECTED_USDC_RECIPIENT: fx.usdcMerchant, EXPECTED_RECIPIENT: fx.attacker });
    await w.consult('JPYC pin changed');
    w.env({ EXPECTED_RECIPIENT: fx.merchant, EXPECTED_USDC_RECIPIENT: undefined });
    await w.consult('USDC turned off');
  }),
  'a relay 409 re-pins the face later unpaid requests see': seq('base', async (w) => {
    await w.consult('paid, relay verify 409', BASE_V2_PAID);
    await w.consult('unpaid afterwards');
  }, { replies: { relayVerify: CONFLICT, requirements: [faceReply(false), repricedReply(false)] } }),
  'a relay 409 with a poisoned refetch leaves no face cached': seq('base', async (w) => {
    await w.consult('paid, relay verify 409', BASE_V2_PAID);
    await w.consult('unpaid afterwards');
  }, {
    replies: {
      relayVerify: CONFLICT,
      requirements: [faceReply(false), json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, payTo: fx.attacker } })],
    },
  }),
  'Arc enabled at OpenPay after a Base-only face was cached': seq('base', async (w) => {
    await w.consult('unpaid (Base-only face cached)');
    w.replies({ requirements: faceReply(true), relayVerify: [CONFLICT, json({ isValid: true })] });
    await w.consult('Arc payment against the cached face', { headers: signature(SIG_ARC) });
    await w.consult('Arc payment retried', { headers: signature(SIG_ARC) });
  }),
});

// ---------------------------------------------------------------------------------------------
// 9. Interleaved fetches (the test releases held fetches to fix the completion order)
// ---------------------------------------------------------------------------------------------

const repricedListing = listingWith({ accepts: [repricedJpyc] });

sequences('9. interleaved fetches', {
  'discovery: an older 404 is overtaken by a newer success': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, NOT_FOUND), json(fx.listing)] });
    const a = w.consult('A (discovery held, 404)');
    await w.reach(gate, a);
    await w.consult('B (discovery answers first)');
    gate.release();
    await a;
    await w.consult('C afterwards');
  }),
  'discovery: a newer 404 overtakes an older success': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, json(fx.listing)), NOT_FOUND] });
    const a = w.consult('A (discovery held, success)');
    await w.reach(gate, a);
    await w.consult('B (discovery 404 answers first)');
    gate.release();
    await a;
    w.replies({ discovery: json(fx.listing) });
    await w.consult('C afterwards');
  }),
  'discovery: an older success is overtaken by a newer repriced success': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, json(fx.listing)), json(repricedListing)] });
    const a = w.consult('A (discovery held, original terms)');
    await w.reach(gate, a);
    await w.consult('B (repriced terms answer first)');
    gate.release();
    await a;
    await w.consult('C afterwards');
  }),
  'discovery: a paid request overtaken while its listing read is held': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, json(fx.listing)), json(repricedListing)] });
    const a = w.consult('A paid JPYC (discovery held)', JPYC_PAID);
    await w.reach(gate, a);
    await w.consult('B unpaid (repriced terms answer first)');
    gate.release();
    await a;
  }),
  'requirements: an older 404 is overtaken by a newer success': seq('base', async (w) => {
    const gate = hold();
    w.replies({ requirements: [held(gate, NOT_FOUND), faceReply(false)] });
    const a = w.consult('A (requirements held, 404)');
    await w.reach(gate, a);
    await w.consult('B (requirements answer first)');
    gate.release();
    await a;
    await w.consult('C afterwards');
  }),
  'requirements: a newer 404 overtakes an older success': seq('base', async (w) => {
    const gate = hold();
    w.replies({ requirements: [held(gate, faceReply(false)), NOT_FOUND] });
    const a = w.consult('A (requirements held, success)');
    await w.reach(gate, a);
    await w.consult('B (requirements 404 answers first)');
    gate.release();
    await a;
    w.replies({ requirements: faceReply(false) });
    await w.consult('C afterwards');
  }),
  'requirements: an older success is overtaken by a newer repriced success': seq('base', async (w) => {
    const gate = hold();
    w.replies({ requirements: [held(gate, faceReply(false)), repricedReply(false)] });
    const a = w.consult('A (requirements held, original terms)');
    await w.reach(gate, a);
    await w.consult('B (repriced terms answer first)');
    gate.release();
    await a;
    await w.consult('C afterwards');
  }),
  'a relay 409 resets the face while another request reads requirements': seq('base', async (w) => {
    const gate = hold();
    w.replies({
      requirements: [held(gate, faceReply(false)), faceReply(false), repricedReply(false)],
      relayVerify: CONFLICT,
    });
    const a = w.consult('A unpaid (requirements held)');
    await w.reach(gate, a);
    await w.consult('B paid, relay verify 409', BASE_V2_PAID);
    gate.release();
    await a;
    await w.consult('C unpaid afterwards');
  }),
  'discovery: the older request re-checks a newer listing applied under another JPYC pin': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, json(fx.listing)), json(listingWith({ accepts: [jpycSplit({ merchant: fx.attacker })] }))] });
    const a = w.consult('A (discovery held, pinned to EXPECTED_RECIPIENT)');
    await w.reach(gate, a);
    w.env({ EXPECTED_RECIPIENT: fx.attacker });
    await w.consult('B (EXPECTED_RECIPIENT changed, its listing answers first)');
    gate.release();
    await a;
  }),
  'requirements: the older request re-checks a newer face applied under another USDC pin': seq('base', async (w) => {
    const gate = hold();
    w.replies({
      requirements: [held(gate, faceReply(false)), json(usdcFaceFor({ amount: fx.usdcAccept.maxAmountRequired, payTo: fx.attacker }))],
    });
    const a = w.consult('A (requirements held, pinned to EXPECTED_USDC_RECIPIENT)');
    await w.reach(gate, a);
    w.env({ EXPECTED_USDC_RECIPIENT: fx.attacker });
    await w.consult('B (EXPECTED_USDC_RECIPIENT changed, its face answers first)');
    gate.release();
    await a;
  }),
  'discovery: a paid read answering after 4:59.999 is used, after 5:00.000 is too old': seq('off', async (w) => {
    const first = hold();
    const second = hold();
    w.replies({ discovery: [held(first, json(fx.listing)), held(second, json(fx.listing))] });
    const a = w.consult('A paid, discovery answers at 4:59.999', JPYC_PAID);
    await w.reach(first, a);
    w.at(5 * MIN - 1);
    first.release();
    await a;
    w.at(10 * MIN);
    const b = w.consult('B paid at 10:00, discovery answers at 15:00.000', JPYC_PAID_2);
    await w.reach(second, b);
    w.at(15 * MIN);
    second.release();
    await b;
    await w.consult('C unpaid at 15:00.000');
  }),
  'discovery: an unpaid read answering after 30:00.000 is too old': seq('off', async (w) => {
    const gate = hold();
    w.replies({ discovery: [held(gate, json(fx.listing)), json(fx.listing)] });
    const a = w.consult('A unpaid, discovery answers at 30:00.000');
    await w.reach(gate, a);
    w.at(30 * MIN);
    gate.release();
    await a;
    await w.consult('B unpaid at 30:00.000');
  }),
  'requirements: a paid read answering after 4:59.999 is used, after 5:00.000 is too old': seq('base', async (w) => {
    const first = hold();
    const second = hold();
    w.replies({ requirements: [held(first, faceReply(false)), held(second, faceReply(false))] });
    const a = w.consult('A paid, requirements answer at 4:59.999', BASE_V2_PAID);
    await w.reach(first, a);
    w.at(5 * MIN - 1);
    first.release();
    await a;
    w.at(10 * MIN);
    const b = w.consult('B paid at 10:00, requirements answer at 15:00.000', BASE_V2_PAID_2);
    await w.reach(second, b);
    w.at(15 * MIN);
    second.release();
    await b;
    await w.consult('C unpaid at 15:00.000');
  }),
  'requirements: an unpaid read answering after 30:00.000 is too old': seq('base', async (w) => {
    const gate = hold();
    w.replies({ requirements: [held(gate, faceReply(false)), faceReply(false)] });
    const a = w.consult('A unpaid, requirements answer at 30:00.000');
    await w.reach(gate, a);
    w.at(30 * MIN);
    gate.release();
    await a;
    await w.consult('B unpaid at 30:00.000');
  }),
  'a relay 409 reset supersedes a requirements read started just before it': seq('base', async (w) => {
    const verify = hold();
    const read = hold();
    const refetch = hold();
    w.replies({
      relayVerify: held(verify, CONFLICT),
      requirements: [faceReply(false), held(read, faceReply(false)), held(refetch, repricedReply(false))],
    });
    const b = w.consult('B paid at 0:00 (relay verify held, then 409)', BASE_V2_PAID);
    await w.reach(verify, b);
    w.at(30 * MIN);
    const a = w.consult('A unpaid at 30:00 (requirements held)');
    await w.reach(read, a);
    verify.release();
    await w.reach(refetch, b);
    read.release();
    await a;
    refetch.release();
    await b;
    await w.consult('C unpaid afterwards');
  }),
  'a relay 409 resets the face while another request\'s held read returns 404': seq('base', async (w) => {
    const gate = hold();
    w.replies({
      requirements: [held(gate, NOT_FOUND), faceReply(false), repricedReply(false)],
      relayVerify: CONFLICT,
    });
    const a = w.consult('A unpaid (requirements held, 404)');
    await w.reach(gate, a);
    await w.consult('B paid, relay verify 409', BASE_V2_PAID);
    gate.release();
    await a;
    await w.consult('C unpaid afterwards');
  }),
});

// ---------------------------------------------------------------------------------------------
// 10. Configuration errors on /api/consult
// ---------------------------------------------------------------------------------------------

cases('10. consult configuration', {
  'MY_RESOURCE_ID unset': { config: 'base', env: { MY_RESOURCE_ID: undefined } },
  'MY_RESOURCE_ID with surrounding whitespace': { config: 'base', env: { MY_RESOURCE_ID: ` ${fx.resourceId}` } },
  'MY_RESOURCE_URL unset': { config: 'base', env: { MY_RESOURCE_URL: undefined } },
  'EXPECTED_RECIPIENT is a burn address': {
    config: 'base',
    env: { EXPECTED_RECIPIENT: '0x000000000000000000000000000000000000dEaD' },
  },
  'EXPECTED_USDC_RECIPIENT is not an address': { config: 'base', env: { EXPECTED_USDC_RECIPIENT: '0xnot-an-address' } },
  'EXPECTED_USDC_RECIPIENT empty (USDC off)': { config: 'base', env: { EXPECTED_USDC_RECIPIENT: '' } },
  'every setting wrong at once': {
    config: 'base',
    env: {
      MY_RESOURCE_ID: undefined,
      EXPECTED_RECIPIENT: undefined,
      EXPECTED_USDC_RECIPIENT: 'placeholder-not-an-address',
      MY_RESOURCE_URL: 'ftp://gateway.example.com/api/consult',
    },
  },
  'MY_RESOURCE_URL with its own query and fragment': {
    config: 'base',
    env: { MY_RESOURCE_URL: 'https://gateway.example.com/api/consult?source=openpay#top' },
    replies: {
      discovery: json(listingWith({ resource: 'https://gateway.example.com/api/consult?source=openpay#top' })),
    },
  },
  'MY_RESOURCE_URL with its own query, paid JPYC': {
    config: 'off',
    headers: xPayment(fx.paymentHeader),
    env: { MY_RESOURCE_URL: 'https://gateway.example.com/api/consult?source=openpay#top' },
    replies: {
      discovery: json(listingWith({ resource: 'https://gateway.example.com/api/consult?source=openpay#top' })),
    },
  },
});

// ---------------------------------------------------------------------------------------------
// 11. GET /openapi.json
// ---------------------------------------------------------------------------------------------

const api = (c: Partial<Case> = {}): Case => ({
  config: 'base',
  ...c,
  handler: 'openapi',
  replies: { discovery: json(paidListing), ...c.replies },
});
const otherResource = 'https://other.example:8443/v1/ask?source=openpay';

cases('11. GET /openapi.json', {
  '200 from the listing (coo-icp)': api(),
  '200 with the listing title': api({ replies: { discovery: json({ ...paidListing, title: 'Listing title' }) } }),
  '200 with ADAPTER unset (defaults to coo-icp)': api({ env: { ADAPTER: undefined } }),
  '200 with ADAPTER=http': api({ env: { ADAPTER: 'http', UPSTREAM_URL: 'https://upstream.example/api' } }),
  '200 with ADAPTER=http and UPSTREAM_URL=invalid-url': api({ env: { ADAPTER: 'http', UPSTREAM_URL: 'invalid-url' } }),
  '200 with the Arc face served': api({ config: 'arc' }),
  '200 with the Arc face dropped (signing domain)': api({
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcAccept({ maxTimeoutSeconds: 1 }))) },
  }),
  '200 with MY_RESOURCE_URL on another port, path and query': api({
    env: { MY_RESOURCE_URL: otherResource },
    replies: { discovery: json({ ...paidListing, resource: otherResource }) },
  }),
  '404 with USDC off': api({ config: 'off' }),
  '404 when the listing read returns 404': api({ replies: { discovery: NOT_FOUND } }),
  '404 when the listing read returns 500': api({ replies: { discovery: json({ error: 'internal' }, 500) } }),
  '404 when the listing read throws': api({ replies: { discovery: THROWS } }),
  '404 when the listing read is not JSON': api({ replies: { discovery: text('oops') } }),
  '404 when the requirements read returns 404': api({ replies: { requirements: NOT_FOUND } }),
  '404 when the requirements read returns 500': api({ replies: { requirements: json({ error: 'internal' }, 500) } }),
  '404 when the requirements read throws': api({ replies: { requirements: THROWS } }),
  '404 when the USDC recipient does not match': api({
    replies: { requirements: json({ ...fx.usdcFace, v1Accepts: { ...fx.usdcAccept, payTo: fx.attacker } }) },
  }),
  '404 when the Arc recipient does not match': api({
    config: 'arc',
    replies: { requirements: json(fx.usdcFaceWithArc(arcAccept({ payTo: fx.attacker }))) },
  }),
  '404 when the JPYC recipient does not match': api({
    replies: { discovery: json({ ...paidListing, accepts: [jpycSplit({ merchant: fx.attacker })] }) },
  }),
  '404 when the listing has no USDC price': api({ replies: { discovery: json({ ...paidListing, usdc: undefined }) } }),
  '404 when the USDC price is "0"': api({ replies: { discovery: json({ ...paidListing, usdc: { priceUsd: '0' } }) } }),
  '404 when the USDC price is "$0.05"': api({
    replies: { discovery: json({ ...paidListing, usdc: { priceUsd: '$0.05' } }) },
  }),
  '404 when the USDC price is a number': api({ replies: { discovery: json({ ...paidListing, usdc: { priceUsd: 5 } }) } }),
  '404 when the description is empty': api({ replies: { discovery: json({ ...paidListing, description: '' }) } }),
  '404 when the listing has no description': api({
    replies: { discovery: json({ ...fx.listing, usdc: { priceUsd: '0.05' } }) },
  }),
  '404 with an unknown ADAPTER': api({ env: { ADAPTER: 'other' } }),
  '404 for coo-icp without COO_CANISTER_ID': api({ env: { COO_CANISTER_ID: undefined } }),
  '404 for coo-icp without IC_IDENTITY_SEED': api({ env: { IC_IDENTITY_SEED: undefined } }),
  '404 for http without UPSTREAM_URL': api({ env: { ADAPTER: 'http', UPSTREAM_URL: undefined } }),
  '404 with MY_RESOURCE_ID unset': api({ env: { MY_RESOURCE_ID: undefined } }),
});

const PAID_LISTING: Opts = { replies: { discovery: json(paidListing) } };

sequences('11b. /openapi.json caching and /api/consult interleaving', {
  'openapi first, then consult: separate caches': seq('base', async (w) => {
    await w.openapi('openapi');
    await w.consult('consult unpaid');
    await w.openapi('openapi again');
  }, PAID_LISTING),
  'consult first, then openapi: separate caches': seq('base', async (w) => {
    await w.consult('consult unpaid');
    await w.openapi('openapi');
    await w.consult('consult unpaid again');
  }, PAID_LISTING),
  'openapi 404 does not drop the consult USDC face': seq('base', async (w) => {
    await w.consult('consult unpaid');
    w.replies({ requirements: NOT_FOUND });
    await w.openapi('openapi (requirements 404)');
    await w.consult('consult unpaid again');
  }, PAID_LISTING),
  'document cached for 30 minutes (boundary)': seq('base', async (w) => {
    await w.openapi('at 0');
    w.at(30 * MIN - 1);
    await w.openapi('at 29:59.999');
    w.at(30 * MIN);
    await w.openapi('at 30:00.000');
  }, PAID_LISTING),
  'failure not retried for 60 seconds (boundary)': seq('base', async (w) => {
    await w.openapi('at 0 (requirements 500)');
    w.replies({ requirements: faceReply(false) });
    w.at(MIN - 1);
    await w.openapi('at 0:59.999');
    w.at(MIN);
    await w.openapi('at 1:00.000');
  }, { replies: { discovery: json(paidListing), requirements: json({ error: 'internal' }, 500) } }),
  'concurrent requests share one read': seq('base', async (w) => {
    const gate = hold();
    w.replies({ requirements: [held(gate, faceReply(false)), faceReply(false)] });
    const a = w.openapi('A (requirements held)');
    await w.reach(gate, a);
    const b = w.openapi('B while A reads');
    gate.release();
    await a;
    await b;
    w.at(MIN);
    await w.openapi('C at 1:00');
  }, PAID_LISTING),
});

// ---------------------------------------------------------------------------------------------
// 12. HEAD /api/consult: nothing is sold on HEAD
// ---------------------------------------------------------------------------------------------

cases('12. HEAD /api/consult', {
  'unpaid, USDC off': { config: 'off', handler: 'head' },
  'unpaid, Base + Arc face': { config: 'arc', handler: 'head' },
  'unpaid without q': { config: 'base', handler: 'head', path: '' },
  'unpaid with an empty X-PAYMENT (unpaid, as on GET)': { config: 'base', handler: 'head', headers: xPayment('') },
  'unpaid while discovery answers 503': {
    config: 'base', handler: 'head', replies: { discovery: json({ error: 'unavailable' }, 503) },
  },
  'X-PAYMENT (JPYC)': { config: 'base', handler: 'head', headers: xPayment(fx.paymentHeader) },
  'X-PAYMENT (USDC Base v1)': { config: 'base', handler: 'head', headers: xPayment(USDC_V1_PAYMENT) },
  'PAYMENT-SIGNATURE (Base v2)': { config: 'base', handler: 'head', headers: signature(SIG_BASE) },
  'PAYMENT-SIGNATURE (Arc v2)': { config: 'arc', handler: 'head', headers: signature(SIG_ARC) },
  'empty PAYMENT-SIGNATURE': { config: 'base', handler: 'head', headers: signature('') },
  'X-PAYMENT without q': { config: 'base', handler: 'head', path: '', headers: xPayment(fx.paymentHeader) },
  'X-PAYMENT that is not base64': { config: 'off', handler: 'head', headers: xPayment('not valid base64') },
});

// ---------------------------------------------------------------------------------------------
// 13. Settle answered 202 (still in flight): no 402, the settle body goes back as the receipt
// ---------------------------------------------------------------------------------------------

const PENDING = { success: false, errorReason: 'pending', transaction: '0xpending' };
const PENDING_RAILS: Array<[string, Config, Record<string, string>, Route]> = [
  ['JPYC', 'off', xPayment(fx.paymentHeader), 'facilitatorSettle'],
  ['USDC Base v1', 'base', xPayment(USDC_V1_PAYMENT), 'relaySettle'],
  ['USDC Base v2', 'base', signature(SIG_BASE), 'relaySettle'],
  ['USDC Arc v2', 'arc', signature(SIG_ARC), 'relaySettle'],
];

cases('13. settle pending (202)', Object.fromEntries(PENDING_RAILS.flatMap(([rail, config, headers, settle]) => [
  [`${rail}: pending body`, { config, headers, replies: { [settle]: json(PENDING, 202) } }],
  [`${rail}: 202 with JSON null`, { config, headers, replies: { [settle]: json(null, 202) } }],
  [`${rail}: 202 with a non-JSON body`, { config, headers, replies: { [settle]: text('accepted', 202) } }],
])));

// ---------------------------------------------------------------------------------------------
// 14. How verify / settle answers are read: status first, then the body
// ---------------------------------------------------------------------------------------------

const READ_RAILS: Array<[string, Config, Record<string, string>, Route, Route]> = [
  ['JPYC', 'off', xPayment(fx.paymentHeader), 'facilitatorVerify', 'facilitatorSettle'],
  ['USDC Base v2', 'base', signature(SIG_BASE), 'relayVerify', 'relaySettle'],
  ['USDC Arc v2', 'arc', signature(SIG_ARC), 'relayVerify', 'relaySettle'],
];

cases('14. reading verify / settle answers', Object.fromEntries(READ_RAILS.flatMap(([rail, config, headers, verify, settle]) => [
  // A rejection whose reason is in `error` (the relay's error shape) or missing.
  [`${rail}: verify 400 with error code`,
    { config, headers, replies: { [verify]: json({ error: 'authorization_in_use' }, 400) } }],
  [`${rail}: verify 404 with error code`, { config, headers, replies: { [verify]: json({ error: 'not_found' }, 404) } }],
  [`${rail}: verify 413 with a non-JSON body`, { config, headers, replies: { [verify]: text('too large', 413) } }],
  [`${rail}: verify 400 with a sentence as the reason`,
    { config, headers, replies: { [verify]: json({ isValid: false, invalidReason: 'Signature is invalid!' }, 400) } }],
  [`${rail}: verify 200 with isValid "true" (a string)`, { config, headers, replies: { [verify]: json({ isValid: 'true' }) } }],
  [`${rail}: verify 200 with an empty object`, { config, headers, replies: { [verify]: json({}) } }],
  [`${rail}: verify 201`, { config, headers, replies: { [verify]: json({ isValid: true }, 201) } }],
  [`${rail}: settle 400 with error code`, { config, headers, replies: { [settle]: json({ error: 'reservation_invalid' }, 400) } }],
  [`${rail}: settle 413 with a non-JSON body`, { config, headers, replies: { [settle]: text('too large', 413) } }],
  [`${rail}: settle 200 with an empty object`, { config, headers, replies: { [settle]: json({}) } }],
  [`${rail}: settle 200 with success "true" (a string)`, { config, headers, replies: { [settle]: json({ success: 'true' }) } }],
  [`${rail}: settle 200 reverted`, { config, headers, replies: { [settle]: json({ success: false, errorReason: 'reverted' }) } }],
  [`${rail}: settle 201`, { config, headers, replies: { [settle]: json({ success: true }, 201) } }],
])));
