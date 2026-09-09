# x402-jpyc-gateway 設計ドキュメント

Status: final (Sonnet 調査 + Codex GPT-5.6 Terra xhigh 計画レビュー裁定済み — これが実装仕様)
Date: 2026-07-15

## 1. ゴール

OpenPay (open-pay.jp) の x402 ファシリテーターを使い、任意の上流 API を
「1 支払い = 1 リクエスト」で JPYC 課金化する汎用ゲートウェイ。
Next.js App Router (TypeScript)、Vercel にデプロイ可能。
第 1 アダプタは coo-icp (Internet Computer 上の Rust canister、Candid `chat : (text) -> (text)`)。

## 2. 非ゴール (やらないこと)

- 独自の価格/手数料ロジック — カタログ accepts が唯一の権威。価格・受取ウォレットは
  この repo の env に持たない (OpenPay 登録時に決まる)
- 会話の継続 (1 支払い = 独立した 1 問 1 答)
- coo-icp 本体の変更

## 3. ファイル構成と責務

```
lib/gate.ts               OpenPay 402 ゲート (公式スニペットの TS 化 + 2 変更)
lib/adapters/types.ts     Adapter = (input: { q: string }) => Promise<unknown>
lib/adapters/http.ts      汎用: UPSTREAM_URL に ?q= を付けて GET、JSON 中継
lib/adapters/coo-icp.ts   @icp-sdk/core (agent) で canister chat(text) を update call
lib/adapters/index.ts     env ADAPTER による選択 (coo-icp | http)
app/api/consult/route.ts  GET ハンドラ (処理順は §5)
app/layout.tsx, page.tsx  最小の説明ページ (無くてもよいが案内用に置く)
test/route.test.ts        ゲート+route の結合テスト (fetch/adapter 全モック)
test/coo-icp.test.ts      アダプタ単体 (Actor モック)
README.md                 セットアップ / env / デプロイ / 掲載手順 / curl 確認
```

## 4. OpenPay x402 契約 (最重要)

土台は OpenPay 公式配布の自己完結ゲート (仕様書に全文あり)。意味論を変えないこと:

- `GET https://open-pay.jp/api/discovery` → `{ items: [{ resource, accepts: [...] }] }`
- `MY_RESOURCE_URL` とカタログの `resource` が完全一致する item の accepts を採用、5 分キャッシュ
- カタログ未掲載なら **throw → 500** (bootstrap の意図された挙動。掲載プローブは 500 を
  「判定不能」として通す)
- 402 応答 body: `{ x402Version: 1, accepts, error }`
- verify/settle: `POST https://open-pay.jp/api/facilitator/{verify|settle}` に
  `{ x402Version: 1, paymentPayload, paymentRequirements: accepts[0] }`
  - verify 成功判定: `isValid === true` / 失敗理由 `invalidReason`
  - settle 成功判定: `success === true` / 失敗理由 `errorReason`
- 成功時レスポンスヘッダ `X-PAYMENT-RESPONSE` = base64(JSON.stringify(settle 結果))

### 公式スニペットに加える 2 変更 (これ以外は変えない)

1. **resource の動的差し替え**: 402 応答と verify/settle に渡す accepts の各要素について、
   `resource` フィールドのみを「実際のリクエスト URL (クエリ `?q=...` 込み)」に差し替える。
   ただし URL は `request.url` を鵜呑みにせず **`MY_RESOURCE_URL` (origin+path) + 実リクエストの
   クエリ文字列**から構築する (Host ヘッダ偽装・プロキシ経由の URL 揺れ対策。パスの正規化も兼ねる)。
   金銭フィールド (network / asset / payTo / maxAmountRequired 等) は**絶対に変更しない**。
   理由: 買い手は accept.resource と自分が叩いた URL の一致を検証する。金銭フィールドは
   カタログ掲載値と照合されるため、触らない限り改ざん検知と両立する。
2. **verify と settle の分離**: 公式は jpycGate() 内で連続実行するが、本実装では
   verify → (アダプタ実行) → settle の順に route が組めるよう別関数として公開する。

## 5. route の処理順 (買い手保護)

```
GET /api/consult?q=...
 0. acceptsFor(request.url) — カタログ未掲載なら 500 { error: 'accepts_unavailable' }
 1. X-PAYMENT ヘッダなし → 402 + accepts (q 検証より優先: 掲載プローブは q なし GET に 402 を期待)
 2. q なし (X-PAYMENT あり) → 400 (支払い処理前に返す = 未課金)
 3. X-PAYMENT の base64/JSON デコード失敗 → 402 invalid_payment_payload
 4. verify — isValid !== true → 402 (invalidReason)。settle もアダプタも呼ばない
 5. アダプタ実行 — throw → 502 { error: 'upstream_error' }。settle を呼ばない = 未課金
 5.5 アダプタ返り値をこの時点で JSON.stringify し、成功レスポンス body を**確定させる**。
     直列化失敗 (BigInt / 循環参照 / undefined 等) は上流失敗と同扱いで 502・settle しない。
     settle 成功後に throw しうるコードパスを残さないこと。
 6. settle — success !== true → 402 (errorReason)。回答は返さない
 7. 200 + (5.5 で確定済みの body) + X-PAYMENT-RESPONSE ヘッダ
```

