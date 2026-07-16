// coo-icp の会話状態が caller 毎かグローバルかを実験で判定する
// A = 匿名 identity (これまでのテストで chat 済み) / B = seed 由来の別 principal
import { createHash } from 'node:crypto';
import { Actor, AnonymousIdentity, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';

const CANISTER = '4wfup-gqaaa-aaaas-qdqca-cai';

const idlFactory = () =>
  IDL.Service({
    chat: IDL.Func([IDL.Text], [IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })], []),
    clear_conversation: IDL.Func([], [], []),
    get_conversation_history: IDL.Func(
      [],
      [IDL.Vec(IDL.Record({ content: IDL.Text, role: IDL.Text }))],
      ['query'],
    ),
    get_conversation_count: IDL.Func([], [IDL.Nat64], ['query']),
  });

async function actorFor(identity) {
  const agent = await HttpAgent.create({
    host: 'https://icp-api.io',
    identity,
    shouldFetchRootKey: false,
    shouldSyncTime: false,
    logToConsole: false,
  });
  return Actor.createActor(idlFactory, { agent, canisterId: CANISTER });
}

const summarize = (history) =>
  history.map((m) => `${m.role}: ${m.content.slice(0, 60)}`);

const A = await actorFor(new AnonymousIdentity());
const B = await actorFor(
  Ed25519KeyIdentity.generate(
    new Uint8Array(createHash('sha256').update('isolation-test-b').digest()),
  ),
);

const out = {};
out.count = String(await A.get_conversation_count());
out.historyA_before = summarize(await A.get_conversation_history());
out.historyB_before = summarize(await B.get_conversation_history());

// B で目印メッセージを送る
const marker = 'ISOLATION-TEST-MARKER-7391: just acknowledge briefly.';
const chatB = await B.chat(marker);
out.chatB = 'Ok' in chatB ? chatB.Ok.slice(0, 80) : { Err: chatB.Err };

out.historyB_afterChat = summarize(await B.get_conversation_history());
out.historyA_afterChatB = summarize(await A.get_conversation_history());

// B の会話を clear して、B と A の残り方を見る
await B.clear_conversation();
out.historyB_afterClear = summarize(await B.get_conversation_history());
out.historyA_afterClearB = summarize(await A.get_conversation_history());
out.count_after = String(await A.get_conversation_count());

console.log(JSON.stringify(out, null, 2));
