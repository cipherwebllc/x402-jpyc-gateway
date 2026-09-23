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
- ID・`MY_RESOURCE_URL`・全 JPYC merchant・forwarder を照合してから 5 分キャッシュ。URL 検索は禁止
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
  cache を使わず fetch もせず null。設定時は検証済み requirements のみ 5 分キャッシュ。
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
  5 分キャッシュは維持し、pin を再検証して使う。verify / settle 直前にも受取先を照合する。
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
