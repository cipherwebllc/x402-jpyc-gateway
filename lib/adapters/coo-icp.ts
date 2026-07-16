import { createHash } from 'node:crypto';

import { Actor, AnonymousIdentity, HttpAgent, type ActorMethod } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';

import type { Adapter } from './types';

// 実 canister の Candid (メタデータ candid:service で確認):
//   chat : (text) -> (variant { Ok : text; Err : text })
type ChatResult = { Ok: string } | { Err: string };

type CooActor = {
  chat: ActorMethod<[string], ChatResult>;
  clear_conversation: ActorMethod<[], undefined>;
};

const idlFactory: Parameters<typeof Actor.createActor>[0] = () =>
  IDL.Service({
    chat: IDL.Func([IDL.Text], [IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })], []),
    clear_conversation: IDL.Func([], [], []),
  });

function identityForEnvironment(): AnonymousIdentity | Ed25519KeyIdentity {
  const seed = process.env.IC_IDENTITY_SEED;
  if (!seed) return new AnonymousIdentity();

  const digest = createHash('sha256').update(seed).digest();
  return Ed25519KeyIdentity.generate(new Uint8Array(digest));
}

export const cooIcpAdapter: Adapter = async ({ q }) => {
  const canisterId = process.env.COO_CANISTER_ID;
  if (!canisterId) throw new Error('COO_CANISTER_ID is not set');

  const identity = identityForEnvironment();
  const agent = await HttpAgent.create({
    host: process.env.IC_HOST || 'https://icp-api.io',
    identity,
    shouldFetchRootKey: false,
    shouldSyncTime: false,
    logToConsole: false,
  });
  const actor = Actor.createActor<CooActor>(idlFactory, { agent, canisterId });
  // canister は caller (principal) 毎に会話履歴を蓄積し LLM コンテキストに使う。
  // 1 支払い = 独立した 1 問 1 答にするため、毎回 chat の前に自分の会話だけを消す
  // (per-caller なので他利用者の会話には影響しない)。
  await actor.clear_conversation();
  const result = await actor.chat(q);
  // Err は上流失敗として throw → route が settle せず 502 (未課金)
  if (!('Ok' in result)) throw new Error('coo-icp chat returned Err');

  return { answer: result.Ok };
};
