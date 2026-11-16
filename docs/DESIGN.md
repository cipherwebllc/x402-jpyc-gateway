# x402-jpyc-gateway 設計ドキュメント

Status: final (Sonnet 調査 + Codex GPT-5.6 Terra xhigh 計画レビュー裁定済み — これが実装仕様)
Date: 2026-07-15 (seller pin 対応: 2026-09-23、§15)

## 1. ゴール

OpenPay (open-pay.jp) の x402 ファシリテーターを使い、任意の上流 API を
「1 支払い = 1 リクエスト」で JPYC 課金化する汎用ゲートウェイ。
Next.js App Router (TypeScript)、Vercel にデプロイ可能。
第 1 アダプタは coo-icp (Internet Computer 上の Rust canister。0.7.0 以降の `send_message`、§18)。

## 2. 非ゴール (やらないこと)

- 独自の価格/手数料ロジック — 価格・手数料はカタログ accepts を使う。
  出品 ID と受取ウォレットは env に固定し、取得した決済条件を照合する (§15)。
- 会話の継続 (1 支払い = 独立した 1 問 1 答)
- coo-icp 本体の変更

## 3. ファイル構成と責務

2026-11-15 のフェーズ B (§19) で lib/gate.ts を責務ごとに分けた。それ以前の節に出てくる
`lib/gate.ts` / `myAccepts` は、いまの lib/listing.ts / lib/usdcFace.ts / lib/openpay.ts / lib/relay.ts を指す。

```
lib/types.ts              支払いのモジュールが共有する型 (sellerPins.ts もここから読む)
lib/http.ts               JSON 応答 (no-store) と 402 (x402Version 1) の組み立て
lib/openpay.ts            OpenPay の origin・決済条件の鮮度 (5 分 / 30 分)・時間切れつきの呼び出し・verify / settle の応答の読み分け (§20)・facilitator (JPYC)
lib/listing.ts            JPYC 出品 (discovery) のキャッシュと、resource だけを差し替えた accepts (acceptsFor)
lib/usdcFace.ts           USDC 面 (relay/requirements) のキャッシュ・Arc 面の扱い・PAYMENT-REQUIRED
lib/relay.ts              USDC relay の verify / settle (409 なら面を取り直して 402 requirements_mismatch)
lib/purchase.ts           GET / HEAD /api/consult の本体 (consult: 決済条件 → 支払いなしの 402 → q → choosePayment → verify 前の確かめ → 予約 → verify → 上流 (125 秒) → settle。consultHead: §20。予約: §21)
lib/claims.ts             同じ支払いを 2 回処理しないための、プロセスの中だけの予約 (§21)
lib/sellerPins.ts         必須設定・JPYC/USDC の seller pin 検証
lib/paymentHeader.ts      base64/JSON デコード (X-PAYMENT・USDC requirements は厳密、PAYMENT-SIGNATURE は relay と同じ規則)
lib/openapi.ts            x402scan 用の OpenAPI 文書。検証だけ共有し、OpenPay は支払いの経路と別に読む
instrumentation.ts        Next.js サーバー起動時の必須設定検査
lib/adapters/types.ts     Adapter = (input: { q: string }) => Promise<unknown>
lib/adapters/http.ts      汎用: UPSTREAM_URL に ?q= を付けて GET、JSON 中継
lib/adapters/coo-icp.ts   @icp-sdk/core (agent) で canister の clear_conversation → send_message を update call (§18)
lib/adapters/index.ts     env ADAPTER による選択 (coo-icp | http)
lib/adapters/catalog.ts   アダプタの名前ごとの設定の有無と、/openapi.json に載せる応答の schema (本体を読まない)
app/api/consult/route.ts  GET と HEAD のハンドラ (lib/purchase.ts の consult / consultHead を呼ぶ。処理順は §5)
app/openapi.json/route.ts GET ハンドラ (lib/openapi.ts の文書を返す・確認できなければ 404)
app/layout.tsx, page.tsx  最小の説明ページ (無くてもよいが案内用に置く)
test/route.test.ts        ゲート+route の結合テスト (fetch/adapter 全モック)
test/gate.test.ts         起動設定・出品 pin・キャッシュ・USDC 決済条件のテスト
test/purchase.test.ts     choosePayment の表と、同時に動く 2 件の支払いがそれぞれ verify → 上流 → settle を 1 回ずつ通ること
test/openpay.test.ts      OpenPay への呼び出しの時間切れ・verify / settle の応答の読み分け・ログに書く内容・HEAD (§20)
test/golden.test.ts       /api/consult と /openapi.json の挙動の固定 (§19。挙動を変える PR では、変えた場面だけを更新して差分を PR に書く)
test/openapi.test.ts      /openapi.json の形・404 の条件・/api/consult の 402 が変わらないこと
test/coo-icp.test.ts      アダプタ単体 (Actor モック)
README.md                 セットアップ / env / デプロイ / 掲載手順 / curl 確認
```

## 4. OpenPay x402 契約 (最重要)

土台は OpenPay 公式配布の自己完結ゲート。seller pin は SDK 0.10.0 に準拠 (§15):

- `GET https://open-pay.jp/api/discovery/<MY_RESOURCE_ID>` → `{ id, resource, accepts: [...] }`
- ID・`MY_RESOURCE_URL`・全 JPYC merchant・forwarder を照合してからキャッシュ (支払いあり 5 分・支払いなし 30 分。§16)。URL 検索は禁止
- 必須 pin 未設定は起動時の設定エラー。404 (未掲載/非公開) と 5xx (一時障害) は異なる
  エラー・ログにする。取得・照合失敗の HTTP 応答は従来の **500 accepts_unavailable**
- 402 応答 body: `{ x402Version: 1, accepts, error }`
- verify/settle: `POST https://open-pay.jp/api/facilitator/{verify|settle}` に
  `{ x402Version: 1, paymentPayload, paymentRequirements: accepts[0] }`
  - verify 成功判定: `isValid === true` / 失敗理由 `invalidReason`
  - settle 成功判定: `success === true` / 失敗理由 `errorReason`
- 成功時レスポンスヘッダ `X-PAYMENT-RESPONSE` = base64(JSON.stringify(settle 結果))

### 公式スニペットに加える 2 変更 (seller pin の追加要件は §15)

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
 0. acceptsFor(request.url) — 出品取得・pin 検証失敗なら 500 { error: 'accepts_unavailable' }
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
- **以下の coo-icp の記述は 0.6.0 までのもの。0.7.0 以降の契約は §18 が正。**
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
| MY_RESOURCE_ID | ✔ | 自分の出品 ID。前後の空白は不可。URL 検索へのフォールバックなし |
| EXPECTED_RECIPIENT | ✔ | 自分の JPYC 受取ウォレット。extra.openpay.merchant と照合 (forwarder ではない) |
| EXPECTED_USDC_RECIPIENT | - | 未設定・空なら JPYC のみ。設定時は OpenPay 側 USDC 面に登録した自分の受取先と照合 |
| ADAPTER | - | `coo-icp` (default) / `http` |
| COO_CANISTER_ID | coo-icp 時 ✔ | バックエンド canister ID |
| IC_HOST | - | default `https://icp-api.io` |
| IC_IDENTITY_SEED | coo-icp 時 ✔ | canister を呼ぶ identity の元。未設定なら 502 (§18) |
| UPSTREAM_URL | http 時 ✔ | 中継先 |

価格・手数料はカタログ値を使い、受取ウォレットは自分の設定で固定して照合する。
設定する受取先は `0x` + 40 桁の hex が必須。discovery 応答から pin を自動設定しない。
ゼロアドレス・`0x000000000000000000000000000000000000dead`・
`0xdead000000000000000000000000000000000000` は設定を拒否する。
起動時は全設定エラーをまとめて報告し、不正な値そのものはログに含めない。

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
| 8 | 出品未掲載/非公開・取得失敗 | 500 accepts_unavailable、404 と 5xx はログで区別 |

Codex レビュー採用分の追加ケース:
| 9 | verify OK・アダプタ返り値が JSON 直列化不能 (BigInt 等) | 502、settle 未呼出 |
| 10 | 全レスポンスに Cache-Control: no-store | 402/400/500/502/200 で確認 |
| 11 | verify/settle への送信 body 形状 | { x402Version:1, paymentPayload, paymentRequirements: <resource 差し替え済み accepts[0]> } |
| 12 | q が空文字 (`?q=`) | 400 扱い (欠落と同じ) |
| 13 | resource 差し替えが MY_RESOURCE_URL 基準 | リクエスト Host が異なっても resource は MY_RESOURCE_URL+query |

アダプタ (`test/coo-icp.test.ts`): §18 を参照 (canister の動きを模したモデルに対して確認する)。
http アダプタも fetch モックで: q のエンコード・非 2xx で throw・JSON 中継。

注意: モジュールレベルの accepts キャッシュはテスト間で `resetAcceptsCache()` によりリセット。

## 9. プライバシー

約束のスコープは「**質問・回答・支払いデータをこのゲートウェイのアプリケーションログに残さない**」:
設定不足・出品取得失敗・pin/決済条件の不一致は固定の理由だけを `console.error` に記録する。
ログとエラーレスポンスに q・回答・支払い内容・ウォレットアドレス・リソース URL を含めない。
@icp-sdk の `logToConsole: false`、全レスポンス no-store。
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

以下は旧カタログ API の調査記録。現在のゲートは §4 の ID 指定 API を使う。
`GET https://open-pay.jp/api/discovery` は当時以下を返した (WebFetch は 403 だが curl は通る):

- トップレベル: `{ x402Version: 1, items: [...] }`
- item: `resource` / `description` / `category` / `priceJpyc` (文字列!) / `docsUrl` / `license` /
  `network` / `accepts` / `verifiedAt`
- accepts 要素: `scheme: 'exact'`, `network: 'eip155:137'` (CAIP-2), `maxAmountRequired`
  (atomic 文字列・価格+手数料 1 JPYC), `resource`, `description`, `mimeType`, `payTo`
  (= forwarder), `maxTimeoutSeconds: 600`, `asset` (JPYC v3 = 0xE7C3...c29, 18 decimals),
  `extra.openpay` (forwarder-split: merchant/merchantValue/feeReceiver/feeValue/commitVersion)
- 含意: accepts は v1/v2 混在の OpenPay 独自拡張。現在は §15 の seller pin を検証し、
  `resource` のみ差し替える。金銭フィールドは書き換えない。
  `PaymentRequirements` 型は open な record にしておくこと (フィールドを列挙して絞らない)。

## 11. README に必ず書くこと