- **全レスポンス** (402/400/500/502/200) に `Cache-Control: no-store` を付ける。
- facilitator への fetch 自体が throw した場合 (ネットワーク断・非 JSON 応答) は捕捉せず 500
  (= 判定不能)。OpenPay は EIP-3009 の一回限り authorization を使うため、買い手が同じ支払いを
  再試行しても二重課金にはならない (settle 済みなら再 settle は失敗する)。

この順は「客が払ったのに回答が無い」を構造的に防ぐ。settle 失敗時の上流呼び出し 1 回分は
店側損失として許容。

レスポンス body: アダプタ返り値をそのまま JSON 化 (coo-icp は `{ answer: string }` を返すので
実質 `{ answer, ... }`)。

## 6. アダプタ

- 選択: `ADAPTER` env (`coo-icp` がデフォルト / `http`)。未知値は throw → route が 502 に変換
  (verify 済み・未課金なので買い手に損は出ない)。
- `coo-icp`: IC 公式 JS SDK の HttpAgent + Actor。**パッケージは `@icp-sdk/core` を採用**
  (`@dfinity/agent` は 2025-08 以降 deprecated で `@icp-sdk/core` が公式後継。import は
  `@icp-sdk/core/agent` / `@icp-sdk/core/candid` 等のサブパス)。IDL は実 canister の
  candid:service メタデータ (2026-07-16 mainnet 実機確認) に合わせて
  `chat : (text) -> (variant { Ok : text; Err : text })` (update call)。
  Ok → `{ answer }`、Err → throw (route が 502・未課金)。
  canister は caller 毎 (`HashMap<Principal, ConversationState>`) に会話履歴を保持し LLM
  コンテキストに使うため (dwebxr/coo-icp lib.rs + mainnet 実験で確認 2026-07-16)、
  毎回 chat の前に `clear_conversation : () -> ()` を呼んで 1 問 1 答の独立性を保証する
  (per-caller 削除なので他利用者に影響なし)。匿名 principal の履歴は誰でも読めるため
  `IC_IDENTITY_SEED` の設定を強く推奨。並行リクエスト時の clear/chat 交錯による文脈混入は
  理論上残る (許容・README に明記)。
  - host = `IC_HOST` (default `https://icp-api.io`)、mainnet なので fetchRootKey しない
  - identity: `IC_IDENTITY_SEED` があれば sha256(seed) 32byte から Ed25519 決定的生成、
    無ければ匿名
  - 返り値: `{ answer: <chat の返す text> }`
- `http`: `UPSTREAM_URL` に `?q=` を付与して GET、`res.ok` でなければ throw、JSON を中継。

## 7. env (すべて Vercel の環境変数)

| 変数 | 必須 | 説明 |
|---|---|---|
| MY_RESOURCE_URL | ✔ | OpenPay /discovery に登録した URL と完全一致 (クエリなし) |
| ADAPTER | - | `coo-icp` (default) / `http` |
| COO_CANISTER_ID | coo-icp 時 ✔ | バックエンド canister ID |
| IC_HOST | - | default `https://icp-api.io` |
| IC_IDENTITY_SEED | - | 未設定なら匿名 identity |
| UPSTREAM_URL | http 時 ✔ | 中継先 |

価格・受取ウォレットは持たない (カタログが唯一の権威)。

## 8. テストマトリクス (vitest・fetch とアダプタは全モック)

route/gate (`test/route.test.ts`):
| # | 条件 | 期待 |
|---|---|---|
| 1 | X-PAYMENT なし (q あり/なし両方) | 402、accepts[].resource = 要求 URL、金銭フィールドはカタログ値のまま、x402Version=1 |
| 2 | X-PAYMENT が不正 base64/非 JSON | 402 invalid_payment_payload |
| 3 | X-PAYMENT あり・q なし | 400、facilitator 未呼出 |
| 4 | verify NG | 402 (invalidReason)、settle・アダプタ未呼出 |
| 5 | verify OK・アダプタ throw | 502、settle 未呼出 |
| 6 | settle NG | 402 (errorReason)、body に answer なし |
| 7 | 全部 OK | 200 + body + X-PAYMENT-RESPONSE = base64(settle JSON) |
| 8 | カタログ未掲載 | 500 (bootstrap 挙動) |

Codex レビュー採用分の追加ケース:
| 9 | verify OK・アダプタ返り値が JSON 直列化不能 (BigInt 等) | 502、settle 未呼出 |
| 10 | 全レスポンスに Cache-Control: no-store | 402/400/500/502/200 で確認 |
| 11 | verify/settle への送信 body 形状 | { x402Version:1, paymentPayload, paymentRequirements: <resource 差し替え済み accepts[0]> } |
| 12 | q が空文字 (`?q=`) | 400 扱い (欠落と同じ) |
| 13 | resource 差し替えが MY_RESOURCE_URL 基準 | リクエスト Host が異なっても resource は MY_RESOURCE_URL+query |

アダプタ (`test/coo-icp.test.ts`): Actor をモックし q → chat(q) → `{ answer }` の写像を確認。
canister ID / host / identity (匿名・seed) の受け渡しも確認。
http アダプタも fetch モックで: q のエンコード・非 2xx で throw・JSON 中継。

