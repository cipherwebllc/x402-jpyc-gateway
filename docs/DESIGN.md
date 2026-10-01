# x402-jpyc-gateway 設計ドキュメント

Status: final (Sonnet 調査 + Codex GPT-5.6 Terra xhigh 計画レビュー裁定済み — これが実装仕様)
Date: 2026-07-15 (seller pin 対応: 2026-09-23、§15)

## 1. ゴール

OpenPay (open-pay.jp) の x402 ファシリテーターを使い、任意の上流 API を
「1 支払い = 1 リクエスト」で JPYC 課金化する汎用ゲートウェイ。
Next.js App Router (TypeScript)、Vercel にデプロイ可能。
第 1 アダプタは coo-icp (Internet Computer 上の Rust canister、Candid `chat : (text) -> (text)`)。

## 2. 非ゴール (やらないこと)

- 独自の価格/手数料ロジック — 価格・手数料はカタログ accepts を使う。
  出品 ID と受取ウォレットは env に固定し、取得した決済条件を照合する (§15)。
- 会話の継続 (1 支払い = 独立した 1 問 1 答)
- coo-icp 本体の変更

## 3. ファイル構成と責務

```
lib/gate.ts               OpenPay 402 ゲート (公式スニペットの TS 化 + 2 変更 + seller pin)
lib/sellerPins.ts         必須設定・JPYC/USDC の seller pin 検証
lib/paymentHeader.ts      買い手/USDC requirements 共通の厳密な base64/JSON デコード
instrumentation.ts       Next.js サーバー起動時の必須設定検査
lib/adapters/types.ts     Adapter = (input: { q: string }) => Promise<unknown>
lib/adapters/http.ts      汎用: UPSTREAM_URL に ?q= を付けて GET、JSON 中継
lib/adapters/coo-icp.ts   @icp-sdk/core (agent) で canister chat(text) を update call
lib/adapters/index.ts     env ADAPTER による選択 (coo-icp | http)
app/api/consult/route.ts  GET ハンドラ (処理順は §5)
app/layout.tsx, page.tsx  最小の説明ページ (無くてもよいが案内用に置く)
test/route.test.ts        ゲート+route の結合テスト (fetch/adapter 全モック)
test/gate.test.ts         起動設定・出品 pin・キャッシュ・USDC 決済条件のテスト
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
| IC_IDENTITY_SEED | - | 未設定なら匿名 identity |
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

アダプタ (`test/coo-icp.test.ts`): Actor をモックし q → chat(q) → `{ answer }` の写像を確認。
canister ID / host / identity (匿名・seed) の受け渡しも確認。
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
- `usdcFace(): Promise<UsdcFace | null>` — 必須 pin を検査。EXPECTED_USDC_RECIPIENT が未設定・空なら
  cache を使わず fetch もせず null。設定時は検証済み requirements のみキャッシュ (支払いあり 5 分・支払いなし 30 分。§16 訂正)。
  非 2xx / JSON 読み取り失敗 / fetch 例外 → null (非キャッシュ)。
  取得できた値の ID・全受取先・決済条件の不一致や欠落 → throw、両レールを停止 (§15)。
- `json402(accepts, error, paymentRequiredHeader?)` — 第 3 引数があれば `PAYMENT-REQUIRED`
  ヘッダ付与。既存呼び出しは無変更で動く。
- `relayPayment(path: 'verify'|'settle', headers: {paymentHeader?; paymentSignatureHeader?}, face: UsdcFace, jpycAccepts)`
  — 上記 POST、通常は `r.json()`、409 は再検証済みの 402 Response を返す。
  USDC pin 未設定なら送信を拒否。fetch/JSON/再検証の例外は route が 500 に変換。
- `resetUsdcFaceCache()` (テスト用)。

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