1. セットアップ・env 表・Vercel デプロイ手順
2. Deploy ボタンの掲載手順: 仮 pin でデプロイ (設定エラー・全ルート 500 は想定どおり)
   → 実 URL を取得 → open-pay.jp/discovery で SIWE 接続し
   URL=MY_RESOURCE_URL・価格 (JPYC 整数)・説明 (英語推奨・"1 question per payment, returns
   {answer}" 等エージェント可読)・カテゴリ api・Docs URL・利用条件 → 正当性表明 → 登録
   → 実 URL・自分の出品 ID・JPYC 受取先を env に設定 → 再デプロイ (USDC 受取先は任意)。
   カスタムドメインや重複しないプロジェクト名で URL が確定する場合は掲載から始められる。
3. 掲載後 `curl -i $MY_RESOURCE_URL` が 402 + accepts を返す確認手順
4. 買い手テスト (Claude Desktop + openpay-x402-mcp / sdk) と、catalog trust が URL 完全一致の
   ため `?q=` 付き URL への支払いに買い手側 env `ALLOWED_HOSTS=open-pay.jp,<ゲートウェイの
   ホスト>` が必要な旨
5. 毎時自動再検証・確定違反 3 回連続で一時非表示 (修復で自動復帰) の説明
6. プライバシー方針 (固定の設定・取得・pin 検証エラーだけをログに記録)
7. 自動デプロイの merge 前に本番の必須 pin を設定し、USDC 継続時は任意の USDC pin も設定する。
   受取先変更は OpenPay 側と env を揃えて再デプロイし、切替途中の pin 不一致は 500 を想定する。

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
verify→upstream→settle の正順維持、USDC 面の可用性障害時は JPYC のみで継続。
2026-09-23 追記: pin/決済条件の不一致は両レールを停止する (§15)。

### リレー契約 (ソース確認済み・本番 https://open-pay.jp)

- `GET /api/x402/relay/requirements?resourceId=<MY_RESOURCE_ID>` → 200:
  `{ resourceId, v1Accepts, v2Accept, paymentRequiredHeader }`。
  v1Accepts: `{ scheme:'exact', network:'base', maxAmountRequired:<atomic 6 桁>, resource:<登録URL>,
  description, mimeType, payTo:<出品者>, maxTimeoutSeconds:300, asset:<USDC>, extra }`。
  非 200 (404 resource_not_found / 404 not_found / 503 relay_unconfigured / 429) は
  **すべて「USDC 面なし」= null** (throw しない・null はキャッシュしない)。
- `POST /api/x402/relay/{verify|settle}` body:
  `{ resourceId, paymentRequirements: <検証済み v1Accepts>, paymentHeader: <X-PAYMENT 生 base64> }` または
  `{ resourceId, paymentRequirements: <検証済み v1Accepts>, paymentSignatureHeader: <PAYMENT-SIGNATURE 生値> }`。
  409 は決済条件変更: キャッシュ破棄、その場で再取得・pin 検証、
  新しい USDC 条件と PAYMENT-REQUIRED を含む 402 requirements_mismatch。元の支払いは再送しない。
  再取得不能・pin 不一致なら既存の 500 wrapper で停止する。
  200 = facilitator 判定素通し (verify: `{isValid, invalidReason?, payer?}` /
  settle: `{success, transaction?, network?, payer?, errorReason?}`)。
  400 invalid_payment_payload・503 facilitator_unavailable (判定なし=課金なし)。
  **`isValid===true` / `success===true` 以外は解錠しない (fail-closed)**。

### gate.ts (seller pin 対応後の契約)

- `UsdcFace` 型: `{ resourceId: string; v1Accepts: PaymentRequirements;
  v2Accept: PaymentRequirements; paymentRequiredHeader: string; [k: string]: unknown }` (open record)。
- `usdcFace(options?: { forPayment?: boolean }): Promise<UsdcFace | null>` — 必須 pin を検査。EXPECTED_USDC_RECIPIENT が未設定・空なら
  cache を使わず fetch もせず null。設定時は検証済み requirements のみキャッシュ (支払いあり 5 分・支払いなし 30 分。§16 訂正)。
  非 2xx / JSON 読み取り失敗 / fetch 例外 → null (非キャッシュ)。404 は確定した結果として同じ resourceId の
  キャッシュも消す (§16 訂正)。
  取得できた値の ID・全受取先・決済条件の不一致や欠落 → throw、両レールを停止 (§15)。
- `json402(accepts, error, paymentRequiredHeader?)` — 第 3 引数があれば `PAYMENT-REQUIRED`
  ヘッダ付与。既存呼び出しは無変更で動く。
- `relayPayment(path: 'verify'|'settle', headers: {paymentHeader?; paymentSignatureHeader?}, face: UsdcFace, jpycAccepts)`
  — 上記 POST、通常は `r.json()`、409 は再検証済みの 402 Response を返す。
  USDC pin 未設定なら送信を拒否。fetch/JSON/再検証の例外は route が 500 に変換。
- `resetUsdcFaceCache()` — テストと relay 409 経路で使う。進行中の取得も無効化する (§16 訂正)。

### route.ts の処理順 (JPYC 経路のコードパスは既存のまま)

1. `accepts = acceptsFor(request.url)` — 失敗は従来どおり 500 (USDC 面があっても 500。
   このゲートでは JPYC 出品取得・pin 検証を必須とする)
2. `usdc = await usdcFace()` (USDC 無効・可用性障害の null は許容、pin 検証失敗は 500 accepts_unavailable)
3. `allAccepts = usdc ? [...accepts, usdc.v1Accepts] : accepts` — **accepts[0] は常に JPYC**
4. 通常の 402 は `json402(allAccepts, error, usdc?.paymentRequiredHeader)`。
   relay 409 では JPYC snapshot + 再取得した USDC 面で 402 を返す。
5. 支払いヘッダ (X-PAYMENT / PAYMENT-SIGNATURE) が両方無い → 402 (掲載プローブ互換)
6. q なし/空 → 400 (支払い処理前・未課金)
7. レール判定:
   - USDC 面あり、`PAYMENT-SIGNATURE` あり → USDC v2 レール (生値を relay へ)
   - `X-PAYMENT` の decode 失敗 → 402 invalid_payment_payload (従来どおり・allAccepts で)
   - decode 成功で `payload.network === usdc.v1Accepts.network` ('base') → USDC v1 レール
     (**生の base64 文字列**を relay へ)
   - USDC 面なしの場合、PAYMENT-SIGNATURE または Base/Base Sepolia network の支払いは
     402 payment_invalid。relay/facilitator/上流を呼ばない。その他は既存 JPYC 処理。
8. USDC レール: relay verify (`isValid!==true` → 402 invalidReason) → アダプタ実行+
   直列化確定 (失敗 502・settle しない) → relay settle (`success!==true` → 402 errorReason)
   → 200 + 確定済み body + `X-PAYMENT-RESPONSE: base64(JSON(settlement))`。
   relay 409 の 402 Response はそのまま返し、支払いも上流処理も自動再実行しない。
   relay fetch・再取得・再検証の例外は既存と同じ 500 (payment_verification_failed / payment_settlement_failed)
   (§20 で変更: relay の応答なし・読めない応答は 503 `payment_service_unavailable` / 500 `settlement_unknown`。
   この 2 つの 500 が残るのは、送る前の pin の不一致と、409 のあとの再取得・再検証の失敗だけ)
9. USDC accepts の金銭フィールド (payTo/amount/asset/resource) は**手で組まず返り値をそのまま**
   (参照実装も v1Accepts を無加工で並記。買い手スモークは resource 照合をしない)

### env / README

- `.env.example` の `MY_RESOURCE_ID`・`EXPECTED_RECIPIENT` は必須。
  `EXPECTED_USDC_RECIPIENT` は任意で、未設定・空なら USDC を取得・提示・受付しない。
- README「USDC (Base) 併売と x402 Bazaar 掲載」節: OpenPay 側 USDC 面有効化が前提 /
  `MY_RESOURCE_ID` と `EXPECTED_USDC_RECIPIENT` の照合 / **最初の USDC 実購入 1 件が settle された時点で Bazaar 掲載確定** /
  USDC 売上は出品者アドレス直接着金 (OpenPay の USDC 側手数料 0%)。

### テスト追加 (fetch モック)

USDC 有効時の未払い 402 = [JPYC, USDC] 順 + PAYMENT-REQUIRED / 必須 pin 未設定 = 起動失敗・fetch 未呼出 /
USDC pin 未設定 = JPYC のみ・USDC fetch/支払い未実行 /
requirements 404・例外 = JPYC のみに degrade / PAYMENT-SIGNATURE → relay verify→
adapter→relay settle 順で 200 + X-PAYMENT-RESPONSE・JPYC facilitator 未呼出 / X-PAYMENT
network='base' → USDC・'eip155:137' → JPYC (必須 pin を fixture に設定) / relay verify NG →
402+invalidReason・adapter 未実行 / adapter 失敗 → 502・settle 未呼出 / relay settle NG →
402+errorReason / requirements キャッシュ 5 分 (null は非キャッシュ)。

### やってはいけない

JPYC 経路の処理順 (accepts[0]・verify→adapter→settle) の変更 / 判定 body 以外を
根拠に解錠 / USDC 面の可用性障害で JPYC を止める / pin 不一致を握りつぶす / 金銭フィールドの手組み。

## 14. 既存スキャフォールド

設計者 (Fable) が先行作成済み — 実装時はこれを土台に完成・修正してよい:
- package.json / tsconfig.json (スクリプト・paths 設定済み、依存は未インストール)
- lib/gate.ts (§4 をほぼ実装済み)
- lib/adapters/types.ts, lib/adapters/http.ts

## 15. Seller pin — B12 P0 対応 (2026-09-23)

参照: OpenPay PR #567、openpay-x402-sdk 0.10.0 の sellerPins.mjs / gate.mjs / dualGate.mjs、
lib/x402/paywallSnippet.ts、app/api/discovery/[id]/route.ts。

- 同じ URL の攻撃者出品が newest-first の先頭に来る問題を防ぐため、ID 指定取得のみを使う。
  応答の ID と MY_RESOURCE_URL を完全一致で照合する。URL 一致検索へのフォールバックは禁止。
- Next.js instrumentation.register で起動時に必須設定を検査。要求ごとにも cache 利用前に検査する。
  ID の前後の空白・不正な受取先・ゼロ/既知の burn アドレスを拒否し、設定エラーはまとめて報告。
  EXPECTED_USDC_RECIPIENT は任意。未設定・空なら USDC は取得・提示・受付しない。
- JPYC: 全 accepts の extra.openpay.merchant を EXPECTED_RECIPIENT と照合し、
  mode=forwarder-split・有効な forwarder アドレス・payTo=forwarder を検証する。
- USDC: 設定時のみ resourceId・v1Accepts・v2Accept・PAYMENT-REQUIRED 内の全 accepts の受取先を検証。
  PAYMENT-REQUIRED は買い手ヘッダと共通の厳密な base64/JSON デコーダで検査する。
  base / base-sepolia と eip155:8453 / eip155:84532 の対応、asset・scheme・amount の整合性も検証する。
  アドレス比較は大文字小文字を区別しない。検証失敗は固定の理由をログに残して停止する。
- 検証前に 402 を返さず、キャッシュせず、verify / settle / 上流処理を行わない。
  キャッシュ (支払いあり 5 分・支払いなし 30 分。§16) は pin を再検証して使う。verify / settle 直前にも受取先を照合する。
- USDC relay にはそのリクエストの検証済み v1Accepts を送信し、別リクエストの cache 更新で
  決済条件を差し替えない。409 は cache を破棄して即再取得・再検証し、
  新条件の 402 requirements_mismatch を返す。再取得/再検証失敗時だけ 500。自動再送しない。
- テスト: 同一 URL の別出品、ID/URL/recipient/forwarder 不一致、未設定/不正 pin、
  404 対 5xx・不正 JSON のログ、USDC の全表現/不正 base64、cache の拒否・有効期限・pin 変更、
  USDC 無効時の受付拒否、relay 409 の新条件・再検証・再送なし、M5 (facilitator 直前)・M8 (merchant 欠落)。


### 受容した制限 (レビュー nit 13)

JPYC の `merchantValue` / `feeValue` / `feeReceiver` / `asset` / `network` は、SDK 0.10.0 と同様、
このゲートで独立した設定値との固定照合を行わない。価格・手数料・通貨/チェーンの値は OpenPay の
掲載情報に依存する。B12 の「同じ URL に別の受取先を登録する」攻撃は出品 ID と merchant pin で
防ぐが、OpenPay 自体が侵害された場合のこれらのフィールドの改変までは防がない。
この範囲は今回の修正対象外として受容する。forwarder の形式・mode・payTo との整合性、および
USDC の各表現間の network/asset/scheme/amount の整合性の検査は引き続き行う。

## 16. 出品情報キャッシュの 2 段 TTL (2026-10-02)

目的: OpenPay の `GET /api/discovery/<resourceId>` (OpenPay 側 KV を 1 回 3 コマンド消費) の
呼び出し回数を減らす。現状はクローラーの 402 確認のたびに 5 分おきに取り直している。

### 変更 (lib/gate.ts の myAccepts / acceptsFor と app/api/consult/route.ts のみ)

- キャッシュ許容時間を 2 段にする:
  - **支払いヘッダあり** (`X-PAYMENT` または `PAYMENT-SIGNATURE`): 従来どおり **5 分**以内の
    掲載情報だけを使う (古ければ取り直す)。
  - **支払いヘッダなし** (402 を返すだけ): **30 分**以内ならキャッシュを使う。
- `acceptsFor(requestUrl, { forPayment })` — 第 2 引数は必須にせず、省略時は
  `forPayment: true` (= 厳しい側の 5 分) とする (安全側の既定)。
  `myAccepts(maxAgeMs)` に TTL を渡す。定数は `PAYMENT_LISTING_TTL_MS = 5 * 60_000` /
  `PROBE_LISTING_TTL_MS = 30 * 60_000`。
- route.ts は**支払いヘッダの有無を先に読み**、`forPayment = Boolean(X-PAYMENT) ||
  PAYMENT-SIGNATURE !== null` (既存の「支払いヘッダなし → 402」判定と同じ式) を渡す。
  それ以外の処理順・レスポンスは不変。
- キャッシュの時刻は 1 つ (取得の**開始**時刻・コードレビュー裁定 2) のまま。支払いリクエストが取り直せば、その結果は
  支払いなしリクエストにも使われる。

### 変えないこと (不変条件)

- `validateJpycListing` (出品 ID と受取先 pin の検証) は**キャッシュ利用時も毎回**通す。
- 失敗 (404・5xx・通信失敗・JSON 不正・検証失敗) はキャッシュしない。取り直しが失敗しても
  既存の検証済みキャッシュは上書きしない (従来どおり。**404 だけは例外でキャッシュを消す**・計画レビュー裁定 3) — その支払いリクエスト自体は
  従来どおり 500 `accepts_unavailable` で fail-closed。
- accepts の金額・受取先・asset 等の金銭フィールドには触らない。
- ~~`usdcFace` は OpenPay の KV を使わないので変更しない (5 分)。~~ → **誤り。usdcFace も同じ 2 段 TTL にする** (末尾の「訂正」小節)。
- verify / settle に渡す requirements は支払いリクエスト時点で 5 分以内の掲載値
  (= 従来と同じ鮮度保証)。

### 既知の帰結 (PR に明記)

掲載内容 (価格等) を OpenPay 側で変更した場合、支払いなしの 402 が新しい値になるまで最大
30 分かかる (従来は最大 5 分)。支払い経路は 5 分以内の値で verify するため金銭的な不整合は
起きないが、catalog trust を使う買い手 SDK は「402 の accepts とカタログ掲載値の不一致」を
検出して支払いを拒否するため、変更直後の最大 30 分は購入が成立しにくい。即時反映が必要な
ときは再デプロイ (インスタンス再起動) でキャッシュが消える。

### テスト (fake timers・fetch モック)

1. 初回取得から 30 分以内の支払いなしリクエストは discovery を fetch しない。
2. 30 分を過ぎた支払いなしリクエストは取り直す。
3. 支払いありのリクエストは、キャッシュが 5 分を過ぎていれば取り直し、5 分以内なら
   取り直さない (X-PAYMENT と PAYMENT-SIGNATURE の両方)。
4. 検証に失敗した掲載はキャッシュされない (次のリクエストで再取得)。
5. キャッシュ利用時も validateJpycListing が毎回通る (キャッシュ後に pin の env を変えると
   fetch なしで拒否される)。
6. 取り直し失敗 (5xx) は既存キャッシュを壊さない (その後の 30 分以内の支払いなしリクエストは
   fetch なしで 402)。
7. 既存テストは全て緑のまま。

### 計画レビュー裁定 (Fable 5.1, 2026-10-02) — 以下が §16 の確定版

レビュー結論: 機構 (2 段 TTL・取得時刻は 1 つ・省略時 5 分・失敗非キャッシュ) は変更不要。
JPYC の verify / settle に渡る requirements は、route が 5 分 tier で取った `accepts[0]` だけ。
USDC の verify / settle に渡るのは別キャッシュ (`usdcFace`・訂正後は同じ 2 段 TTL で支払いは 5 分) の `face.v1Accepts` で、
discovery の掲載値は 402 本文にしか使わない。支払いヘッダなしのリクエストは 402 を返して終わる
ため、30 分の値が金銭経路に乗る道はない。ここでいう鮮度は**リクエスト時点**の鮮度 (従来どおり)。
上流処理の後の settle 時点で 5 分を超えることはありうる (verify と settle は同じ条件で行う必要が
あり、途中で条件を差し替えない)。
ただしその安全性は次の暗黙の前提に依存しているので、明文化してテストで固定する。

採用:
1. **キャッシュヒットで `acceptsCachedAt` を更新しない**。代入は `validateJpycListing` 成功直後の
   1 箇所だけ。(使うたびに時刻を伸ばすと、クローラーの 402 確認が続く限り支払いも古い値で
   verify されてしまう。) これは §12 の「5 分は公式意味論」からの意図的な逸脱で、逸脱の範囲は
   「支払いヘッダなしの 402 応答に使う掲載値」だけ。
2. **route は `hasPayment` を 1 回だけ計算**し、`acceptsFor(url, { forPayment: hasPayment })` と
   `if (!hasPayment) return 402` の両方をその 1 変数から導出する (2 つの式を別々に書くと将来
   ずれうるため)。`X-PAYMENT: ""` は支払いなし扱い、`PAYMENT-SIGNATURE: ""` は支払いあり扱いで、
   既存の 402 ゲートと一致する。
3. **失敗時は `acceptsCache` / `acceptsCachedAt` に触れない** (5xx・通信失敗・JSON 不正・検証失敗)。
   その支払いリクエスト自体は従来どおり 500 `accepts_unavailable` で verify / settle に進まない。
   結果として、取り直しに失敗した後も 30 分以内の支払いなしリクエストは、最後に検証済みの
   掲載値 (毎回 pin 再検証つき) で 402 を返す。
   **例外: 404 だけはキャッシュを破棄する** (Opus 5.5 裁定)。404 は「出品が削除・非公開・
   一時非表示」の確定シグナルで、残すと最大 30 分、購入できない出品の 402 を広告し続ける。
   破棄しても金銭面の影響はなく、404 が続く間の挙動は今日の TTL 切れ後と同じ。
4. テスト A〜H を追加 (下記)。
5. 「既知の帰結」に追記: キャッシュは Vercel のインスタンス単位なので、削減効果はインスタンス数で
   薄まり、コールドスタートでは取り直す。PR の確認事項として「OpenPay facilitator が金額の厳密一致
   を要求するか」(値下げ直後に非 SDK 買い手が旧金額で署名した場合の過払い防止・5 分窓でも既存の
   論点) と「毎時再検証が 402 の accepts と掲載値を比較するか」(比較するなら変更後 30 分以内に
   1 回違反になりうる・3 回連続には届かない) を挙げる。
6. README / DESIGN の「5 分キャッシュ」文言と gate.ts のコメントを 2 段 TTL に合わせる。

不採用:
- `Cache-Control: no-cache` 付きの支払いなし GET を 5 分 tier に倒す緩和策 — ユーザー仕様が
  支払いなしの扱いを明確に定めており、即時反映が必要なときは再デプロイで足りるため今回は
  見送る (PR に将来案として記載)。

追加テスト (既存の `Date.now` スパイ方式に揃え、fake timers は混在させない):
- A (gate) インターリーブ: t=0 支払いなしで取得 → t=29 分 支払いなし (fetch なし) → 直後の
  支払いあり → fetch される。
- B (route) t=0 に支払いなしで旧価格の 402 → discovery を新価格に差し替え → t=10 分の
  支払いなしは旧価格の 402 (fetch なし) → t=10 分の支払いあり → facilitator の verify / settle
  に渡る `paymentRequirements.maxAmountRequired` が新価格。
- C (route) B の続き: その直後の支払いなしが新価格の 402 を返し、fetch しない。
- D (route) `X-PAYMENT: ""` は t=10 分で fetch せず 402 / `PAYMENT-SIGNATURE: ""` は t=10 分で
  discovery を取り直す。
- E (route) ~~usdcFace 不変: t=10 分の支払いなしで `/relay/requirements` は取り直す~~ →
  訂正により逆転: 支払いなしは 30 分以内なら `/relay/requirements` も取り直さない。
- F (route) 支払いありの取り直しが 5xx → そのリクエストは 500 `accepts_unavailable` で
  verify / settle 未呼出 → その後 30 分以内の支払いなしは fetch なしで 402。
- G (gate) 30 分境界: 29 分 59.999 秒はヒット、30 分ちょうどで取り直す。
- H (gate) 30 分 tier でも pin 再検証: t=10 分、`EXPECTED_RECIPIENT` 変更後の支払いなしが fetch
  なしで拒否される。
- 404 でキャッシュ破棄: 支払いありの取り直しが 404 → その後の支払いなし (30 分以内) は再取得する。

### コードレビュー裁定 (Codex GPT 6 Astra xHigh・読むだけ, 2026-10-02)

採用 (修正済み):
1. **404 破棄と並行取得の競合 (今回の変更で新規)**: 遅れて届いた古い成功応答が削除済みの出品を
   書き戻す / 遅れて届いた古い 404 が新しい成功を消す、の両方向。→ discovery 取得ごとに順序番号を
   振り、**後から開始した取得の結果だけを反映**する (完了順は問わない)。反映済みより古い取得の
   成功応答は、自分の値ではなく反映済みのキャッシュに従う (キャッシュが無ければ拒否)。404 は
   同じ出品 ID のキャッシュだけを消す。`resetAcceptsCache()` は進行中の取得も無効化する。
2. **遅い応答が新しい値を上書きし寿命をリセットする (既存・30 分化で影響拡大)**: 1 の順序番号で
   上書きを防ぎ、加えてキャッシュ時刻を**取得の開始時刻**で記録する。取得に許容年齢 (支払いあり
   5 分) 以上かかった応答はそのリクエストで使わず、キャッシュもしない。
3. テストの抜け: 保留中の fetch で完了順を操作する競合テスト (両方向)・遅い古い応答・開始時刻基準・
   許容年齢超えの拒否、USDC v1 の 5 分 tier、値段変更テストの verify / settle 呼び出し回数の厳密化。
4. 文書: JPYC と USDC の経路を分けて記述し、鮮度はリクエスト時点であることを明記 (上の裁定本文)。

不採用 (既存の性質・PR の確認事項に記載):
- **settle 時点での 5 分超過** — 鮮度保証はリクエスト時点 (ユーザー仕様の「今までどおり」)。
  上流処理 (coo-icp は数秒) の後に settle を打ち切ると、回答を作った後で決済を捨て、境界付近の
  正当な購入を失敗させる。verify と settle は同じ条件で行う必要があり差し替えられない。
- **サーバー時計の巻き戻し** — `usdcFace` を含む既存キャッシュ全体の性質で、直すなら単調時計への
  移行 (今回の範囲外・今後の課題)。Vercel の実行環境は NTP 同期で、大きな巻き戻しは想定しにくい。

### 訂正: usdcFace も 2 段 TTL にする (2026-10-02・ユーザー指示)

前提の訂正: `GET /api/x402/relay/requirements` (usdcFace) も OpenPay 側の KV を 1 回 3 コマンド
消費する。§16 冒頭の「usdcFace は KV を使わないので変えない」は誤りで、**myAccepts と同じ 2 段
キャッシュにする** (支払いヘッダありは 5 分・なしは 30 分・検証は毎回・失敗はキャッシュしない)。

注意: USDC の verify / settle に渡る条件 (`face.v1Accepts`) は**このキャッシュそのもの**である
(relayPayment が `paymentRequirements: face.v1Accepts` を送る)。したがって myAccepts に入れた
並行取得の保護 (コードレビュー裁定 1・2) も同じように入れる。

設計 (Opus 5.5):
- `usdcFace(options: { forPayment?: boolean } = {})` — 省略時は支払い扱い (5 分)。route は
  `usdcFace({ forPayment: hasPayment })`。relayPayment の 409 経路 (`resetUsdcFaceCache()` の後の
  `usdcFace()`) は支払いの文脈なので省略 (= 5 分) のまま。
- ヒット時は今までどおり `validateUsdcFace` を毎回通し、`structuredClone` を返す。ヒットで
  時刻を更新しない。
- 取得ごとに順序番号 (usdcFetchSeq / usdcAppliedSeq) を振り、後から開始した取得の結果だけを
  反映する。キャッシュ時刻は取得の開始時刻。`resetUsdcFaceCache()` は進行中の取得も無効化する。
- 失敗の扱い (既存の 2 分類は維持):
  - **可用性の失敗** (通信失敗・JSON 不正・非 2xx・許容年齢超えの応答) → `null` を返す
    (USDC 面なし = JPYC のみで継続)。キャッシュに触れない。
  - **404** (`resource_not_found` = USDC 面が無効 / `not_found` = リレー停止) → 確定シグナルとして
    扱い、後から開始した取得なら同じ resourceId のキャッシュを消してから `null`。
    (残すと、USDC 面を止めた後も最大 30 分、支払いなしの 402 が USDC accepts を出し続ける。)
    503 `relay_unconfigured` / 429 `rate_limited` は一時的な失敗なので消さない。
  - **信頼の失敗** (`validateUsdcFace` の不一致) → 今までどおり throw (両レール停止・500)。
    キャッシュしない。
- 反映済みより古い取得の成功応答は、反映済みのキャッシュ (同じ resourceId かつ許容年齢内なら
  検証して返す) に従い、無ければ `null`。
- 支払いありの取り直しが可用性の失敗で `null` になった場合、そのリクエストは今までどおり
  USDC 面なしで扱われる (PAYMENT-SIGNATURE / base の X-PAYMENT は 402 `payment_invalid`)。
  既存の検証済みキャッシュは残り、30 分以内の支払いなしリクエストはそれで 402 を返す。

既知の帰結: OpenPay 側で USDC 価格や受取先を変えた場合も、支払いなしの 402 に反映されるまで最大
30 分かかる。USDC の支払いは 5 分以内に取得した条件で verify / settle する。リレーが新しい条件と
食い違えば 409 → キャッシュを捨てて取り直し → 新しい条件の 402 (既存の仕組み) で回復する。

テスト (route + gate):
1. 支払いなしは 30 分以内なら requirements を取り直さない / 30 分で取り直す。
2. 支払いあり (USDC v2 / USDC v1 / JPYC) は 5 分以内なら取り直さず、5 分で取り直す。
3. ヒットのたびに validateUsdcFace (キャッシュ後に EXPECTED_USDC_RECIPIENT を変えると fetch なしで
   拒否)。
4. 失敗はキャッシュしない (503 → 次で取り直す / 検証失敗 → 次で取り直す)。
5. 新しい USDC 条件が relay verify / settle に渡る (支払いなしの 402 は古いまま)。
6. 404 で破棄、503 では残す。
7. 並行取得: 404 と成功の両方向、遅い古い応答、開始時刻基準、許容年齢超えは null で非キャッシュ。
8. 既存テストの「USDC 面は 5 分ごとに取り直す」(route) は新仕様に合わせて改める。

#### 訂正の計画レビュー裁定 (Fable 5.1, 2026-10-02) — 全件採用

- 失敗の分類は **status だけ**で行い、非 2xx の本文は読まない (`resource_not_found` と `not_found` を区別しない。
  リモート本文をログに出さない方針とも整合)。可用性の失敗は「通信失敗・JSON 不正・**404 以外の**非 2xx・
  許容年齢超え」。
- 成功応答の処理順を固定: `validateUsdcFace` → 許容年齢 (`Date.now() - startedAt >= maxAgeMs` なら null・
  非キャッシュ) → `seq > usdcAppliedSeq` なら反映 (`usdcFaceCachedAt = startedAt`) → それ以外は反映済みの
  キャッシュ (同じ resourceId・許容年齢内なら検証して `structuredClone` で返す) に従い、無ければ null。
  検証を年齢判定とキャッシュ書き込みより前に置くので、遅れて届いた不正な応答は null ではなく throw
  (両レール停止) になる。
- `resetUsdcFaceCache()` は `usdcAppliedSeq = usdcFetchSeq` で進行中の取得も無効化する。409 経路 (本番で
  reset を呼ぶ唯一の経路) で、reset 前に始まった取得が 409 を起こした旧条件を書き戻すのを防ぐ。409 経路は
  `usdcFace({ forPayment: true })` と明示する。
- TTL 定数は myAccepts と共有する (`PAYMENT_LISTING_TTL_MS` / `PROBE_LISTING_TTL_MS`)。
- 既知の帰結に追加: **リレーの一時障害 (503/429/通信失敗) の間、支払いなしの 402 は最大 30 分 USDC accepts を
  出し続ける (今日は 5 分)。その間の USDC 支払いは 402 `payment_invalid` (accepts は JPYC のみ・
  `PAYMENT-REQUIRED` なし) で止まり、relay verify / settle は呼ばれず課金されない。** 支払いありの取り直しが
  失敗したときにキャッシュも消す対案は、障害中に支払いなしリクエストが毎回取り直すことになり myAccepts の
  裁定と逆になるので不採用。
- JPYC 支払いのときも usdcFace を 5 分 tier で取り直す (USDC 面はエラー 402 の本文にしか使わない) のは、
  `hasPayment` 1 変数から両方を導く裁定を優先して許容する。KV コストは支払いごとで、クローラーごとではない。

テスト (追加・改め済み): route — 支払いなし 30 分境界 (USDC)、支払いあり 3 レールの requirements 回数、空ヘッダの
requirements 回数、新しい USDC 条件が relay verify / settle に届く (支払いなし 402 は旧条件のまま)、リレー障害中の
USDC 支払いは課金なしで 402 かつ支払いなしは検証済みキャッシュで USDC を出す、404 で破棄、ヒットのたびの
USDC pin 再検証。gate — 30 分境界、ヒットで年齢を伸ばさない、省略時 5 分、失敗の非キャッシュ (503・検証失敗)、
並行取得の両方向、遅い古い応答、開始時刻基準、許容年齢超えは null・非キャッシュ、遅れた不正応答は throw、
reset による進行中取得の無効化。既存の「USDC 面は 5 分ごとに取り直す」は逆転、「5 分キャッシュ」の名前を改めた。

#### 訂正のコードレビュー裁定 (Codex GPT 6 Astra xHigh・読むだけ, 2026-10-02)

- **minor (採用)**: 「古い取得の応答が不正 (受取先の差し替え) で、新しい有効な値がすでにキャッシュ済み」の
  場合に throw することを固定するテストが無かった (「新しい結果があるときは検証を飛ばす」変異が全テストを
  通過した)。usdcFace と myAccepts の両方にテストを追加し、変異が検出されることを確認した。
- **major (不採用)**: 「古い取得の 404 は、より新しく開始した取得が 503 で終わった / まだ進行中の間は
  キャッシュを消すべきでない (`seq === fetchSeq` を要求すべき)」という指摘。採らない理由:
  404 は OpenPay が「出品 / USDC 面は無い」と明言した**確定した結果**で、503・429・通信失敗は何も言って
  いない**不確定な失敗**。順序の規則は「**確定した結果 (成功または 404) のうち、最も後に開始した取得の
  ものだけを反映する。不確定な失敗は順序を進めず、確定結果を上書きも取り消しもしない**」で、myAccepts と
  同じ (Fable 5.1 の最終監査で妥当と確認済み)。古い 404 の後に新しい取得が成功すれば、その成功が反映されて
  キャッシュは戻る。この挙動はテストで明示的に固定した (新しい取得が 503 で終わったら古い 404 はキャッシュを
  消す)。なお、Astra に渡した不変条件の文言 (「最新に開始した取得の 404 だけが消す」) は実装の意図より
  厳しい書き方で、誤りはこちらの文言側にあった。

既知の帰結 (PR に記載): 「失敗はキャッシュしない」ので、`EXPECTED_USDC_RECIPIENT` を設定したまま OpenPay 側で
USDC 面を無効にすると、支払いなしリクエストのたびに requirements を取りに行く (404・KV を消費)。これは今回の
変更前からの性質。USDC 面を止めるときは `EXPECTED_USDC_RECIPIENT` も外せば取りに行かない。discovery の 404
(出品が消えた) も同様だが、その場合ゲートウェイ自体が販売できない状態。

#### 最終監査 (Fable 5.1) を受けた補足 — 人間のレビュアー向け

- **リレー一時障害中の挙動の正確な範囲**: 「その間の USDC 支払いは 402 で止まり課金されない」が成り立つのは、
  支払いの時点でキャッシュが 5 分を超えている (= 取り直しが失敗して null になる) とき。障害開始から 5 分以内は
  検証済みの条件がそのまま使われ、リレーの verify / settle が動いていれば通常どおり決済され、リレー全体が
  落ちていれば verify が失敗して課金されない。誤った課金が生じる経路はない。
- **USDC 支払いが 2 件同時に 409 を受けた場合**: 後の支払いの `resetUsdcFaceCache()` が先の支払いの再取得を
  無効化するため、先の再取得が先に終わると、先の買い手は 402 `requirements_mismatch` ではなく 500
  `payment_verification_failed` を受けることがある (変更前は 402 と新しい条件)。409 はリレーがすでに拒否した
  状態なので課金はなく、再試行すれば新しい条件の 402 が返る (fail-closed)。「reset は進行中の取得も無効化する」
  の代償で、対案 (無効化しない) は 409 を起こした旧条件の書き戻しを許すため採らない。
- 「404 は KV を消費する」は OpenPay 側の実装 (リレーは rate limit とレジストリ参照で KV を使う) に基づく想定。

## 17. Arc (Circle Gateway) を第三者向け relay とゲートウェイに追加 (2026-10-20)

目的: OpenPay 本体の first-party 有料 API は Arc (Circle の L1) の USDC を「2 本目の USDC x402 レール」として
受け付けている (Circle Gateway x402 facilitator・`eip155:5042`・flag `ENABLE_X402_ARC_GATEWAY`)。
第三者向けの dual-rail relay (OpenPay `/api/x402/relay/*`) と、このゲートウェイにも Arc を入れる。
2 リポジトリにまたがる: **OpenPay 本体 (relay)** と **x402-jpyc-gateway (ゲートウェイ)**。
SDK (`openpay-x402-sdk` の dualGate) の Arc 対応は npm 公開を伴うので今回は範囲外 (Base のみで動き続ける)。

### 前提 (調査で確認した事実)
- Arc は x402 **v2 のみ**。network は CAIP-2 (`eip155:5042` mainnet / `eip155:5042002` testnet)。scheme は
  `exact` だが、EIP-712 domain が USDC 本体ではなく `GatewayWalletBatched` / version `1` /
  verifyingContract = Gateway Wallet (mainnet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` /
  testnet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`)。asset は `0x3600…0000` (6 桁)。
  `maxTimeoutSeconds` は 604900 (Gateway は 3 日未満の authorization を拒否)。
- 買い手は事前に Gateway Wallet へ USDC を入金しておく必要がある (以降はガス不要)。
- 売り手の売上は**受取アドレスの Gateway 残高**に入り、withdraw して初めて手元に来る (Base は直接着金)。
- settle はバッチ。`transaction` は tx ハッシュではなく Gateway の UUID。
- CDP / payai は Arc を settle できない。CDP Bazaar に Arc で載る保証はない (Base 側の掲載はそのまま)。
- **Gateway の verify は使用済みの nonce を `isValid:true` で通す** (OpenPay 実測 2026-09-17)。settle は
  `nonce_already_used` で失敗する。
- OpenPay 本体には Arc の accept 生成 (`buildAccepts` の arc)・rail 判定 (`v2HeaderToRailBody`)・Gateway への
  送信 (`postGatewayFacilitator` / `postFacilitatorWithStatus(..., 'arc-gateway')`) がすでにある。
  relay (`dualRailRelay.ts`) はそれらを使っておらず、Base (CDP) 固定。

### 不変条件 (両リポジトリ共通)
1. **Base 経路は 1 バイトも変えない** (relay の requirements の既存フィールド・verify/settle の Base 分岐・
   ゲートウェイの Base レール)。今動いているゲートウェイと SDK 0.6+ がそのまま動き続けること。
2. Arc は**出品者のオプトイン**かつ **OpenPay の relay 用 flag ON** のときだけ出る (既定 OFF で完全に無効)。
3. お金の項目 (payTo / amount / asset / network / verifyingContract) は relay が登録値から決定的に作る。
   ゲートウェイはそれを pin で検証するだけで、手で組まない。
4. Arc でも verify → 上流 → settle の順。`isValid === true` / `success === true` 以外は解錠しない。
5. 使用済みの Arc 署名を使い回して上流を何度も呼ばせることを防ぐ (下記 R4)。

### OpenPay 本体 (relay) の変更
- R1 **flag と出品のオプトイン**:
  - 新しい server-only flag `ENABLE_X402_DUAL_RAIL_ARC` (既定 OFF・`'1'`/`'true'` のみ ON)。
  - Arc を出す条件 = `ENABLE_X402_DUAL_RAIL_ARC` ON **かつ** `x402Config.arcGateway.enabled`
    (既存 `ENABLE_X402_ARC_GATEWAY`・network は `X402_NETWORK` に追従) **かつ** 出品の `usdc.arc === true`。
  - レジストリ `X402ResourceUsdc` に `arc?: boolean` を追加 (検証・Lua CAS 更新・owner API)。受取先は
    `usdc.payTo` を共用する (Gateway 残高はアドレス単位・first-party と同じ方針)。
  - 出品フォームに「Arc (Circle Gateway) でも販売する」チェックを追加。公開 flag
    (`NEXT_PUBLIC_ENABLE_X402_DUAL_RAIL_ARC_UI`) が ON のときだけ表示。説明文に「売上は Gateway 残高に入り
    withdraw が必要」「買い手は Gateway Wallet への事前入金が必要」を書く。
- R2 **requirements 応答** (既存フィールドは不変・追加のみ):
  ```
  { resourceId, v1Accepts, v2Accept, paymentRequiredHeader,      // 既存 (Base のみ) — 変えない
    arc?: {                                                       // Arc 有効時だけ
      v2Accept,              // Arc の v2 accept (first-party と同じ生成規則)
      paymentRequiredHeader  // 完成形の v2 PAYMENT-REQUIRED: accepts = [Base v2Accept, Arc v2Accept] + bazaar 拡張
    } }
  ```
  旧クライアントは `arc` を無視して従来どおり動く。新クライアントは 402 のヘッダを
  `arc.paymentRequiredHeader` に差し替える (組み立てさせない = ドリフト防止)。v1 body には Arc を載せない。
  Arc accept の生成は first-party の `buildAccepts` の Arc 部分を共有関数に切り出して再利用する。
- R3 **verify / settle の振り分け**:
  - v2 `PAYMENT-SIGNATURE` の `accepted` を `[Base, Arc]` で照合する rail 付きの復号を新しく公開する
    (`decodeVanillaPaymentHeader` は変えない)。Arc 一致 → `postFacilitatorWithStatus(..., 'arc-gateway')`
    で Gateway へ (認証なし・v2 wire・掲載メタは載せない)。`postFacilitator` の公開シグネチャは変えない。
  - `paymentRequirements` の pin 照合は rail ごと: Base は従来の 5 項目、Arc は relay 自身の Arc v2 accept と
    **完全一致** (不一致は 409 `requirements_mismatch`)。
  - Arc の settle 成功時、台帳の network は Gateway のエコーではなくローカルの CAIP-2 に固定
    (first-party と同じ)。`transaction` は UUID のまま記録。
- R4 **使用済み署名の使い回し防止 (Arc のみ・KV)**:
  - authorization (network + from + nonce) から識別子を作る (first-party の `vanillaPaymentIdentity` 系を再利用)。
  - verify: KV に「決済済み」の印があれば Gateway を呼ばずに `{isValid:false, invalidReason:'authorization_already_used'}`。
    Gateway の verify が `isValid:true` なら「処理中」の印を SET NX (TTL 15 分)。NX に失敗したら同じく
    `authorization_already_used` (同じ署名の同時投入)。
  - settle: `success:true` → 印を「決済済み」に上書き (TTL 604900 秒 = 署名の有効期間)。`success:false` →
    印を消す (同じ署名で再試行できる)。例外 (判定なし) → 印を残す。
  - KV 障害・未構成は fail-open (警告のみ・決済本体に波及させない。first-party の claim と同じ方針)。
  - 理由: Gateway の verify は使用済み nonce を通すので、印が無いと 1 回分の支払いの署名を何度でも投げて
    ゲートウェイの上流 (LLM) を呼ばせられる (settle で止まるので二重課金にはならないが、上流コストの増幅)。
    relay の rate limit はゲートウェイのサーバー IP 単位で、買い手単位の歯止めにならない。
- R5 docs: `docs/ENV.md` に新 flag 2 つ、`docs/DEPLOY_CHECKLIST.md` に第三者 Arc の go-live 手順。
  **go-live の前提: 開示 3 点セット (LP FAQ・利用規約・llms.txt) の第三者 Arc 版の同期** (first-party と同じ扱い・
  文言はユーザー判断)。コードは flag OFF で無効のまま出す。

### ゲートウェイの変更
- G1 `UsdcFace` に `arc?: { v2Accept, paymentRequiredHeader }` を追加。2 段 TTL のキャッシュはそのまま
  (Arc も同じ face の一部)。
- G2 `validateUsdcFace` で `arc` があれば pin 検証 (不一致は既存どおり throw = 両レール停止):
  - `payTo` = `EXPECTED_USDC_RECIPIENT` (Base と共用)
  - network = Base の network に対応する Arc (`eip155:8453`→`eip155:5042` / `eip155:84532`→`eip155:5042002`)
  - asset = `0x3600…0000`、scheme = `exact`、amount = Base の `maxAmountRequired` (同じ USD 価格)
  - extra = `{ name: 'GatewayWalletBatched', version: '1', verifyingContract: <その network の Gateway Wallet> }`
    (Gateway Wallet のアドレスはゲートウェイ側の定数で pin。署名先のコントラクトを差し替えさせない)
  - `maxTimeoutSeconds` は 3 日以上 8 日以下の整数
  - `arc.paymentRequiredHeader` を復号し、`accepts` が `[face.v2Accept, arc.v2Accept]` と完全一致
- G3 402: ヘッダは `arc.paymentRequiredHeader ?? paymentRequiredHeader`。v1 body (accepts) は従来どおり
  `[JPYC, Base USDC]` (Arc は v2 のみ)。409 経路の 402 も同じ。
- G4 rail 判定: `PAYMENT-SIGNATURE` を復号し、`accepted` が `arc.v2Accept` と完全一致すれば Arc レール。
  それ以外は従来どおり Base レール (復号できない値も従来どおり relay に渡す)。v1 `X-PAYMENT` は常に Base / JPYC。
- G5 `relayPayment` に rail を渡し、Arc なら `paymentRequirements: arc.v2Accept` を送る。Base は従来どおり。
- G6 Arc の 200 には `X-PAYMENT-RESPONSE` に加えて v2 の `PAYMENT-RESPONSE` も付ける (Arc の買い手は v2)。
  Base の応答は変えない。
- G7 README / .env.example: Arc は OpenPay 側の出品設定 (オプトイン) で有効になり、ゲートウェイ側の追加設定は
  不要。売上は Gateway 残高 (withdraw が必要)、買い手は事前入金が必要、Bazaar 掲載は Base 側。

### 段階投入
relay を先に出す (Arc は flag OFF で無効・既存クライアントは `arc` を無視) → ゲートウェイを出す (relay が `arc` を
返すまで何も変わらない) → OpenPay で flag ON + 公式出品をオプトイン → Arc testnet / mainnet で実購入を確認。

### テスト方針
- relay: flag / オプトインの組み合わせごとの requirements (Arc 無し時は既存と byte 一致)、Arc の
  PAYMENT-SIGNATURE → Gateway へ (CDP は呼ばない)・Base は CDP のまま、Arc pin の不一致 → 409、
  R4 の印 (決済済み・処理中・settle 失敗で解除・KV 障害で fail-open)、台帳の network 固定、掲載メタを Gateway へ
  送らない、v1 X-PAYMENT は Arc にならない。
- ゲートウェイ: G2 の各 pin の不一致で throw、Arc 無しの face は従来と同じ 402、Arc ありの 402 ヘッダ差し替え、
  Arc レールの relay 送信内容 (`paymentRequirements` = arc.v2Accept)、Base レール不変、409 経路、
  `PAYMENT-RESPONSE`、2 段 TTL が Arc にも効く。

### 計画レビュー裁定 (Fable 5.1, 2026-10-20) — 以下が §17 の確定版 (全件採用)

1. **relay の pin と rail の整合 (major)**: pin 照合はヘッダ復号より前 (現行の位置) で行い、pin の rail は
   **pin の形**で決める — `maxAmountRequired` を持つ v1 形 = Base (従来の 5 項目)、`amount` を持つ v2 形 = Arc
   (relay 自身の Arc v2 accept と構造的に完全一致・Arc 無効時は必ず不一致)。不一致は 409。そのあと復号した
   rail が pin の rail と違えば **409** (`requirements_mismatch`)。pin 無しの呼び出しは従来どおり rail を問わない。
   → ゲートウェイの face が古い (Arc を知らない) まま Arc で払われた場合も 409 → 再取得 → Arc 入りの 402 で回復
   し、ゲートウェイが検証していない条件で売ることがない。SDK 出品者は Base pin しか送らないので、オプトイン
   しても Arc ヘッダは 409 になり Base のみで動き続ける。
2. **ゲートウェイ G2 の分割 (major)**: 金銭項目 (payTo / network 対応 / asset / scheme / amount = Base 額 /
   ヘッダの accepts 一致) の不一致は従来どおり throw (両レール停止)。**署名ドメイン項目** (extra.name /
   version / verifyingContract・maxTimeoutSeconds の範囲) の不一致は**固定理由をログして `arc` を落とし、
   Base のヘッダで続ける** (署名先が本物の Gateway Wallet でなければ署名は無効で売り手に損失は無い。
   Circle の Gateway Wallet 更新で全ゲートウェイの JPYC まで止まる爆発半径を避ける)。
3. **R4 の細部**:
   - settle が `success:false` でも `errorReason === 'nonce_already_used'` なら印を「決済済み」で固定 (消さない)。
   - KV キーは first-party と別の prefix (`x402:relay:arc:`)・別 record (`pending` / `settled`)。settle 失敗時の
     削除は Lua CAS で「pending のときだけ DEL」。
   - 識別子は (network, from, nonce) だけ (署名は使わない = malleability に強い)。from / nonce が読めない
     Arc payload は 400 `invalid_payment_payload` (Gateway も拒否する値)。
   - reason を分ける: 処理中 = `authorization_in_use`、決済済み = `authorization_already_used`。
   - fail-open は維持するが、KV 障害中は使い回し防止が効かないことを ENV.md / DEPLOY_CHECKLIST に明記。
4. **受取先 (major)**: Arc の受取先は `usdc.payTo` を共用するが、**EOA であること**が条件 (Gateway 残高の
   引き出しは受取アドレスの EIP-712 署名)。出品フォームと開示に明記し、Circle の引き出し署名の制約
   (ERC-1271 の可否) は go-live 前に一次資料で確認する項目にする。フォームには「SDK
   (`openpay-x402-sdk`) で動く出品は Arc を提示しない (x402-jpyc-gateway 版が必要)」も書く。
5. minor:
   - deep-equal はキー順に依存しない構造比較 (JSON 文字列比較は不可)。
   - ゲートウェイの 402 ヘッダの選択は helper 1 つに集約し、全経路 (402 各所 + 409 経路) をテストで固定。
   - v1 `X-PAYMENT` の network が Arc (`eip155:5042` / `5042002`) なら 402 `payment_invalid` (facilitator を呼ばない)。
   - relay は Arc の settle 応答の `network` もローカル CAIP-2 に固定して返す (台帳だけでなく応答も)。
   - ゲートウェイは `arc.paymentRequiredHeader` の accepts 以外 (resource / extensions / error / x402Version) が
     Base ヘッダと一致することも検査する (不一致は金銭ではないので Arc を落とす扱い)。
   - relay テスト: Arc ありでも既存 4 フィールドが Arc なしと byte 一致。Arc accept の payTo は出品の
     `usdc.payTo` (first-party の payTo ではない)。
   - Base v2 の応答は `X-PAYMENT-RESPONSE` のみ (既存) を README に明記。

### コードレビュー裁定 (Codex GPT 6 Astra xHigh・読むだけ, 2026-10-20)

relay (OpenPay `feat/relay-arc`):
- **major 3 件 (採用・修正済み)** — 使い回し防止の印を状態遷移に作り直した:
  `(なし) --verify isValid:true--> pending(credential) --settle 開始 (Lua CAS)--> settling(credential)`
  `settling --成功 / nonce_already_used / 判定なし (2xx の形不明・例外)--> settled (604900 秒)`
  `settling --明示的な否定判定--> (なし)` ※同じ credential のときだけ消す (Lua CAS)。
  credential は正規化した署名の fingerprint (キーには使わない)。これで
  (1) 同じ from/nonce に不正な署名を添えた settle は正規の印を動かせない (`authorization_in_use`・Gateway を呼ばない)、
  (2) `200 {}` などの判定なしは決済済み側に倒して 503、
  (3) verify を経ない settle は `authorization_not_verified` で Gateway を呼ばない (決済中の隙間に別の verify を通さない)。
  同じ署名の settle の同時投入は 1 本だけ Gateway に届く。KV 障害は従来どおり fail-open。
  テストは本物の Lua (tests/_helpers/redisLua の fake Upstash・仮想時計) で TTL まで検証する。
- minor (不採用): relay が v1 X-PAYMENT の Arc network に 400 を返すのは §17 の裁定違反、という指摘。
  「402 `payment_invalid`」はゲートウェイ側の規則 (ゲートウェイは実装済み)。relay は HTTP の relay API として
  復号できない支払いに従来どおり 400 `invalid_payment_payload` を返す。
- minor (文書を実装に合わせる): 公開 flag の名前は既存の `NEXT_PUBLIC_ENABLE_X402_DUAL_RAIL` に合わせて
  **`NEXT_PUBLIC_ENABLE_X402_DUAL_RAIL_ARC`** (§17 R1 の `..._ARC_UI` は採らない)。
- minor (採用): kill switch は進行中の Arc の settle も止める (pin 付きは 409・pin なしは 400・買い手は課金されない)
  ことと、UI flag を先に外して出品者のキャッシュが切れるのを待つ手順を DEPLOY_CHECKLIST に追記。追加した節の番号が
  既存の §14.9 と重複していたので §14.8b に変更。

ゲートウェイ (`feat/arc-rail`):
- **major (採用・修正済み)**: Arc の判定がパディング無しの base64 を受けず、relay (受ける) と食い違って 409 が
  回り続ける。→ PAYMENT-SIGNATURE の Arc 判定は relay の `decodePaymentSignatureHeaderValue` と同じ受理規則
  (`^[A-Za-z0-9+/]*={0,2}$`) で復号する。v1 X-PAYMENT の復号 (厳格) は変えない。
- minor (採用): Arc の問題のログの重複排除が 409 (キャッシュのリセット) のたびに消えて同じ警告が繰り返し出る。
  → 重複排除はキャッシュと独立にし、テスト用のリセットを別に用意。
- minor (採用): 「relay が拒否する」はずのテストが成功を許していた。→ テストの relay モックに rail ルール
  (pin と支払いの rail が違えば 409) を入れ、「Base のみの face を持つゲートウェイで Arc 支払い → 409 →
  取り直して Arc 入りの 402 → 再署名で 200」の回復と、Arc を落とした face では上流が一度も動かないことを固定。

## 18. coo-icp 0.7.0 への追従 (2026-11-15)

### きっかけ

全コードベースのレビュー中に、mainnet の canister (`4wfup-gqaaa-aaaas-qdqca-cai`) が 0.7.0 に上がり、
`chat` が削除されていると分かった (`candid:service` と `version` を読み取りで確認)。それまでのアダプタは
`clear_conversation` のあと `chat` を呼ぶので、支払いのあるリクエストは verify を通ったあと必ず
`502 upstream_error` になる (settle の前なので未課金)。

### 0.7.0 の契約 (dwebxr/coo-icp の README と `eliza_backend.did`)

```candid
send_message : (request_id : text, base_revision : nat64, content : text)
    -> (variant { Ok : record { reply : text; revision : nat64 }; Err : ChatError });
clear_conversation : () -> (nat64);   // 新しい revision
```

- 会話は caller ごとに 1 つ。保存と clear のたびに revision が進み、戻らない。
- `base_revision` が会話の revision と違えば `Conflict` で、何も実行されない。
- 同じ caller の 2 つ目の要求は `Busy`。clear は生成中の回答を取り消し、その要求は `Cleared` になる。
- 匿名の caller は受け付けない。request id は 1〜64 文字の印字可能 ASCII (空白なし)。
- 上限: 質問 4,000 バイト、回答 16,000 バイト、同時 20 件、モデル呼び出し 1 分に 60 回。

### アダプタ

1. `IC_IDENTITY_SEED` から identity を 8 個作る。slot 0 は従来と同じ `sha256(seed)`、slot n は
   `sha256(seed + "\n" + n)`。数を固定するのは、canister に残す会話を増やし続けないため
   (リクエストごとに新しい identity を作ると、clear に失敗した会話が誰にも消せずに残る)。
2. 1 リクエストは空いている slot を 1 つ、使い終わるまで占有する (プロセス内)。空きがなければ待つ。
   空きの中からはランダムに選び、別のインスタンスと重なりにくくする。空いた slot は待っている中で
   いちばん古いリクエストに渡す。待てるのは 32 件 (`MAX_WAITING`) までで、超えたら待たせずに
   throw する (`coo-icp is busy`)。
3. `clear_conversation()` の返す revision を `base_revision` にして `send_message(UUID, revision, q)` を呼ぶ。
4. `Ok` → `{ answer: reply }`。`Err` → throw (route が 502・未課金)。エラーの本文は載せず、種類の名前だけを使う。
5. `IC_IDENTITY_SEED` が未設定なら canister を呼ばずに throw する。
6. 1 リクエスト (slot の空き待ち + clear + send) に 120 秒 (`DEADLINE_MS`) の期限を付ける (下の「期限と待ち行列」)。

### 期限と待ち行列 (コードレビュー対応・2026-11-15)

Codex (読むだけ) の指摘: 呼び出しが返らないと `finally` が走らず slot が戻らない。8 個とも止まると、
その後のリクエストは無制限の待ち行列で永久に待つ。対応:

- 期限は `AbortController` を `setTimeout` で abort する (`AbortSignal.timeout` は fake timers で
  進められないため使わない)。終わったら必ず timer を消す。
- `HttpAgent.create({ fetch })` で SDK の通信すべてに期限の signal を付ける (SDK が signal を渡したときは
  `AbortSignal.any` で両方)。期限で止まった通信が reject し、SDK の呼び出しが失敗して、slot は既存の
  `finally` で戻る。期限による失敗は SDK の文面ではなく固定の `coo-icp deadline exceeded` で throw する。
- slot を得た直後と、clear と send の間で期限を確かめる。期限を過ぎてから clear が返っても send しない
  (502 になるリクエストで生成を始めない)。
- 待っている間に期限が来たリクエストは、待ち行列から外して同じ文言で reject する。外したリクエストに
  slot を渡すと誰も返さずに失われるので、渡さない。
- 期限・待ち行列の上限のどちらも route では `502 upstream_error` (未課金)。
- 受け入れた制限 (修正差分の確認で Codex が実測):
  - 120 秒は「完了の期限」ではなく「打ち切りを始める時刻」。SDK は失敗した通信を間を置いて数回やり直し、
    update call の結果待ち (polling) の合間の待ち時間は abort で短くならない。本物の SDK と模擬の通信で、
    完了は 121.8 秒 (通信中) と 132.5 秒 (polling 中) だった。slot が戻るのもその時点。
  - 期限は canister 側の生成を止めない。送信済みの `send_message` は canister で最後まで動き、その後に
    clear が入らなければ質問と回答が保存される。ゲートウェイは回答を受け取らず、買い手にも渡さない。
    まだ生成中の slot を次に使ったリクエストは `Busy` で 502 になりうる。
  - clear が消すのは canister の動作中の状態にある会話だけ。前回のアップグレードで stable memory に
    書かれた写しとスナップショットは残り、canister の管理者は読める (coo-icp README の Known gaps)。
- SDK が signal を `Request` の中に入れて渡しても落とさないよう、`fetch` には `new Request(input, init)` に
  まとめてから、その signal と期限の signal を `AbortSignal.any` で合わせて渡す (いまの SDK は init で渡す)。

### 以前の「受け入れた制限」がどう変わったか

§6 は「並行リクエストの clear / chat の交錯で文脈が混ざりうる (許容)」としていた。0.7.0 では
revision のおかげで、同じ identity を 2 つのリクエストが同時に使っても混ざらない: 送れるのは後から clear
した側だけで、先の側は `Cleared` か `Conflict` か `Busy` で失敗する (未課金)。後から clear した側も、
先の側の生成がまだ終わっていなければ `Busy` で失敗する (A の生成中に B が clear → B の send は `Busy`、
A は `Cleared`)。つまり片方または両方が失敗しうるが、文脈は混ざらない。プロセス内では slot の占有で
そもそも重ならない。残る制限は「インスタンスをまたいで同じ slot が重なると片方または両方が 502 になる」
ことと、「質問と回答がその slot で次に clear が成功するまで canister に残る」こと。

### テスト (`test/coo-icp.test.ts`)

呼び出しの順番を見るだけのモックをやめ、0.7.0 の動き (caller ごとの会話・revision・Busy・Conflict・
Cleared・request id の形式) を模したモデルに対して確認する。Candid は本物の IDL を使う。canister の型は
テストの中にアダプタとは別に書き、アダプタが encode した引数を canister の型で、canister の型で encode した
返り値をアダプタの型で decode できることを確かめる (`clear_conversation` の引数は 0 個)。アダプタの IDL を
わざと壊すと (revision を `int64`・`nat` に、引数の順番違い、clear に引数、`Ok` から revision を抜く、
`Conflict` を抜く、query にする) このテストが失敗することを確認した。確認する内容: 前の買い手の質問が
次の回答に入らない / 同時 3 件が別々の会話になる / 9 件目以降は待つ (同時に動くのは 8 件まで) /
`Err`・`HttpAgent.create` の失敗・`clear_conversation` の失敗のどれでも 8 個の slot がすべて戻る /
別のインスタンスが同じ identity を使ったら混ざらずに失敗する / identity は seed だけで決まり、
slot 0 は `sha256(seed)` / env が欠けていれば canister を呼ばない / エラーに遠隔の本文を載せない。
期限と待ち行列は fake timers で確認する: 通信が止まった 8 件は期限ちょうどに固定の文言で失敗し、その後
8 件が同時に動く (止まった通信は、SDK に渡した `fetch` の signal でしか終わらない) / SDK が渡す signal も
効く / 待ち行列で期限が来たリクエストは失敗し、slot を受け取らない / 33 件目の待ちはすぐ断る /
期限後に clear が返っても `send_message` を呼ばない。

### 実機確認 (2026-11-15・mainnet・使い捨ての seed)

- 旧 `chat` は拒否される (本番が売れなくなっていた原因の再現)。
- 新アダプタで 1 件: 約 7.5 秒で回答。同時 2 件: 両方成功 (約 7.1 秒)。
- 同じ identity で 2 件続けて送り、2 件目が 1 件目の合言葉を知らないこと (文脈が混ざらない) を確認。
- 確認に使った会話は clear 済み (残ったメッセージ 0 件)。
- 期限と `fetch` の差し替えを入れた最終版でも再確認した: 同時 4 件を 2 回と同時 3 件を 1 回送り、
  全件が自分の合言葉だけを返した。canister に保存された会話も、それぞれ自分の 1 往復だけだった。
  4,000 バイトを超える質問は `Invalid` で断られた (route では 502・未課金)。
- 注意: 「1 文字だけ返して」のようなあいまいな質問では、モデルが質問と違う文字を返すことがあった。
  保存された会話を読んで、混入ではなくモデルの応答のぶれだと確かめた。

### コードレビュー裁定 (Codex gpt-6.1-sol xHigh・読むだけ, 2026-11-15)

1 回目 (P0・P1 なし): P2 呼び出しが返らないと slot が尽きる・待ち行列が無制限 → 期限と上限 (上の
「期限と待ち行列」)。P3 IDL のテストが引数の型違いを通す → canister の型をテスト側に別に書いて相互に
decode。P3 slot の返却テストが `Err` しか見ていない → agent の作成失敗と clear の throw も追加。
P3 文書が衝突を「片方が失敗」としていた → 片方または両方。すべて採用 (修正は Opus 5.5)。

2 回目 (修正差分・P0〜P2 なし): P3 120 秒は完了の期限ではない / P3 「回答は捨てられる」「clear で消える」
は言い過ぎ / P3 `Request` の中の signal を落とす (いまの SDK では起きない)。すべて採用。生き残った変異
(FIFO を LIFO に・timer を消さない・SDK の signal だけ残す) にもテストを足し、検出することを確かめた。

## 19. フェーズ B: 挙動を変えないリファクタ (2026-11-15)

### 目的

全コードベースのレビュー (2026-11-15) で決めた挙動の変更 (フェーズ C1〜C3) を、それぞれ 1 か所の
修正で入れられるように、先に支払いのコードを組み替える。外から見える挙動は 1 バイトも変えない。

### 何をどこへ移したか

- lib/gate.ts を責務ごとに分けて削除した (分け方は §3)。
  - 型 → lib/types.ts。sellerPins.ts も型をここから読むので、gate ⇄ sellerPins の型の循環がなくなった。
  - `jsonResponse` / `json402` → lib/http.ts。2 つの route の JSON 応答もこれを使う。
  - OpenPay の origin・決済条件の鮮度 (`termsMaxAgeMs`)・facilitator の verify / settle・
    `encodePaymentResponse` → lib/openpay.ts。pin の確認は同期のまま (不一致なら何も送らずにその場で throw)。
  - JPYC 出品のキャッシュ (`myAccepts` → `listingAccepts`) と `acceptsFor` → lib/listing.ts。
    上書きされるだけの最初の `search = ''` を消した。MY_RESOURCE_URL の確認は残す (sellerConfig() が読むのは
    discovery を待つ前なので、待つ間に消えた場合はここで `MY_RESOURCE_URL is not set` になる)。
  - USDC 面のキャッシュ・Arc の問題ログ・`paymentRequiredHeaderFor`・`isArcPayment` → lib/usdcFace.ts。
  - `relayPayment` (409 での取り直しを含む) → lib/relay.ts。
  - `decodePaymentSignature` → lib/paymentHeader.ts。厳密な `decodePaymentHeader` と受理する形が違う理由を
    コメントに書いた。
- route.ts の GET の中身を lib/purchase.ts の `consult(request)` に移し、JPYC と USDC の 2 本のほぼ同じ手順を
  その中の 1 本にした。rail ごとに違うのは verify / settle の呼び先・本文の読み替え (`read`: USDC は null を
  `{}` に、JPYC はそのまま)・理由がないときの error・成功時のヘッダーの 4 点だけ。rail の選び方は純粋な関数
  `choosePayment` にした (分岐の順番はそのまま)。支払いなしの 402 と q の確認は、いままでどおり rail を選ぶ前に
  行う。`paymentError` は消した。route.ts の GET は async にせず、consult の Promise をそのまま返す。
- Promise のジョブの数も変えない (Codex のレビューで 2 回見つかった)。同時に動く別のリクエストとの順番が
  変わるため:
  - rail の verify / settle は呼び先の Promise をそのまま返し、await を足さない。`read` は await の直後に
    同期で呼ぶ。
  - リクエスト全体を consult という 1 つの async 関数の中で終え、最後に別の async 関数の Promise を return
    しない (引き継ぐ分だけ完了が遅れる)。
  - 確かめ方: 支払いなし・各 400 / 402・verify / 上流 / settle の各結果を 3 つの rail で、キャッシュの
    有無の両方 (118 通り) について、fetch・上流・ログ・完了が何ジョブ目に起きるかを a108724 と比べ、
    すべて同じだった (このときだけ使った計測で、リポジトリには入れていない)。
- アダプタの名前ごとの `configured()` と `outputSchema` を lib/adapters/catalog.ts にまとめた。lib/openapi.ts は
  自前の ADAPTER の判定をやめて、ここの `selectedAdapterSchema()` を使う (呼ぶたびに schema の複製を返す)。
  catalog.ts はアダプタ本体を import しないので、/openapi.json は ICP の SDK を読み込まない。
  lib/adapters/index.ts の `selectedAdapter()` は同じ契約 (未知の ADAPTER は throw) のまま、名前だけ catalog.ts
  から読む。coo-icp.ts と http.ts は変えていない。
- 試しに置かれていた .isolation-test.tmp.mjs を削除した (mainnet の canister を呼び、0.7.0 で消えた
  `chat` を使う)。
- import は一方向で、循環はない (lib/openpay.ts は lib/listing.ts も lib/usdcFace.ts も読まない)。

### 挙動を変えていないことの確かめ方 (golden テスト)

- 組み替える前のコードに対して、最初のコミット (d2001e2) で test/golden.test.ts を書いた (322 件)。
  /api/consult と /openapi.json のすべての分岐について、応答 (status・全ヘッダー・本文)、OpenPay への fetch
  (URL・method・ヘッダー・本文・cache・signal の有無) とその順番、アダプタの呼び出し、console.error を
  記録し、スナップショットと比べる。
- その後のコミットでは、このテストとスナップショットを編集しない。各コミットで
  `CI=true npx vitest run test/golden.test.ts` (スナップショットを書き換えない) が通ることを確かめた。
  sha256 は最初のコミットのときから同じ:
  - test/golden.test.ts: `c10355a916176b20e1c8e670269326f7144d796934132fab9bf0f6941c9fb1a2`
  - test/__snapshots__/golden.test.ts.snap: `438edc59c158e0a6e973dd1bed330b92cea7fad0f0abfee9c064d91183e7dd2b`
- 既存のテストで変えたのは import 先だけ。期待値・テスト名・場面・モックは変えていない。
- test/purchase.test.ts を新しく足した: `choosePayment` の表と、同じモジュールで同時に動くリクエストの順番。
  golden は 1 件ずつ動かすので、ジョブの数で変わる順番は golden では見えない。期待値はどれもリファクタ前の
  コード (a108724) で同じテストを動かして得たもの。
  - 2 件の支払い (USDC と JPYC など) の verify / 上流 / settle の fetch と応答の順番。rail に await を足していた
    版 (2030ccb〜8e536dc) では 3 件が失敗する。
  - 支払いの settle の途中で始めた支払いなしのリクエストと、どちらが先に終わるか。境目の両側を置き、完了が
    1 ジョブ早まっても遅れても失敗する。最後に runPurchase の Promise を引き継いでいた 3ad21de では
    3 件が失敗する。

### わざと残したもの (後のフェーズで直す)

(2026-11-16 追記: 「→ C1」の 3 件は §20 で直した。理由がないときの error が rail で違う点は、そのまま残した。)

- JPYC の facilitator が JSON の `null` を返すと、`isValid` / `success` の読み取りが try の外で TypeError に
  なり、GET から漏れる (Next の 500)。USDC 側は `null` を `{}` として扱い、402 になる。→ C1
- verify / settle / relay の応答の HTTP status (`r.ok`) を見ていない。本文の形だけで判定している。→ C1
- `invalidReason` / `errorReason` は値をそのまま 402 の error に載せる (空文字・数値・オブジェクトも)。
  理由がないときの error は rail で違う (JPYC は `invalid_payment`、USDC は `payment_invalid`)。→ C1
- キャッシュの仕組み (取得の通し番号・2 段の TTL・リセットで番号を戻さない・失敗はキャッシュしない) は
  場所を移しただけ。→ C3
- `configured()` は env の有無しか見ない (URL として正しいかは見ない)。→ C3

## 20. フェーズ C1: OpenPay の応答の読み分け・時間切れ・HEAD・v2 の領収ヘッダー・失敗の記録 (2026-11-16)

全コードベースのレビュー (2026-11-15) で決めた挙動の変更の 1 つ目。支払いの経路の挙動が変わる。

### 直したこと

1. **HTTP の状態を見ていなかった。** verify / settle の応答を本文の形だけで判定していたので、503 の本文に
   `isValid: true` があれば上流を動かし、500 の本文に `success: true` があれば回答を渡していた。
2. **JPYC の facilitator が JSON の `null` を返すと、例外が GET の外へ漏れていた** (Next の 500)。
3. **時間切れがなかった。** OpenPay が返事をしないと、リクエストは関数の上限まで待ち続けた。
4. **settle の 202 (決済が進行中) を 402 で返していた。** 402 は「もう一度払って」の意味なので、買い手の
   クライアントが払い直すと二重払いになる。
5. **settle の通信失敗を `payment_settlement_failed` と返していた。** 決済されたかどうかは分からないのに
   「失敗」と言っていた。
6. **`invalidReason` / `errorReason` の値をそのまま買い手に返していた** (空文字・数値・オブジェクト・長い文字列も)。
7. **支払いつきの HEAD が、verify・上流・settle まで進んでいた。** Next は HEAD を書いていない route で GET を
   代わりに動かす。買い手は請求されるのに、本文 (回答) は返らない。
8. **Base の v2 (PAYMENT-SIGNATURE) で払った 200 に `PAYMENT-RESPONSE` がなかった** (Arc にはあった)。
9. **上流の失敗や settle の結果不明を、どこにも記録していなかった** (`catch {}` で握りつぶしていた)。

### OpenPay の応答の読み方 (lib/openpay.ts)

OpenPay への POST はすべて `postToOpenPay` を通る。例外は投げず、`{ status, body }` を返す。応答がなければ
(通信の失敗・時間切れ) `status` は null。`body` は JSON のオブジェクトだけで、それ以外 (JSON でない・`null`・
配列・文字列・本文の読み取り中の時間切れ) は null。

リダイレクトはたどらない (`redirect: 'manual'`)。fetch の既定のままだと、OpenPay が 3xx を返したときに
`Location` の先へ進み、その先の答えを OpenPay の判定として信じてしまう (verify の先が 200
`isValid: true` なら上流が動き、settle の先が 400 なら払い直しを促す 402 になる)。307 / 308 では支払いの本文も
その先へ POST し直す (301 / 302 / 303 では本文なしの GET に変わる)。3xx は下の表の「その他の状態」に
入る (verify は 503、settle は 500 `settlement_unknown`)。出品 (discovery) と USDC の決済条件
(relay/requirements) の GET は変えていない。中身を出品者の pin と照合するため。

verify (`verifyOutcome`):

| OpenPay の応答 | 判定 | 買い手への応答 |
|---|---|---|
| 200 で `isValid === true` | valid | 上流へ進む |
| 200 でそれ以外のオブジェクト | rejected | 402 (理由は `invalidReason`) |
| 4xx (429 を除く) | rejected | 402 (理由は `invalidReason`、なければ `error`) |
| 200 で本文が読めない・429・5xx・その他の状態 (3xx を含む)・応答なし | unavailable | 503 `payment_service_unavailable` |

settle (`settleOutcome`):

| OpenPay の応答 | 判定 | 買い手への応答 |
|---|---|---|
| 200 で `success === true` | settled | 200 と回答、領収ヘッダー |
| 200 で `success === false` | rejected | 402 (理由は `errorReason`) |
| 4xx | rejected | 402 (理由は `errorReason`、なければ `error`) |
| 202 | pending | 502 `settlement_pending`、本文が JSON のオブジェクトなら領収ヘッダー |
| 200 でそれ以外・5xx・その他の状態 (3xx を含む)・応答なし | unknown | 500 `settlement_unknown` |

- 「請求していない」と言えるのは、OpenPay がはっきり断ったとき (4xx、または 200 で `success: false`) だけ。
  それ以外で 402 を返さない。200 の `{}` や `success: "true"` は「分からない」に入れる。
- 5xx は中身を見ない。OpenPay の 5xx には「確実に請求していない」もの (503 の `kv_required` や
  `daily_budget_exceeded`、502 の `relay_error` = 送信していないことが確実な失敗) もあるが、
  見分けるには理由の一覧をこちらに持つ必要があり、OpenPay 側で理由が増えたときに「請求していない」と
  誤って言う危険のほうが大きい (計画レビューの裁定 R3)。
- 202 は facilitator が「送信済みだが未確定」のとき、または同じ支払いの settle が先に進んでいるときに返す。
  どちらも決済される見込みがあるので、払い直しを求めない。settle の本文が JSON のオブジェクトとして読めたときは、
  それを `X-PAYMENT-RESPONSE` (v2 では `PAYMENT-RESPONSE` も) に入れて返し、買い手が照合できるようにする。
  本文が読めなければ領収ヘッダーは付けない。取引ハッシュ (`transaction`) は OpenPay が入れたときだけあり、
  `null` のこともある。
  **このとき買い手は請求されうるが、回答は受け取れない。** 回答を取っておいて渡し直すには共有ストアが要る
  (§19 の計画の N1。未対応)。
- relay の 409 は今までどおり (USDC 面を取り直して 402 `requirements_mismatch`)。OpenPay の relay が 409 を
  返すのは、決済条件の不一致と rail の不一致の 2 つだけ (origin/main の lib/x402/dualRailRelay.ts で確認)。
  取り直しに失敗したとき (取れない・pin が合わない) は、今までどおり 500 `payment_verification_failed` /
  `payment_settlement_failed`。relay が断っているので請求はない。この 2 つの 500 は、pin が合わず OpenPay に
  何も送らなかったときにも返る。
- 理由の値は `^[a-z0-9_]{1,64}$` に合う文字列だけを買い手に返す。合わなければ固定の文字列
  (verify: JPYC は `invalid_payment`、USDC は `payment_invalid`。settle: `settlement_failed`) にする。
  verify の固定の文字列が rail で違うのは、OpenPay の 2 つのリファレンスゲートに合わせたまま残した。

### 時間切れ

| 呼び出し | 上限 | 切れたとき |
|---|---|---|
| discovery (出品) | 5 秒 | 500 `accepts_unavailable` (今までの通信失敗と同じ) |
| relay/requirements (USDC 面) | 5 秒 | USDC 面なしで続ける (今までの通信失敗と同じ) |
| verify | 35 秒 | 503 `payment_service_unavailable` (上流も settle も動かさない) |
| settle | 60 秒 | 500 `settlement_unknown` (回答は渡さない) |

- verify と settle の上限は、OpenPay 側の処理の上限 (`maxDuration`: facilitator の verify は 15 秒、relay の
  verify と両方の settle は 30 秒) より長くした。先にこちらが切ると、OpenPay が出すはずだった判定を捨てる
  ことになる。計画では verify を 15 秒としていたが、relay の verify は 30 秒まで正当にかかりうるので 35 秒に
  した。
- 最悪の合計は 5 + 5 + 35 + 上流 (coo-icp は 120 秒で打ち切りを始め、さらに 10 秒ほど。`http` は 30 秒) + 60 ≒ 235 秒で、
  Vercel の関数の既定の上限 (300 秒) に収まる。
- `AbortSignal.timeout` を fetch に渡す。本文の読み取りも同じ signal で切れる。

### HEAD (`consultHead`)

- 支払いのヘッダー (`X-PAYMENT` が空でない、または `PAYMENT-SIGNATURE` がある) があれば、OpenPay を呼ばずに
  405 (`Allow: GET`)。verify・上流・settle は動かない。
- 支払いのヘッダーがなければ、GET と同じ 402 のヘッダーだけを返す (`PAYMENT-REQUIRED` を含む)。支払いなしの
  HEAD で決済条件を調べるクライアントは今までどおり動く。OpenPay の掲載の確認は GET だけを使う。

### 領収ヘッダー

- `PAYMENT-SIGNATURE` で払った買い手 (x402 v2) には、Base でも Arc でも `X-PAYMENT-RESPONSE` と同じ値の
  `PAYMENT-RESPONSE` を付ける。`X-PAYMENT` で払った買い手 (v1) には `X-PAYMENT-RESPONSE` だけ。
- 502 `settlement_pending` にも同じ規則で付ける。ただし OpenPay の 202 の本文が JSON のオブジェクトとして
  読めたときだけ (読めなければ付けない)。

### 失敗の記録

握りつぶしていた失敗を、`console.error` に 1 行で残す。書くのは固定の言葉・rail の名前 (jpyc / base / arc)・
HTTP の状態だけ。q・回答・支払いのヘッダー・ウォレット・URL・OpenPay の本文・例外のメッセージは書かない。

| 行 | いつ |
|---|---|
| `verify unavailable (jpyc, HTTP 503)` / `(…, no response)` | verify の判定が得られなかった |
| `upstream failed, not charged (jpyc)` | 上流が失敗した (settle していない) |
| `settle pending, content not delivered (jpyc, HTTP 202)` | settle が 202 |
| `settle outcome unknown, content not delivered (base, no response)` | settle の結果が分からない |
| `payment terms unavailable (unexpected error)` | 決済条件を読むところで、sellerPins が理由を記録していない例外 |
| `verify not sent or refused by OpenPay (unexpected error)` / `settle …` | verify / settle の前後で、sellerPins が理由を記録していない例外。OpenPay に送る前か、relay が 409 で断ったあとの取り直しで起きる (どちらも請求なし) |

settle の 2 種類 (pending / unknown) は、買い手が請求されたのに回答を受け取っていない可能性がある。運用者が
OpenPay の管理画面と突き合わせるきっかけになる。

### golden テストの変更

321 場面のうち:

- 40 場面は変更なし (OpenPay を呼ばない場面)。
- 162 場面は、fetch の記録の `hasSignal` が false → true に変わっただけ (時間切れをつけたため)。
- 119 場面は応答か記録が変わった。内訳 (重なりなし):

  | 件数 | 変わったこと |
  |---|---|
  | 38 | verify の判定が得られない場面が 503 `payment_service_unavailable` になった。以前は 500 `payment_verification_failed` (応答なし・JSON でない本文: 8)、402 (本文が `null`・配列・文字列など、または 202 / 429 / 5xx で失敗の形の本文: 20)、上流と settle まで進んで 200 (202 / 429 / 5xx で成功の形の本文: 8)、例外が漏れる (JPYC の `null`: 2) |
  | 28 | settle の結果が分からない場面が 500 `settlement_unknown` になった。以前は 500 `payment_settlement_failed` (応答なし・JSON でない本文: 8)、402 (本文が `null`・配列・文字列など、または 5xx で失敗の形の本文: 15)、回答つきの 200 (5xx で成功の形の本文: 4)、例外が漏れる (JPYC の `null`: 1) |
  | 20 | 形の崩れた理由 (空文字・数値・オブジェクト・200 文字) が固定の文字列になった |
  | 12 | v2 の 200 に `PAYMENT-RESPONSE` が増えた (Base v2) |
  | 11 | 上流の失敗に記録の 1 行が増えた (応答は同じ) |
  | 4 | settle の 202 が 502 `settlement_pending` になった。以前は 402 (失敗の形の本文: 2)、回答つきの 200 (成功の形の本文: 2) |
  | 4 | settle の 400 / 429 で成功の形の本文が、回答つきの 200 から 402 `settlement_failed` になった |
  | 2 | verify の 400 で成功の形の本文が、上流と settle まで進む 200 から 402 になった |
- 63 場面を足した: HEAD (12)、settle の 202 (12)、状態と本文の読み分け (39)。

テストの順番の約束も変えた: フェーズ B では「同時に動く 2 件のリクエストの fetch と完了の順番が、リファクタ
前と同じ」ことまで確かめた (test/purchase.test.ts)。C1 で応答の読み方を変えたのでジョブの数が変わり、
この順番は変わる。順番は外への約束ではないので、「2 件ともそれぞれ verify → 上流 → settle を 1 回ずつ通って
200 になる」ことだけを確かめるテストに置き換えた。golden の「8. cache tiers」「9. interleaved fetches」
(テストが fetch を止めて順番を決める場面) は、`hasSignal` と `PAYMENT-RESPONSE` のほかは変わっていない。

### コードレビュー (Codex) の対応

1. **リダイレクトをたどっていた (P2)。** verify / settle の POST に `redirect: 'manual'` を付けた (上の
   「OpenPay の応答の読み方」)。test/openpay.test.ts に、POST がすべて `redirect: 'manual'` で GET の読み取りは
   既定のままであること、verify / settle の 302 / 307 / 308 (本文なし・成功の形の本文) が JPYC と Base v2 の
   両方で 503 / 500 `settlement_unknown` になり、`Location` の先へ行かないことを足した。テストの fetch は
   `redirect: 'manual'` でなければ fetch の既定のように `Location` の先の答えを返すので、付け忘れるとこの
   テストも落ちる。golden は 384 場面のうち、139 場面は変更なし、245 場面は fetch の記録の POST (390 件) に
   `"otherInit": { "redirect": "manual" }` が増えただけで、それ以外の変更・場面の増減はない。
2. **同時に動く 2 件のテストが、各自の settle を確かめていなかった (P3)。** fetch の記録が
   `fetch relay settle` のように誰の支払いかを書いていなかったので、Arc の settle が 2 回で Base の settle が
   なくても通った。POST の本文の支払いから誰の verify / settle かを記録し、settle をテストが 1 件ずつ放すよう
   にした (test/purchase.test.ts)。
3. **500 `payment_verification_failed` / `payment_settlement_failed` を「OpenPay に何も送っていない」とだけ
   書いていた (P3)。** relay の 409 のあとの取り直しの失敗でも返る (上の 409 の項)。README・lib/purchase.ts の
   注記と、記録の言葉 (`verify not sent` → `verify not sent or refused by OpenPay`、settle も同じ) を直した。
4. **502 `settlement_pending` に必ず取引ハッシュつきの領収ヘッダーが付くように書いていた (P3)。** 付くのは
   202 の本文が JSON のオブジェクトのときだけで、ハッシュは OpenPay が入れたときだけ。README と上の 202 の項を
   直した。

修正の差分も Codex に確認させた (4 件とも修正済み・P0〜P2 の新しい指摘はなし)。そのとき出た文書の言い回しの
指摘 3 件 (P3) も直した: リダイレクトで本文を送り直すのは 307 / 308 だけであること、402 `requirements_mismatch` は
rail の不一致でも返ること、README の 503 / 500 `settlement_unknown` の行に 3xx と読めない 200 を足すこと。
あわせて、README の 200 の行に `PAYMENT-RESPONSE` を足し、§13 の古い記述に §20 への注記を付けた。

### やっていないこと (次のフェーズ)

- 同じ支払いを同時に何度も送ると、上流がその回数だけ動く (settle は 1 回)。→ C2 (§21)
- `maxDuration` の明示と、支払いの有効期限に対する上流の所要時間の確認。→ C2 (§21)
- settle が 202 のときに、OpenPay に状態を問い合わせて確定を待つこと。→ C2b (§21 の「やっていないこと」)
- 決済条件のキャッシュのまとめ読みと、失敗の直後に読み直さない仕組み。→ C3

## 21. フェーズ C2: 支払いの予約・上流の時間切れ・settle の本文の大きさ (2026-11-16)

全コードベースのレビュー (2026-11-15) で決めた挙動の変更の 2 つ目 (計画の D1・D3・R1・R4・R7・R8)。支払いの経路の挙動が変わる。

### 直したこと

1. **同じ支払いを同時に (または決済のあとに) もう一度送ると、上流がもう一度動いていた。** settle は 1 回しか
   通らないので請求は 1 回だが、上流 (coo-icp の canister の呼び出し) はただで動いていた。
2. **上流に時間の上限がなかった。** アダプタが自分の時間切れを持たないと、関数の上限まで待ち、そのあいだに
   支払いの有効期限が切れて settle が通らなくなりえた。`maxDuration` も明示していなかった。
3. **facilitator の verify が返す予約の token を settle に渡していなかった** (OpenPay の SDK は渡す)。token を渡すと
   settle の本文だけが 71 byte ほど長くなるので、verify は上限 (4096 byte) に収まり、上流が動いたあとに settle だけが
   413 で断られる、ということが新しく起きうる。それを防ぐため、verify の前に「token つきの settle の本文」の大きさを
   確かめる。C2 の前は verify と settle の本文が同じだったので、長い `q` は verify の 413 (402
   `payload_too_large`、決済条件つき) で断られていた。それが、OpenPay に送らない 400 `q_too_long` に変わる
   (払い直しても通らない支払いに、決済条件つきの 402 を返さない)。

### 処理の順番 (lib/purchase.ts)

1. 決済条件 → 支払いなしの 402 → `q_required` → `choosePayment` (ここまでは変えていない)。
2. **verify の前の確かめ** (予約はまだ取らず、OpenPay にも何も送らない)。この順番で:
   1. 出品者の pin (JPYC は `validateJpycRequirements`、USDC は relay と同じ `checkRelayPins`)。合わなければ 500。
   2. 出品の決済条件から鍵が作れるか (JPYC: asset・forwarder・merchant・merchantValue・feeReceiver・feeValue。
      USDC: 出品者が確かめた条件の network と asset)。作れなければ 500 `payment_verification_failed`
      (記録は `JPYC payment terms not claimable` / `USDC payment terms not claimable`)。
   3. 支払いから鍵が作れるか。作れなければ 402 `invalid_payment_payload`。
   4. JPYC だけ: いちばん長い token (71 文字) が付いたとしても、settle の本文が UTF-8 で 4096 byte 以下か。
      超えたら 400 `q_too_long`。
3. **予約** (`claimAuthorization`)。同じ鍵が予約中なら **409 `authorization_reserved`** (下)。そうでなく、期限までの
   残りが 155 秒 (上流 125 + 猶予 30) より短ければ 402 `insufficient_validity_window`。**予約済みかを先に見る** (SDK と
   逆の順番。計画レビュー Fable と Codex の指摘)。逆だと、settle まで進んだ支払いの再送が、期限の近づいたころに
   決済条件つきの 402 になり、最初の支払いが決済されていても新しい支払いを促してしまう (Base は期限が 300 秒なので、
   上流が遅いと普通に起きる)。
4. verify。通ったら、期限までの残りをもう一度確かめる (verify に最大 35 秒かかるため。足りなければ 402
   `insufficient_validity_window`、上流は動かさない)。JPYC は verify の応答から token を受け取る。
5. 上流 (125 秒で打ち切り)。失敗も時間切れも 502 `upstream_error` (決済しない)。
6. settle (JPYC は token を付ける)。応答の読み分けは §20 のまま。

`app/api/consult/route.ts` に `export const maxDuration = 300`。いちばん長い購入は、出品と USDC の条件の取得
5 + 5 秒、verify 35 秒 (+ relay の 409 のあとの取り直し 5 秒)、上流 125 秒、settle 60 秒 (+ 5 秒) のおよそ 240 秒。
Arc は verify のあと 15 分以内に settle を始めないと relay が断る (relay の pending の印が 15 分) が、その前に終わる。
この関係はテスト (test/reservation.test.ts) で定数から確かめている。

### 予約 (lib/claims.ts)

openpay-x402-sdk 0.11.1 の `authorizationClaims.mjs` を TS にしたもの。鍵の作り方は同じ。

- JPYC の鍵: [支払いの network, asset, 支払い者, forwarder, merchant, merchantValue, feeReceiver, feeValue,
  validAfter, validBefore, intentSalt]。アドレスは小文字、数は 10 進の正規形、network は `eip155:N` の正規形。
- USDC の鍵: [出品者が確かめた条件の network, asset, 支払い者, nonce]。Base は v1 の条件が `base` と書くので、
  同じ条件の v2 (`eip155:8453`) から取る。Arc は Arc の条件から取る。同じ nonce を v1 (X-PAYMENT) と
  v2 (PAYMENT-SIGNATURE) で送っても 1 つの支払い。Arc の authorization を Base の条件で包み直したものは別の鍵に
  なるが、Base では署名が通らない (署名の domain が違う) ので、relay に断られて予約は外れる。
- 不変条件: **予約が残っているのは、その支払いをこのプロセスで処理している途中か、ここで settle まで進めたとき。**

| 終わり方 | 予約 |
|---|---|
| verify の前の確かめで断った (500 / 402 / 400) | 取っていない |
| verify が通らない (402)・OpenPay が答えない (503)・relay の 409 (402 / 500)・例外 | 外す |
| verify のあとの期限の確かめで断った (402) | 外す (期限は縮む一方なので、外しても同じ支払いは通らない) |
| 上流が失敗した (502) | 外す |
| 上流が時間切れ (502) | 上流の呼び出しが実際に終わってから外す (先に外すと、同じ支払いで上流が同時に 2 回動きうる) |
| settle の前の pin の確かめで止まった (500 `payment_settlement_failed`、OpenPay に何も送っていない) | 外す |
| settle を送った (200 / 402 / 502 pending / 500 unknown / relay の 409 / 例外) | 残す (`retainAuthorization`) |

- **処理中の予約は、期限が来ても消さない。** 上流が時間切れのあともまだ動いているあいだに、同じ支払い者と nonce で
  署名し直した支払い (USDC は鍵に期限が入らない) を通さないため (Codex の指摘)。どのアダプタも 125 秒より短い自分の
  期限を持つので (coo-icp 120 秒・http 30 秒。テストで確かめるのは定数の関係だけで、呼び出しが実際に終わることは各アダプタが自分の期限を守ることに頼っている)、処理中の予約はいずれ外れるか残すに変わる。
- 残すと決めた予約は、支払いの有効期限 (`validBefore`) か、取ってから 8 日 (Arc の支払いの期限の上限と同じ) の
  早いほうで忘れる (期限がずっと先の支払いで、メモリを使い続けないため)。期限の窓の判定は `validBefore` で行う。
- 外すのは、取った本人の予約だけ (owner の symbol で確かめる)。期限切れで消えたあと別の要求が取り直した予約を、
  古い要求が外さない。
- 外すのも残すのも `consult` の 1 か所の `try / finally` だけ (時間切れの遅れた外しを除く)。`rail.settle()` が
  返った時点 (pin の確かめを通り、OpenPay への POST を始めた) で「残す」に切り替える。

### 409 `authorization_reserved` にした理由 (402 にしない)

本文は `{ error: 'authorization_reserved', message: 'This payment authorization is already being processed or was
already used here. Do not pay again.' }`。`x402Version`・`accepts`・`PAYMENT-REQUIRED` は付けない。`no-store`。

- x402 のクライアント (x402-fetch / x402-axios) は 402 にだけ反応して払う。決済条件つきの 402 を返すと、すでに
  払った支払いの再送に「もう一度払って」と答えることになり、二重払いを招く。409 は自動では払われない。
- 一般的な再試行のライブラリ (got・ky・axios-retry の既定) は 408・429・5xx を再試行し、402 と 409 は再試行
  しない。だから 409 で再試行の繰り返しにならない。OpenPay 自身のゲートも、authorization の衝突に決済条件を
  付けない 409 を返す。
- 上流の失敗のあとは予約を外すので、got や ky が 502 を同じヘッダーで自動で再試行しても 409 にはならない
  (請求していない支払いに「払い直さないで」と答えない)。例外は上流の時間切れの 502 で、上流の呼び出しが終わる
  までの再試行は 409 になる (同じ支払いで上流を同時に 2 回動かさないため。どちらのアダプタも 125 秒より前に
  止まるので、まれ)。

### facilitator の予約の token

verify の 200 の本文の `reservationToken` が `^[A-Za-z0-9_-]{1,71}$` に合えば、そのまま settle の本文の一番上に
`reservationToken` として付ける (切り詰めたり直したりしない)。なければ `verify ok without reservation token (jpyc)`、
形が合わなければ `verify returned malformed reservation token (jpyc)` を記録し、token なしで settle する
(必須にはしない。計画の R8)。

**いまの OpenPay では、token はどの結果も変えない。** facilitator の settle は、token の有無にかかわらず
最初に verify した resource と照合し、token は渡されたときだけ照合する。記録は SET NX で 1 回だけ書かれるので、
記録があれば token はこちらが受け取ったものと同じ。token は、OpenPay が token を必須にしたときのための準備で、
守りとしては数えない。155 秒の窓は facilitator が token を出す条件 (残り 95 秒以上) を満たすので、上の記録が
出るのは、同じ支払いの 2 回目の verify か OpenPay 側の KV の不調のとき。

### 本番で確かめたこと (2026-11-16・支払いなしの 402 を GET で読んだだけ)

- 支払いの期限: 出品の JPYC の `maxTimeoutSeconds` は 600、Base は 300、Arc は 604900。OpenPay の買い手の例
  (`examples/x402-jpyc-client.ts`・`scripts/x402-buyer-example.mjs`) は、`validBefore` を「いま + 600 秒」
  (または `maxTimeoutSeconds` と facilitator の上限 1200 秒の小さいほう) で署名する。どれも 155 秒の窓に収まる。
  要るのは、届いたときと verify のあとの両方で期限までの残りが 155 秒以上あること。足りなければ 402 `insufficient_validity_window`。
- 出品の JPYC の条件は鍵を作れる形だった (asset・merchant・feeReceiver はアドレス、merchantValue と feeValue は
  10 進の正規形、payTo は forwarder と同じ)。作れない形だと、C2 で JPYC の販売がすべて 500 になる。
- `q` の上限: 最小の形の JPYC の支払いと 71 文字の token で、`q` が空の settle の本文は 1692 byte。
  残り 2404 byte が、パーセント符号化した `q` に使える (英数字でおよそ 2404 文字、日本語でおよそ 267 文字)。
  出品の説明には日本語が入っているので、文字数ではなく UTF-8 の byte で数える必要がある。

### この仕組みで守れないこと

| 守れないこと | 理由・代わり |
|---|---|
| Vercel の別のインスタンスに届いた同じ支払い | 予約はプロセスの中だけ。共有ストアが要る (未対応)。JPYC も上流の 2 回目は止められない: 2 回目の verify も (token なしで) 通り、同じ resource の settle は facilitator が同じ決済として通す (Fable の指摘)。だから同じ URL の使い回しは上流が 2 回動く。ただし回答を渡すのは 1 回: OpenPay origin/main では、使用済みの authorization (`forwarderRecover`) と重複した送信 (`relayBroadcast`) を「進行中」として 202 を返すので、2 回目はこちらが 502 `settlement_pending` にする (Codex の確認)。別の `q` の使い回しは facilitator が最初に verify した resource と合わないので決済されない (それでも上流は 1 回ただで動く)。ただしこれは facilitator が verify のときに記録を残せたときだけで、記録は OpenPay 側の KV に頼る (verify は KV の失敗を飲み込み、settle は記録がなければ既存の冪等性と nonce の確かめに任せる)。Base は relay 側にも同じ仕組みがない。Arc は relay の pending の印が 15 分止める |
| 資金のあるウォレットが新しい署名を作り続けること | 予約は同じ署名の使い回ししか止めない。上流を失敗させ続ければ、上流はただで動く。抑えられるのは Vercel の WAF のレート制限だけ (計画の N2 / R12。持ち主の作業) |
| JPYC の再試行で URL を変えること | facilitator は最初に verify した resource に支払いを結びつける。払い直さずに再試行するときは同じ URL (同じ `q`) で |
| 買い手の時計が大きく遅れていること | Base の支払いの期限は 300 秒なので、署名から届くまでに 145 秒より長くかかると 402 `insufficient_validity_window` |
| 請求されていないのに 409 になること | settle が断られた (402)、settle で relay が 409 を返した、facilitator の settle が 429 を返した、のあとに同じ支払いを送ると 409 になる。上流の時間切れ (502) のあとも、上流の呼び出しが終わるまでは 409 (どちらのアダプタも 125 秒より前に止まるので、まれ)。どれも最初の応答で「この支払いは通らなかった」と伝えている (402 と決済条件)。新しい支払いで出し直してもらう。settle を送ったあとは、請求されたかどうかをこちらが確かめられないので、安全な側 (409) に倒す |
| 期限のあと・再起動のあとの再送 | 残した予約は `validBefore` で忘れ、再起動ですべて消える。`502 settlement_pending` / `500 settlement_unknown` の支払いを期限のあとに送り直すと、決済条件つきの 402 `insufficient_validity_window` になる (Base では署名からおよそ 5 分)。C2 の前も OpenPay の verify が 402 を返していたので、C2 で増えも減りもしない。次の候補: settle の結果が決済・進行中・不明の予約を、期限のあとも一定時間残す |
| 長い支払い (q ではない) | 買い手の支払いが大きすぎて本文が上限を超えるときも 400 `q_too_long` になる (本文の大きさで判定するため)。正しい買い手の支払いは 400 byte ほどで、ここには当たらない |

### やっていないこと

- **C2b (C2 のあとの別の PR):** settle が 202 か結果不明のとき、JPYC だけ facilitator の status に問い合わせる
  (3 回まで・30 秒以内・要求の開始から 270 秒を超えない。`state: 'settled'` のときだけ結果を変える。`unused` は
  「請求されていない」ではないので 402 にしない。relay には status がない)。
- アダプタごとに上流の上限を変えること (http は 35 秒など)。1 つの定数のほうが期限の窓の規則が簡単なので、しない。
- 予約の鍵が作れることの確かめのうち、USDC の条件の側 (network と asset) は、`validateUsdcFace` と `arcFaceProblem` が
  すでに保証しているので外れない (型を絞るための確かめで、守りとしては数えない)。
- relay の `authorization_in_use` を 409 に読み替えること。こちらが時間切れにした verify でもその印が残るので、
  正直な買い手を 15 分止めてしまう。しない。
- JPYC の token を必須にすること。持ち主の最初の実購入で token が返ることを確かめてから (計画の R8)。

### golden テストの変化 (384 場面)

挙動を固定するテストのうち、324 場面は変更なし。60 場面が変わり、内訳は次の 3 つだけ (場面の増減なし):

- 53 場面: JPYC の verify が通る場面で、記録に `verify ok without reservation token (jpyc)` が 1 行増えた
  (golden の facilitator は token を返さない)。応答・fetch・上流の呼び出しは同じ。
- 6 場面: 支払いから鍵が作れないので、OpenPay にも上流にも何も送らずに 402 `invalid_payment_payload` になった
  (以前は OpenPay の作り物の応答が通していた)。`X-PAYMENT` が JSON の `null` / `base-sepolia` と
  `eip155:8453` を名乗る中身のない支払い (USDC 面ありで JPYC の rail に回るもの) / 空の `PAYMENT-SIGNATURE`
  (Base と Arc) / 読めない `PAYMENT-SIGNATURE`。本物の OpenPay も断る支払いで、買い手に返る理由の文字列が
  `invalid_payment_payload` に揃った。
- 1 場面 (`Arc payment with an unpadded PAYMENT-SIGNATURE`): テストの支払いに authorization を入れた
  (rail の選び方を確かめる場面なので、鍵が作れる支払いにした)。支払いの base64 だけが変わり、それ以外は同じ。

golden にない、買い手に見える変化: USDC (Base / Arc) の支払いで、`validBefore` が数・nonce がない (または 32 byte の
16 進でない)・支払い者が読めないものは、relay の判定ではなく、OpenPay に送らずに 402 `invalid_payment_payload` に
なる (x402 の exact のクライアントは、どれも文字列で入れる)。

### テスト

- test/claims.test.ts: 鍵 (正規化・作れない支払いと条件・v1 と v2 の同じ nonce・Arc と Base の別の鍵)、
  窓の境目 (155 秒ちょうどは通る・1 秒足りないと断る・1 ミリ秒の端数)、予約と外し方、owner の確かめ、
  `validBefore` と 8 日の上限で忘れること。
- test/reservation.test.ts: 409 の本文とヘッダー、処理中と決済後の同じ支払い、別の `q` の同じ支払い、
  v1 と v2 の同じ nonce、包み直した Arc の支払い、終わり方ごとの外す・残す (上の表の全行)、作れない支払いと
  条件、verify の前と後の窓、token (渡す・ない・長すぎる・文字列でない・ほかの文字)、本文の上限の境目
  (4096 byte ちょうどは売れる・1 byte 多いと 400・UTF-8 の byte で数える・USDC には上限をかけない)、
  上流の時間切れ (偽のタイマーで 125 秒・時間切れのあとも上流が終わるまで 409・終わったら売れる・
  間に合ったときにタイマーを残さない)、所要時間の定数。
- 既存のテスト (route / openpay / purchase / openapi) は、同じ支払いを 2 回使う場所を別の支払いにし、
  中身のない支払いを本物の形にした。テストごとに予約を消す (`resetClaims`)。
- わざと壊して落ちることを確かめた (20 通り): 外さない・いつも外す・残さない (処理中のまま)・settle の前に
  残すに切り替えない・settle の呼び出しの前に残すに切り替える・時間切れですぐ外す・処理中の予約も期限で消す・
  窓を予約より先に見る・verify のあとの窓の確かめを消す・本文の確かめを消す・窓の境目を 1 秒ずらす・8 日の上限を
  消す・owner の確かめを消す (外す・残すの 2 つ)・token を渡さない・token の長さの上限をずらす・文字数で数える・
  仮の token を短くする・タイマーを止めない・Arc の鍵を Base の条件で作る。どれも新しいテストのどれかが落ちる。

### レビューの経過

- 計画レビュー (Opus 5.5、2026-11-16): go with changes。10 件 (上流の失敗では外す・409 の本文・8 日の上限・
  verify の前の確かめの順番・本文の組み立てを 1 つに・タイマー・テストごとに予約を消す・守れないことの表・本番の
  確かめ・テストの追加) を反映した。
- 計画レビュー (Fable 5.2、実装と並行): go with changes。予約済みかを窓より先に見る (二重請求の防止)・本番の
  支払いの期限の確かめ・JPYC もインスタンスをまたぐと上流が 2 回動くこと、を反映した。任意の指摘 (golden にない
  変化・請求されていない 409・長い支払いの 400・時間切れの遅れた外し・アダプタの期限のテスト) も反映した。
- コードレビュー (Codex gpt-6.1-sol xHigh・読むだけ): P0 なし。P1 1 件 (窓と予約の順番、Fable と同じ)・P2 2 件
  (処理中の予約が期限で消える・settle を送る前に止まっても残す)・P3 1 件 (C2 の前の長い `q` の説明の誤り) を直した。
- 修正差分の確認 (Codex): 4 件とも直っている。P0〜P2 の新しい指摘なし (3 つのコードの修正は、それぞれ戻すと
  テストが落ちることも Codex が確かめた)。P3 2 件 (インスタンスをまたぐ JPYC の同じ URL でも回答は 1 回・期限の
  条件は「残り 155 秒以上を 2 回」) を直した。
- 最終監査 (Fable 5.2): 出してよい (文書と PR の本文の直しのみ)。別の `q` の照合は facilitator が記録を残せたときだけ・
  時間切れの 502 のあとの 409・アダプタの期限のテストは定数の関係だけ・期限のあとと再起動のあとの再送、を書き足した。