注意: モジュールレベルの accepts キャッシュはテスト間で `resetAcceptsCache()` によりリセット。

## 9. プライバシー

約束のスコープは「**このゲートウェイのアプリケーションログに残さない**」:
`console.*` 出力禁止、エラーレスポンスに q や支払い内容を含めない、@icp-sdk の
`logToConsole: false`、全レスポンス no-store。
構造上 q は OpenPay (resource URL 内)・上流 (coo-icp / UPSTREAM_URL)・プラットフォームの
アクセスログには渡りうる — この事実は README に明記する (約束を偽らない)。

## 10. ツールチェーン (Sonnet 調査 2026-07-15 で確定)

- **Next.js 16** (現行安定・Turbopack デフォルト・Node 20.9+ / TS 5.1+ 必須)。
  `next lint` は 16 で削除済みのため **ESLint 9 flat config + eslint-config-next を CLI 直叩き**
  (`eslint .`)。root layout (`app/layout.tsx`) は App Router で必須なので最小のものを置く。
- **`@icp-sdk/core` v6.0.0 (インストール済み・node_modules の実型定義で確認済み)**。
  Codex レビューで確定した実 API (これに厳密に従うこと):
  ```ts
  import { Actor, AnonymousIdentity, HttpAgent, type ActorMethod } from '@icp-sdk/core/agent';
  import { IDL } from '@icp-sdk/core/candid';
  import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
  // HttpAgent.create(options?): Promise<HttpAgent> — v6 では shouldFetchRootKey /
  // shouldSyncTime とも default false (mainnet の静的 root key 動作で正しい)。
  // logToConsole: false を明示 (プライバシー方針)。
  // Actor.createActor<T>(idlFactory, { agent, canisterId })
  // Ed25519KeyIdentity.generate(seed?: Uint8Array) — sha256(IC_IDENTITY_SEED) の 32byte で決定的生成
  // type CooActor = { chat: ActorMethod<[string], string> }
  ```
