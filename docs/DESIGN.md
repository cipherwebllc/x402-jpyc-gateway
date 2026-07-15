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
  `@icp-sdk/core/agent` / `@icp-sdk/core/candid` 等のサブパス)。IDL は
  `IDL.Service({ chat: IDL.Func([IDL.Text], [IDL.Text], []) })` (update call)。
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

## 13. 既存スキャフォールド

設計者 (Fable) が先行作成済み — 実装時はこれを土台に完成・修正してよい:
- package.json / tsconfig.json (スクリプト・paths 設定済み、依存は未インストール)
- lib/gate.ts (§4 をほぼ実装済み)
- lib/adapters/types.ts, lib/adapters/http.ts
