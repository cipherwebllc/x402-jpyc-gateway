import { createHash, randomUUID } from 'node:crypto';

import { Actor, HttpAgent, type ActorMethod } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';

import type { Adapter, AdapterDescriptor } from './types';

// coo-icp 0.7.0 の Candid (mainnet の candid:service で確認 2026-11-15)。0.7.0 で `chat` は削除された:
//   send_message : (request_id : text, base_revision : nat64, content : text)
//       -> (variant { Ok : record { reply : text; revision : nat64 }; Err : ChatError })
//   clear_conversation : () -> (nat64)   // 新しい revision
type ChatError =
  | { Invalid: string }
  | { Failed: string }
  | { Busy: null }
  | { Cleared: null }
  | { InProgress: null }
  | { Conflict: null };
type SendResult = { Ok: { reply: string; revision: bigint } } | { Err: ChatError };

type CooActor = {
  send_message: ActorMethod<[string, bigint, string], SendResult>;
  clear_conversation: ActorMethod<[], bigint>;
};

const idlFactory: Parameters<typeof Actor.createActor>[0] = () => {
  const ChatError = IDL.Variant({
    Invalid: IDL.Text,
    Failed: IDL.Text,
    Busy: IDL.Null,
    Cleared: IDL.Null,
    InProgress: IDL.Null,
    Conflict: IDL.Null,
  });
  const Sent = IDL.Record({ reply: IDL.Text, revision: IDL.Nat64 });
  return IDL.Service({
    send_message: IDL.Func(
      [IDL.Text, IDL.Nat64, IDL.Text],
      [IDL.Variant({ Ok: Sent, Err: ChatError })],
      [],
    ),
    clear_conversation: IDL.Func([], [IDL.Nat64], []),
  });
};

// canister は caller (principal) ごとに会話を 1 つ持ち、同じ caller の 2 つ目の要求は Busy、
// clear は生成中の回答を取り消す。買い手ごとに会話を分けるため、seed から決まる identity を
// IDENTITY_SLOTS 個持ち、1 つの要求が 1 つを使い終わるまで占有する。数を固定するのは、
// canister に残す会話の数を増やし続けないため。
const IDENTITY_SLOTS = 8;
const freeSlots = Array.from({ length: IDENTITY_SLOTS }, (_, slot) => slot);
const waiting: Array<(slot: number) => void> = [];
// 待ち行列を無制限にしない。超えた分は待たせずに断る (route が 502・未課金)。
const MAX_WAITING = 32;

// 1 リクエスト (slot の空き待ち + clear + send) の期限。応答しない呼び出しが slot を
// 握り続けると後続が永久に待つので、期限で通信を打ち切り、slot を finally で返させる。
const DEADLINE_MS = 120_000;
const DEADLINE_EXCEEDED = 'coo-icp deadline exceeded';

function acquireSlot(signal: AbortSignal): Promise<number> {
  if (freeSlots.length > 0) {
    // 別のインスタンスと同じ slot を選びにくくする (重なっても下の revision が混入を防ぐ)。
    const index = Math.floor(Math.random() * freeSlots.length);
    return Promise.resolve(freeSlots.splice(index, 1)[0]);
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(new Error('coo-icp is busy'));
  return new Promise((resolve, reject) => {
    waiting.push(resolve);
    // 期限が来た待ち手は列から外す。外した待ち手に slot を渡すと、誰も返さずに失われる。
    // (先に slot を受け取っていれば reject は何もせず、呼び出し側が期限を見て返す。)
    signal.addEventListener('abort', () => {
      const index = waiting.indexOf(resolve);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error(DEADLINE_EXCEEDED));
    }, { once: true });
  });
}

function releaseSlot(slot: number): void {
  const next = waiting.shift();
  if (next) next(slot);
  else freeSlots.push(slot);
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  // AbortSignal.timeout ではなく setTimeout にするのは、テストの fake timers で進められるようにするため。
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  try {
    return await run(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

function throwIfExpired(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(DEADLINE_EXCEEDED);
}

// slot 0 は以前の版と同じ principal (sha256(seed))。
function identityForSlot(seed: string, slot: number): Ed25519KeyIdentity {
  const material = slot === 0 ? seed : `${seed}\n${slot}`;
  return Ed25519KeyIdentity.generate(new Uint8Array(createHash('sha256').update(material).digest()));
}

export const cooIcpAdapter: Adapter = async ({ q }) => {
  const canisterId = process.env.COO_CANISTER_ID;
  if (!canisterId) throw new Error('COO_CANISTER_ID is not set');
  // canister は匿名の caller を受け付けない。
  const seed = process.env.IC_IDENTITY_SEED;
  if (!seed) throw new Error('IC_IDENTITY_SEED is not set');

  return withDeadline(async (signal) => {
    const slot = await acquireSlot(signal);
    try {
      throwIfExpired(signal);
      const agent = await HttpAgent.create({
        host: process.env.IC_HOST || 'https://icp-api.io',
        identity: identityForSlot(seed, slot),
        // SDK の通信すべてに期限の signal を付け、止まった通信を期限で打ち切る。SDK 自身の signal
        // (init でも Request の中でも) は Request にまとめてから、期限と合わせて残す。
        fetch: (input, init) => {
          const request = new Request(input, init);
          return fetch(request, { signal: AbortSignal.any([request.signal, signal]) });
        },
        shouldFetchRootKey: false,
        shouldSyncTime: false,
        logToConsole: false,
      });
      const actor = Actor.createActor<CooActor>(idlFactory, { agent, canisterId });
      // 1 支払い = 独立した 1 問 1 答: 会話を空にし、その revision の続きとしてだけ送る。
      // 別のインスタンスが同じ slot を先に動かしていれば canister が Conflict / Busy / Cleared で
      // 断るので、他の買い手の質問が文脈に混ざることはない。
      const revision = await actor.clear_conversation();
      // 期限を過ぎてから clear が返っても、もう送らない (502 になる要求で生成を始めない)。
      throwIfExpired(signal);
      const result = await actor.send_message(randomUUID(), revision, q);
      // Err は上流失敗として throw → route が settle せず 502 (未課金)。理由の本文は載せない。
      if (!('Ok' in result)) {
        throw new Error(`coo-icp send_message returned ${Object.keys(result.Err)[0]}`);
      }
      return { answer: result.Ok.reply };
    } catch (error) {
      // 期限で打ち切った失敗は、SDK の文面ではなく固定の文言にする。
      throwIfExpired(signal);
      throw error;
    } finally {
      releaseSlot(slot);
    }
  });
};

export const cooIcpDescriptor: AdapterDescriptor = {
  run: cooIcpAdapter,
  configured: () => Boolean(process.env.COO_CANISTER_ID && process.env.IC_IDENTITY_SEED),
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
};