- **Vitest 4**。tsconfig paths (@/*) は vitest.config の手動 `resolve.alias` で解決
  (依存最小の方針のため vite-tsconfig-paths は入れない)。env は `vi.stubEnv` /
  `vi.unstubAllEnvs`、fetch は `vi.stubGlobal('fetch', ...)`。
- typecheck: `tsc --noEmit` / `eslint .` / `vitest run` / `next build` 全通過が完了条件

## 10.1 ライブ API 実地確認 (2026-07-15・curl で確認済みの事実)

`GET https://open-pay.jp/api/discovery` は実際に以下を返した (WebFetch は 403 だが curl は通る):

- トップレベル: `{ x402Version: 1, items: [...] }`
- item: `resource` / `description` / `category` / `priceJpyc` (文字列!) / `docsUrl` / `license` /
  `network` / `accepts` / `verifiedAt`
- accepts 要素: `scheme: 'exact'`, `network: 'eip155:137'` (CAIP-2), `maxAmountRequired`
  (atomic 文字列・価格+手数料 1 JPYC), `resource`, `description`, `mimeType`, `payTo`
  (= forwarder), `maxTimeoutSeconds: 600`, `asset` (JPYC v3 = 0xE7C3...c29, 18 decimals),
  `extra.openpay` (forwarder-split: merchant/merchantValue/feeReceiver/feeValue/commitVersion)
- 含意: accepts は v1/v2 混在の OpenPay 独自拡張だが、本ゲートは accepts を**不透明な
  オブジェクト**として扱い `resource` のみ差し替える設計なので影響なし。
  `PaymentRequirements` 型は open な record にしておくこと (フィールドを列挙して絞らない)。

## 11. README に必ず書くこと

1. セットアップ・env 表・Vercel デプロイ手順
2. 掲載手順: デプロイ (この時点で GET は 500 = 正常) → open-pay.jp/discovery で SIWE 接続し
   URL=MY_RESOURCE_URL・価格 (JPYC 整数)・説明 (英語推奨・"1 question per payment, returns
   {answer}" 等エージェント可読)・カテゴリ api・Docs URL・利用条件 → 正当性表明 → 登録
3. 掲載後 `curl -i $MY_RESOURCE_URL` が 402 + accepts を返す確認手順
4. 買い手テスト (Claude Desktop + openpay-x402-mcp / sdk) と、catalog trust が URL 完全一致の
   ため `?q=` 付き URL への支払いに買い手側 env `ALLOWED_HOSTS=open-pay.jp,<ゲートウェイの
   ホスト>` が必要な旨
5. 毎時自動再検証・確定違反 3 回連続で一時非表示 (修復で自動復帰) の説明
6. プライバシー方針 (ログを残さない)

## 12. 計画レビュー裁定 (Codex GPT-5.6 Terra xhigh, 2026-07-15)

採用: settle 前の直列化確定 (§5 の 5.5) / resource を MY_RESOURCE_URL 基準で構築 (§4) /
`eslint .` + flat config (`next lint` は Next 16 で削除) / 全レスポンス no-store /
http アダプタの timeout (`AbortSignal.timeout`) と `cache: 'no-store'` / discovery fetch の
`res.ok` 検査 (非 ok は throw → 500、意味論同一) / @icp-sdk/core v6 実 API (§10) /
プライバシー文言のスコープ修正 (§9) / テスト追加 (§8) / gate.ts 先頭コメントの
「Node 18+」→「Node 20.9+ (Next 16 要件)」修正。

却下 (理由付き):
- **accepts[0] 前提・5 分キャッシュを blocker とする指摘** — どちらも OpenPay 公式配布
  ゲートの意味論そのもの。本仕様は「2 変更以外は意味論を変えない」を最優先し、実カタログ
  でも accepts は 1 要素。前提として本書に明記して受容。
- **リプレイ/二重 settle 対策 (耐久ストア導入)** — OpenPay は EIP-3009 の一回限り
  authorization を使うためチェーンレベルで二重課金は不成立。並行リプレイで起きうるのは
  上流呼び出し 1 回分の無駄で、仕様が既に許容する店側損失と同クラス。依存最小方針を優先。
- **settle 判定不能時の復旧エンドポイント** — スコープ外。transport 例外は 500 のまま
  (公式ゲートと同じ)。再試行は EIP-3009 により安全。
- **単一飛行 (single-flight) キャッシュ更新** — サーバーレス・低トラフィックで利益が薄い。

## 13. dual-rail (JPYC + USDC/Base) 拡張 — 2026-08-24 設計デルタ

出典: ユーザー仕様 + cipherwebllc/openpay 実ソース裏取り (lib/x402/dualRailRelay.ts /
vanillaGate.ts / packages/x402-sdk/src/dualGate.mjs = 未公開 0.6.0 の参照実装)。
ゴール: 402 に JPYC+USDC 並記 + `PAYMENT-REQUIRED` ヘッダ、USDC は OpenPay リレー経由で
verify→upstream→settle の正順維持、USDC 面障害時は JPYC のみで継続、**JPYC 経路は不変更**。

### リレー契約 (ソース確認済み・本番 https://open-pay.jp)

- `GET /api/x402/relay/requirements?resourceId=<MY_RESOURCE_ID>` → 200:
  `{ resourceId, v1Accepts, v2Accept, paymentRequiredHeader }`。
  v1Accepts: `{ scheme:'exact', network:'base', maxAmountRequired:<atomic 6 桁>, resource:<登録URL>,
  description, mimeType, payTo:<出品者>, maxTimeoutSeconds:300, asset:<USDC>, extra }`。
  非 200 (404 resource_not_found / 404 not_found / 503 relay_unconfigured / 429) は
  **すべて「USDC 面なし」= null** (throw しない・null はキャッシュしない)。
- `POST /api/x402/relay/{verify|settle}` body:
  `{ resourceId, paymentHeader: <X-PAYMENT 生 base64> }` または
  `{ resourceId, paymentSignatureHeader: <PAYMENT-SIGNATURE 生値> }`。
  200 = facilitator 判定素通し (verify: `{isValid, invalidReason?, payer?}` /
  settle: `{success, transaction?, network?, payer?, errorReason?}`)。
  400 invalid_payment_payload・503 facilitator_unavailable (判定なし=課金なし)。
  **`isValid===true` / `success===true` 以外は解錠しない (fail-closed)**。

### gate.ts (追加のみ・既存関数 acceptsFor/verifyPayment/settlePayment/callFacilitator は不変更)

- `UsdcFace` 型: `{ resourceId: string; v1Accepts: PaymentRequirements;
  paymentRequiredHeader?: string; [k: string]: unknown }` (open record)。
- `usdcFace(): Promise<UsdcFace | null>` — `MY_RESOURCE_ID` 未設定なら即 null (段階ロールアウト)。
  requirements を 5 分キャッシュ。非 200 / JSON 不正 / v1Accepts 欠落 / fetch 例外 → null
  (キャッシュせず、復旧したら次リクエストで拾う)。
- `json402(accepts, error, paymentRequiredHeader?)` — 第 3 引数があれば `PAYMENT-REQUIRED`
  ヘッダ付与。既存呼び出しは無変更で動く。
- `relayPayment(path: 'verify'|'settle', headers: {paymentHeader?; paymentSignatureHeader?})`
  — 上記 POST、`r.json()` を返す (fetch/JSON 例外は投げっぱなし = route が 500 に変換)。
- `resetUsdcFaceCache()` (テスト用)。

### route.ts の処理順 (JPYC 経路のコードパスは既存のまま)

1. `accepts = acceptsFor(request.url)` — 失敗は従来どおり 500 (USDC 面があっても 500。
   参照実装は USDC-only 継続だが、bootstrap 500 の意味論維持を優先 — ユーザー仕様どおり)
2. `usdc = await usdcFace()` (null 許容)
3. `allAccepts = usdc ? [...accepts, usdc.v1Accepts] : accepts` — **accepts[0] は常に JPYC**
4. 以後の 402 はすべて `json402(allAccepts, error, usdc?.paymentRequiredHeader)`
5. 支払いヘッダ (X-PAYMENT / PAYMENT-SIGNATURE) が両方無い → 402 (掲載プローブ互換)
6. q なし/空 → 400 (支払い処理前・未課金)
7. レール判定 (参照実装 dualGate.mjs と同一):
   - `PAYMENT-SIGNATURE` あり → USDC v2 レール (生値を relay へ)
   - `X-PAYMENT` の decode 失敗 → 402 invalid_payment_payload (従来どおり・allAccepts で)
   - decode 成功で `payload.network === usdc.v1Accepts.network` ('base') → USDC v1 レール
     (**生の base64 文字列**を relay へ)
   - それ以外 → 既存 JPYC 処理そのまま。`usdc === null` なら常に JPYC
8. USDC レール: relay verify (`isValid!==true` → 402 invalidReason) → アダプタ実行+
   直列化確定 (失敗 502・settle しない) → relay settle (`success!==true` → 402 errorReason)
   → 200 + 確定済み body + `X-PAYMENT-RESPONSE: base64(JSON(settlement))`。
   relay fetch 例外は既存と同じ 500 (payment_verification_failed / payment_settlement_failed)
9. USDC accepts の金銭フィールド (payTo/amount/asset/resource) は**手で組まず返り値をそのまま**
   (参照実装も v1Accepts を無加工で並記。買い手スモークは resource 照合をしない)

### env / README

- `.env.example` に `MY_RESOURCE_ID=` (OpenPay 出品一覧の dual-rail スニペットに表示される ID。
  空なら JPYC のみ)。
- README「USDC (Base) 併売と x402 Bazaar 掲載」節: OpenPay 側 USDC 面有効化が前提 /
  `MY_RESOURCE_ID` 設定 / **最初の USDC 実購入 1 件が settle された時点で Bazaar 掲載確定** /
  USDC 売上は出品者アドレス直接着金 (OpenPay の USDC 側手数料 0%)。

### テスト追加 (fetch モック)

未払い 402 = [JPYC, USDC] 順 + PAYMENT-REQUIRED / MY_RESOURCE_ID 未設定 = 従来 1 件・リレー
未呼出 / requirements 404・例外 = JPYC のみに degrade / PAYMENT-SIGNATURE → relay verify→
adapter→relay settle 順で 200 + X-PAYMENT-RESPONSE・JPYC facilitator 未呼出 / X-PAYMENT
network='base' → USDC・'eip155:137' → JPYC (既存テスト無変更で通ること) / relay verify NG →
402+invalidReason・adapter 未実行 / adapter 失敗 → 502・settle 未呼出 / relay settle NG →
402+errorReason / requirements キャッシュ 5 分 (null は非キャッシュ)。

### やってはいけない

JPYC 経路 (accepts[0]・callFacilitator・verify→adapter→settle 順) の変更 / 判定 body 以外を
根拠に解錠 / USDC 面の失敗で JPYC を止める / 金銭フィールドの手組み。

## 14. ライセンス NFT 入場ゲート — 2026-09-09 設計デルタ

依存: `openpay-x402-sdk ^0.7.0` (公開確認済み・viem ^2.45 に依存 → テスト用 viem は
devDependencies に明記)。SDK の index.d.ts (実物確認済み) が正:
`hasLicense(LicenseIdentity & LicenseTransport & {address}) → {holder, balance, blockNumber}`
(RPC 失敗は `LicenseRpcError` throw)、`createLicenseGate({chainId, contract, tokenId, rpcUrl |
publicClient, origin, session:{secret(≥32B), ttlSeconds}}) → { challenge(addr)→Promise<string>,
verify({message, signature})→Promise<token>, check(token)→{address, tokenId, exp} (同期・throw
= LicenseError code invalid_session/session_expired 等) }`。tokenId は bigint | 0x hex。

### env (全部必須・欠落は fail-closed)

LICENSE_CHAIN_ID / LICENSE_CONTRACT / LICENSE_TOKEN_ID (0x hex) / LICENSE_PRODUCT_ID /
LICENSE_PRODUCT_URL / LICENSE_SESSION_SECRET (≥32 bytes・server-only・ログ禁止) /
POLYGON_RPC_URL。gate の origin は MY_RESOURCE_URL の origin から導出 (新 env 不要)。

### 裁定 (仕様の緊張点の解決)

1. **掲載プローブには従来どおり 402**: OpenPay の毎時再検証は 402 を要求し、403 は確定違反
   3 回で非表示になる。よって「支払いヘッダもセッションも無い素の GET」は 402 のまま。
   仕様の「ライセンスが無い相手に 402 を先に返さない」は次で満たす:
   (a) Bearer/cookie を提示したが無効・期限切れで**支払いヘッダも無い**相手 → 403
   (b) 支払いを携えた相手は verify で payer 確定後・**settle 前**に hasLicense、無保有なら
   403 (課金ゼロ)。402 の body に top-level `license: { required: true, product, contract,
   tokenId, chainId }` を追加して未保有者を購入ページへ誘導する (accepts は description 含め
   一切触らない — カタログ照合とドリフトさせない。掲載説明文は open-pay.jp 側で編集)。
2. **fail-closed は二段構え**: `instrumentation.ts` の register() で全 env を検証し欠落を
   列挙して throw (= `next start`/Vercel 起動時に明示失敗)。加えて lib/license の config は
   初回利用時にも同じ検証を行い 500 を返す (serverless cold start の defense)。module scope
   throw は `next build` とテストを壊すため使わない。**license env が全部未設定でも拒否**
   (仕様どおり)。既存デプロイは env 追加が必須になる — README に明記。
3. **既存テスト**: route テストの共通 beforeEach に license env スタブ + SDK モック
   (hasLicense=holder:true) を足すだけで、既存テスト本体は不変更のまま緑を維持する。

### 実装

- `lib/license.ts`: config 検証 (欠落列挙 throw・LICENSE_TOKEN_ID は ^0x[0-9a-fA-F]+ 検証・
  secret ≥32 bytes 検証)、`createLicenseGate` の遅延シングルトン (origin = MY_RESOURCE_URL
  origin・rpcUrl = POLYGON_RPC_URL)、`payerHasLicense(address)`: hasLicense を 60 秒メモリ
  キャッシュ (holder true/false ともキャッシュ・**LicenseRpcError はキャッシュせず re-throw**)、
  テスト用 reset。SDK からの import は型含め index.d.ts の実名どおり。
- `app/license/challenge/route.ts` GET `?address=0x…` → 400 (address 不正) /
  200 `{ message }` (gate.challenge)。no-store。
- `app/license/verify/route.ts` POST `{ message, signature }` → gate.verify 成功で
  200 `{ token, address, exp }` (check で読み出し) + `Set-Cookie: license_session=<token>;
  HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<ttl>`。LicenseError は code に応じ
  403 (no_license) / 400 (それ以外の検証系) / 503 (LicenseRpcError)。**署名・secret・token を
  ログに出さない** (console 禁止は継続)。
- `app/health/route.ts` GET → 200 `{ status:'ok', license: { required: true, chainId,
  contract, tokenId, productId, product } }` (公開情報のみ・no-store)。
- `app/api/consult/route.ts` の順序 (JPYC/USDC 両レール共通・x402 意味論は不変更):
  1. license config 検証 (欠落 → 500)
  2. Bearer / cookie があれば gate.check → 有効なら **licensed** (以降 hasLicense 省略)。
     無効/期限切れ + 支払いヘッダ無し → 403 license_required。無効でも支払いヘッダが
     あれば無視して次へ (payer 保有で救済)
  3. 支払いヘッダ無し → 402 (license フィールド付き・従来 accepts 不変)
  4. q 検証 400 → decode → レール判定 (既存)
  5. verify (既存どおり)。isValid true で **未 licensed なら**: payer を判定
     (`verification.payer` が string でなければ 503 license_check_unavailable・settle しない)
     → `payerHasLicense(payer)` false → 403 `{ error:'license_required', product, contract,
     tokenId }` (settle しない = 課金ゼロ)。LicenseRpcError → 503
     `{ error:'license_check_unavailable' }` (false 扱い禁止・settle しない)
  6. 以降は既存どおり: アダプタ + 直列化 → settle → 200
- `instrumentation.ts` (repo root): `export async function register()` で config 検証。
- 既知の制約 (README に明記): challenge/verify の nonce はインスタンス内メモリのため、
  serverless で別インスタンスに当たると invalid_nonce になり得る (リトライで解消。依存追加
  なしの範囲の制約。x402 支払者直接確認の経路 b は影響なし)。

### テスト

- 既存 route テスト: 共通セットアップに license env + SDK モック (holder true) を追加し
  全て緑のまま。
- 追加 (route): 保有あり → settle まで到達 / 保有なし → 403 license_required +
  settle・アダプタ未呼出 / LicenseRpcError → 503 + settle 未呼出 (JPYC・USDC 両レール) /
  payer 欠落 → 503 / 有効セッション (check モック) → hasLicense 未呼出で従量課金へ /
  無効トークン + 支払い無し → 403 / 素の GET → 402 + body.license / 60 秒キャッシュ
  (2 回目で hasLicense 1 回) / env 欠落 → 500 (欠落名は body に出さない)。
- `test/license.test.ts`: **実 SDK** の createLicenseGate に fake publicClient
  (getChainId/getBlockNumber/readContract で balance 1) を注入し、viem の
  privateKeyToAccount で challenge → signMessage → verify → check の一周を検証。
  challenge/verify HTTP route は SDK モックで配線を検証。
- 完了条件: typecheck / lint / test 全緑。**push は env 未設定の本番を壊すため保留**
  (ユーザーが Vercel に license env を設定してから)。

## 15. ライセンスゲート簡素化 (SDK 0.7.1「商品 ID 指定」) — 2026-09-09 設計デルタ

§14 の 7 変数版を、`openpay-x402-sdk ^0.7.1` (公開確認済み・viem ^2.45 のみ依存) の
商品 ID 指定 API に切り替える。x402 従量課金 (JPYC/USDC・402・verify→adapter→settle) は不変。

### SDK 0.7.1 実 API (index.d.ts 確認済み)

- `resolveLicense({ product, origin? }) → Promise<LicenseDescriptor>`:
  `{ version:1, productId, chainId:137|80002, contract, tokenId(Hex), productUrl, verifyUrl,
  saleActive, registered, transferable, termsUrl, termsVersion, supply, remaining, sellerRole }`。
  origin は HTTPS 必須 (既定 https://open-pay.jp)。リダイレクト拒否・product echo と tokenId
  導出を検証済みの信頼値。
- `hasLicense(LicenseSelector & LicenseTransport & { address })`: Selector は
  `{chainId, contract, tokenId}` (identity 形) または `{product, origin?}` (product 形)。
  RPC 失敗は `LicenseRpcError` (code 'rpc_error')。rpcUrl 未指定なら Polygon 既定 RPC。
- `createLicenseGate({ product, origin?, rpcUrl?, session: { secret, ttlSeconds?, origin? } })`:
  product 形では `origin` = descriptor の取得先 (open-pay.jp)、`session.origin` = このサービスの
  署名オリジン/audience。`ready()` が descriptor を解決・保持 (product 形)。`check()` は
  ready 前に LicenseError `not_ready` を throw。

### env (必須 2 つ・任意 2 つ)

| 変数 | 必須 | 意味 |
|---|---|---|
| LICENSE_PRODUCT_ID | ✔ | `h_` + 32 hex。形式検証 |
| LICENSE_SESSION_SECRET | ✔ | ≥32 UTF-8 bytes・server-only |
| POLYGON_RPC_URL | - | 未設定なら SDK の Polygon 既定 RPC |
| LICENSE_ORIGIN | - | descriptor 取得先。既定 https://open-pay.jp (HTTPS 必須) |

LICENSE_CHAIN_ID / LICENSE_CONTRACT / LICENSE_TOKEN_ID / LICENSE_PRODUCT_URL は**削除**
(descriptor から取得)。ゲートウェイ自身の署名オリジンは MY_RESOURCE_URL の origin。

### 起動 (fail-closed)

`lib/license.ts` に `ensureLicense(): Promise<LicenseRuntime>` — 単一飛行の Promise を
モジュールで保持: env 検証 → `resolveLicense({ product, origin })` → `createLicenseGate(...)`
+ `await gate.ready()` → `{ descriptor, gate, config }`。失敗時は保持 Promise を破棄して
throw (復旧したら次回再試行)。`instrumentation.ts` の `register()` で `await ensureLicense()`
= 起動時に明示失敗 (env 欠落・descriptor 取得失敗とも)。各 route も冒頭で `ensureLicense()`
を await し、失敗は 500 `{ error: 'license_unavailable' }` (generic・env 名/URL を出さない)。

### 保有判定 (裁定: identity 形を使う)

`payerHasLicense(address)` は **起動時 descriptor の `{chainId, contract, tokenId}` (identity
形) + rpcUrl?** で `hasLicense` を呼ぶ。理由: 仕様の product 形は毎回 open-pay.jp へ descriptor
を再取得するため、支払い判定経路に外部 HTTP 依存と別クラスの失敗 (network/http_error) が
増える。起動時に取得済みの信頼値を使えば判定は RPC だけに依存し、仕様の「起動時に取得して
保持」とも整合する。60 秒メモリキャッシュ (true/false)・`LicenseRpcError` は非キャッシュで
re-throw。既存の順序 (verify で payer 確定 → **settle 前**に判定 → 403 で課金ゼロ) は §14 のまま。

### レスポンス

- 403: `{ error: 'license_required', product: <LICENSE_PRODUCT_ID>, productUrl }`
- 503: `{ error: 'license_check_unavailable' }` (LicenseRpcError・payer 欠落・その他判定不能)
- 402 body の top-level `license`: `{ required: true, product, productUrl, chainId, contract,
  tokenId }` (accepts は description 含め不変 — §14 裁定 1 のまま。掲載プローブは 402 維持)
- `/health`: `{ status:'ok', license: { required:true, product, productUrl, chainId, contract,
  tokenId, saleActive } }`
- `/license/challenge`・`/license/verify`・Bearer/cookie 判定は §14 のまま (gate が product 形に
  なるだけ)。`check()` の `not_ready` は ensureLicense 後には起きないが、起きたら 503。

### README / .env.example

旧 7 変数の記述を削除し、2 必須 + 2 任意に置換。購入 → 接続 → 従量利用の流れと curl 手順は
維持。descriptor 取得失敗 = 起動失敗である旨を明記。

### テスト

- SDK モック: `resolveLicense` (descriptor fixture: chainId 137・contract・tokenId・productUrl)、
  `hasLicense`、`createLicenseGate` (ready→descriptor / check)。
- route: 保有あり → settle 到達 / 無保有 → 403 (product, productUrl) + settle・adapter 未呼出 /
  LicenseRpcError → 503 + settle 未呼出 / **resolveLicense 失敗 → ensureLicense reject =
  instrumentation register() が throw し route は 500** / hasLicense に渡る identity が
  descriptor 由来であること / 402 body.license に productUrl / 両レール。
- `test/license.test.ts`: 実 SDK の createLicenseGate を **identity 形 + fake publicClient** で
  一周 (product 形は open-pay.jp への HTTPS が必要なため単体では identity 形で検証)、
  route 配線は SDK モック。
- 既存 x402 テストは共通セットアップの env スタブを 2 変数に置換するだけで本体不変。
- 完了条件 typecheck / lint / test 全緑。push は保留 (feature ブランチ運用)。

### 計画レビュー裁定 (Codex GPT 6 Astra xHigh, 2026-09-09) — **以下が §15 の上書き確定版**

採用:
1. **descriptor は単一取得**: `resolveLicense({ product, origin })` を 1 回だけ呼び、その結果の
   identity `{chainId, contract, tokenId}` で **identity 形の** `createLicenseGate` を組む
   (product 形 gate + 別途 resolveLicense だと 2 回取得され不整合が起きうる — SDK 実装で確認)。
   `gate.ready()` は identity 形では IO なし (undefined) だが仕様どおり await する。
   保有判定・SIWE・/health・403 は全部この 1 つの descriptor から導出。
2. **起動 fail-closed は仕様どおり厳格** (env 不正・descriptor 取得失敗とも `register()` で
   throw)。ただし Next 16 は register の reject をキャッシュし `next start` では終了する、
   route-module 経路は register を await しない — という実装事実から、**復旧は「プロセス/
   インスタンスの再起動 (Vercel は次のコールドスタート)」であり、次リクエストでの自動復旧は
   保証されない**ことを README に明記する。各 route は `ensureLicense()` を await し、失敗は
   generic 500 `{ error: 'license_unavailable' }` (route 側の単一飛行 Promise は失敗時に破棄し
   再試行可能にする — register が await されないインスタンスでの防御)。
3. **鮮度ポリシー**: descriptor は **5 分**で期限切れ。期限後の最初のリクエストで単一飛行の
   再解決。identity 不変なら metadata (productUrl/saleActive 等) だけ更新し gate/nonce は
   維持。identity 変化 (contract/chain の再登録) なら runtime を原子的に差し替え、保有キャッシュ
   を無効化 (キャッシュ key は `chainId:contract:tokenId:address`)。**再解決に失敗したときは
   last-known-good を保持し 30 秒のクールダウン後に再試行** (descriptor 権威の一時障害で JPYC
   販売を止めない — tokenId は商品 ID に束縛され変化不能、contract 変更は協調移行イベント
   なので陳腐化リスクは限定的。dual-rail の「付帯面の障害で本体を止めない」と同じ判断)。
   リクエストごとに runtime を 1 回キャプチャして最後まで同じものを使う。
4. **エラー分類** (全 route 共通・body は固定文言のみ):
   初期化失敗 → 500 `license_unavailable` / `LicenseRpcError`・`nonce_store_error`・
   `not_ready` → 503 `license_check_unavailable` / `no_license` → 403
   `{ error:'license_required', product, productUrl }` (**/license/verify も同スキーマ**) /
   challenge・signature・nonce の検証失敗 (`invalid_challenge`, `challenge_expired`,
   `invalid_signature`, `invalid_nonce`) → 400 `license_verification_failed` /
   /api/consult の無効・期限切れセッションは従来どおり支払い payer 判定へフォールバック。
5. **product 形の実 SDK テストは可能** (`fetch` 注入 + fake publicClient) — identity 形に加えて
   product 形 gate の一周 (descriptor 検証・audience・not_ready・並行 ready で fetch 1 回・
   balanceOf 引数・同期 check) も実 SDK で検証する。テスト拡張: ensureLicense の並行呼出/失敗
   後の再試行成功/refresh と identity 変化時のキャッシュ無効化、discovery 4 エラー種、
   両レール (USDC v1 ヘッダ経路含む) の verify→license→adapter→settle 順、payer 欠落/不正、
   cookie セッション、期限切れ、無効セッション+支払いの救済、60 秒キャッシュ**期限切れ**
   (fake timers)、4 route の generic 初期化エラー + no-store。起動失敗テストは対象テスト内でのみ
   reject させ (register と route の両試行分)、afterEach で runtime/キャッシュ/モック実装を
   リセット (`vi.clearAllMocks` は履歴のみ)。
6. **nonce ストア制約の正確な記述**: インスタンスが異なると challenge を取り直しても解消
   しない場合がある (共有ストアなしでは保証不可・SDK の `nonceStore` で将来対応可能・依存追加
   なしの今回はスコープ外)。verify は RPC 前に nonce を消費するため RPC 失敗後は新しい
   challenge + 署名が必要。x402 payer 直接判定の経路は無影響。
7. 細部: `LICENSE_PRODUCT_ID` は `^h_[0-9a-f]{32}$` (小文字)。`MY_RESOURCE_URL` は session
   audience 用に引き続き必須。`saleActive`/`registered` は所有判定ではない (表示のみ)。
   `LICENSE_ORIGIN` を変えても SDK の検証は productUrl/verifyUrl が open-pay.jp 配下である
   ことを要求する。402 body の `license` 案内は初期化成功時のみ (fail-closed が優先)。

却下: なし (「register で discovery 失敗を握って routes だけ 500」の代替案は、仕様の
「取得失敗は起動失敗」を優先して不採用。ただし裁定 2 のとおり復旧セマンティクスは明記)。

## 16. 既存スキャフォールド

設計者 (Fable) が先行作成済み — 実装時はこれを土台に完成・修正してよい:
- package.json / tsconfig.json (スクリプト・paths 設定済み、依存は未インストール)
- lib/gate.ts (§4 をほぼ実装済み)
- lib/adapters/types.ts, lib/adapters/http.ts
