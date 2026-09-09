# x402 JPYC Gateway

**既存の API を 1 行も変更せずに、JPYC の「1 支払い = 1 リクエスト」API にするゲートウェイ**です。AWS WAF や Cloudflare が示した「インフラ側で x402 化する」アプローチの日本円 (JPYC) 版 — アプリの前段にこのプロキシを置くだけで、AI エージェントが [OpenPay AI ストア](https://open-pay.jp/discovery)経由であなたの API に都度課金できるようになります。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcipherwebllc%2Fx402-jpyc-gateway&env=MY_RESOURCE_URL,ADAPTER,UPSTREAM_URL,IC_IDENTITY_SEED,LICENSE_PRODUCT_ID,LICENSE_SESSION_SECRET&envDescription=MY_RESOURCE_URL%2C%20LICENSE_PRODUCT_ID%20and%20LICENSE_SESSION_SECRET%20are%20required.%20Set%20ADAPTER%3Dhttp%20%2B%20UPSTREAM_URL%20to%20monetize%20any%20JSON%20API.&project-name=x402-jpyc-gateway&repository-name=x402-jpyc-gateway)

アダプタ式で、同梱は 2 種:

- `http` — **任意の JSON API** に中継 (コード変更ゼロの課金化)
- `coo-icp` (既定) — Internet Computer の coo-icp canister (`chat : (text) -> (text)`) に中継。[実売実績あり](https://open-pay.jp/discovery)

決済の実体 (署名検証・オンチェーン決済・手数料分割) は OpenPay のファシリテーターが行い、このゲートウェイは鍵もお金も持ちません。

## 5 分クイックスタート — 既存 API を課金化する (`http` アダプタ)

1. 上の **Deploy with Vercel** を押す (またはこのリポを fork して Import)
2. 環境変数を設定: `ADAPTER=http`・`UPSTREAM_URL=<あなたの JSON API>`・`MY_RESOURCE_URL=<デプロイ先の /api/consult URL>` に加え、下記の `LICENSE_PRODUCT_ID` と `LICENSE_SESSION_SECRET` が必須です。対象の OpenPay ライセンス商品を用意してからデプロイします。
3. [open-pay.jp/discovery](https://open-pay.jp/discovery) で `MY_RESOURCE_URL` と価格 (JPYC 整数) を登録

以上で、AI エージェント (Claude + [openpay-x402-mcp](https://www.npmjs.com/package/openpay-x402-mcp)、または [openpay-x402-sdk](https://www.npmjs.com/package/openpay-x402-sdk)) から JPYC で購入可能になります。売上は登録したウォレットに満額直接着金します (手数料は買い手上乗せ)。

---

価格、手数料、受取先はこのリポジトリでは設定しません。OpenPay のカタログにある `accepts` が唯一の権威です。

## セットアップ

Node.js 20.9 以降を使用します。

```sh
npm install
cp .env.example .env.local
npm run dev
```

環境変数はローカルでは `.env.local`、Vercel では Project Settings の Environment Variables に設定します。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `MY_RESOURCE_URL` | はい | OpenPay に登録するクエリなしの完全な API URL。例: `https://example.vercel.app/api/consult` |
| `MY_RESOURCE_ID` | いいえ | OpenPay 出品一覧の dual-rail スニペットに表示される ID。空なら JPYC のみ |
| `ADAPTER` | いいえ | `coo-icp`（既定）または `http` |
| `COO_CANISTER_ID` | `coo-icp` 時 | coo-icp の canister ID |
| `IC_HOST` | いいえ | IC エンドポイント。既定は `https://icp-api.io` |
| `IC_IDENTITY_SEED` | 強く推奨 | 設定時は SHA-256 から決定的な Ed25519 identity を生成。未設定なら匿名 identity になるが、coo-icp は caller 毎に会話履歴を保持し**匿名 principal の履歴は誰でも読める**ため、必ずランダムな秘密値を設定すること |
| `UPSTREAM_URL` | `http` 時 | JSON を返す上流 API URL |
| `LICENSE_PRODUCT_ID` | はい | OpenPay のライセンス商品 ID。`h_` + 小文字 hex 32 桁 (`^h_[0-9a-f]{32}$`) |
| `LICENSE_SESSION_SECRET` | はい | 32 UTF-8 bytes 以上の server-only ランダム秘密値 |
| `POLYGON_RPC_URL` | いいえ | ライセンス保有を確認する HTTP(S) RPC URL。未設定なら SDK の Polygon 既定 RPC |
| `LICENSE_ORIGIN` | いいえ | descriptor の取得先。既定 `https://open-pay.jp`。HTTPS の origin のみ（認証情報・パス・クエリ・fragment 不可） |

`http` アダプタは `UPSTREAM_URL` に `q` クエリを付けて GET し、その JSON を返します。coo-icp は `chat(q)` の応答を `{ "answer": "..." }` として返します。

coo-icp canister は caller (principal) 毎に会話履歴を蓄積して LLM のコンテキストに使うため、ゲートウェイは「1 支払い = 独立した 1 問 1 答」を守る目的で毎回 `chat` の前に `clear_conversation` を呼びます (per-caller なので他の利用者の会話には影響しません)。なお同時に複数の支払いリクエストが重なった場合、clear と chat の間に他のリクエストが割り込み、直前の質問が文脈に混ざる可能性が理論上残ります (低トラフィックでは実質問題になりません)。

## ライセンス購入 → 接続 → 従量利用

このバージョンでは OpenPay ライセンス NFT が入場条件です。まず `/health` または 402 本文の `license.productUrl` が示す OpenPay 商品ページでライセンスを購入し、保有ウォレットを接続してから、従来どおり各リクエストを JPYC または USDC で支払います。

`openpay-x402-sdk ^0.7.1` が商品 ID から descriptor を解決し、チェーン・コントラクト・token ID・購入 URL を取得します。`MY_RESOURCE_URL` は引き続き必須で、その origin がウォレット署名とセッションの audience になります。`LICENSE_ORIGIN` を変更しても、SDK は descriptor の `productUrl` / `verifyUrl` が `open-pay.jp` 配下であることを要求します。

購入先は次で確認できます。

```sh
curl -sS "https://your-gateway.example/health"
```

接続では、最初にウォレット用の署名メッセージを取得します。

```sh
curl -sS "https://your-gateway.example/license/challenge?address=0xYOUR_WALLET_ADDRESS"
```

返された `message` をそのウォレットで署名し、署名結果を検証します。

```sh
curl -i -X POST "https://your-gateway.example/license/verify" \
  -H 'content-type: application/json' \
  --data '{"message":"SIGNED_MESSAGE_TEXT","signature":"0xWALLET_SIGNATURE"}'
```

成功レスポンスの `token` は HttpOnly cookie にも設定されます。cookie を使わないクライアントは、その token を Bearer として従量課金リクエストに添付します（支払いヘッダは従来どおり別途必要です）。

```sh
curl -i "https://your-gateway.example/api/consult?q=こんにちは" \
  -H "Authorization: Bearer $LICENSE_SESSION_TOKEN" \
  -H "X-PAYMENT: $X402_PAYMENT"
```

ライセンス専用の設定は **必須 2 つ + 任意 2 つ**です。**既存のデプロイも、このバージョンをデプロイする前に `LICENSE_PRODUCT_ID` と `LICENSE_SESSION_SECRET` を設定してください。** 環境変数の欠落・不正だけでなく、descriptor の取得失敗も `instrumentation.register()` が throw する厳格な起動失敗です。復旧には **プロセス／インスタンスの再起動（Vercel は次のコールドスタート）**が必要であり、次リクエストでの自動復旧は保証されません。各 route にも初期化を await する防御があり、その経路で失敗した場合は `500 {"error":"license_unavailable"}` を返して内部の失敗 Promise を破棄します。

起動成功後、descriptor は 5 分で期限切れとなり、次のリクエストで再取得します。identity が同じなら metadata だけ更新して gate と nonce を保持し、identity が変われば gate を差し替えて保有キャッシュを消去します。再取得に失敗した場合は最後の正常な descriptor を使い続け、30 秒後から再試行できます。`saleActive` / `registered` は表示情報であり、保有判定には使いません。

セッションの有効期間は 300 秒です。Bearer / cookie が有効なら保有 RPC を省略します。セッションがない場合や無効・期限切れでも支払いがある場合は、x402 verify で確定した payer を、取得済み descriptor の identity で確認します。保有結果は true / false とも 60 秒キャッシュし、RPC エラーはキャッシュしません。無保有なら `403 {"error":"license_required","product":"h_…","productUrl":"https://open-pay.jp/…"}`、判定不能なら `503 {"error":"license_check_unavailable"}` となり、アダプタ実行・settle には進みません。支払いもセッションもない GET は掲載確認用の 402 を維持し、本文の `license` に購入情報を含めます。

challenge の nonce はインスタンス内メモリにあり、異なるインスタンス間では共有されない場合があります。serverless で challenge と verify が別インスタンスに届くと検証に失敗し、**challenge を取り直しても成功は保証できません**。将来 SDK の `nonceStore` に共有ストレージを実装できますが、今回の範囲には含めていません。また、SDK の verify は **RPC 呼出より先に nonce を消費する**ため、RPC 失敗後には新しい challenge と署名の両方が必要です。x402 支払いの payer を直接確認する経路には、この nonce ストア制約は影響しません。

## Vercel へのデプロイ

1. このリポジトリを Git プロバイダーへ push し、Vercel で Import します。
2. 上表の環境変数を Production（必要なら Preview も）に登録します。`MY_RESOURCE_URL` は最終的な Production URL と完全一致させます。
3. Vercel の既定の Next.js ビルド設定でデプロイします。
4. ライセンス初期化が成功していて、まだ OpenPay に API が未掲載の段階では `GET $MY_RESOURCE_URL` は `500 {"error":"accepts_unavailable"}` です。これはカタログ掲載前の正常な bootstrap 挙動です。

## OpenPay への掲載

デプロイ後、[open-pay.jp/discovery](https://open-pay.jp/discovery) で SIWE 接続して次を登録します。

1. URL に `MY_RESOURCE_URL` と完全に同じ値を入力します。
2. 価格は JPYC の整数で指定し、説明には英語で `1 question per payment, returns {answer}` のようなエージェントが解釈しやすい内容を記載します。
3. カテゴリは `api`、Docs URL と利用条件を設定します。
4. 正当性表明を行って登録します。

掲載後はカタログの取得を待ち、次で 402 を確認します。

```sh
curl -i "$MY_RESOURCE_URL"
```

概ね次のように `accepts` を含む 402 が返れば準備完了です。

```http
HTTP/2 402
cache-control: no-store
content-type: application/json

{"x402Version":1,"accepts":[{"scheme":"exact","resource":"https://example.vercel.app/api/consult", "...":"..."}],"error":"payment_required","license":{"required":true,"product":"h_0123456789abcdef0123456789abcdef","productUrl":"https://open-pay.jp/@seller?product=h_0123456789abcdef0123456789abcdef","chainId":137,"contract":"0x…","tokenId":"0x…"}}
```

OpenPay は毎時自動で再検証します。確定した違反が 3 回連続すると掲載は一時非表示になり、問題を修復すれば自動的に復帰します。

## USDC (Base) 併売と x402 Bazaar 掲載

OpenPay 側で対象出品の USDC 面を有効化してから、出品一覧の dual-rail スニペットに表示される ID を Vercel の `MY_RESOURCE_ID` に設定し、再デプロイします。未設定または空の場合は従来どおり JPYC のみを提示します。

デプロイ後、次の確認で 402 本文の `accepts` が JPYC、USDC の順に 2 件あり、`PAYMENT-REQUIRED` ヘッダも返ることを確認します。

```sh
curl -i "$MY_RESOURCE_URL"
```

```http
HTTP/2 402
payment-required: ...

{"x402Version":1,"accepts":[{"network":"eip155:137","...":"..."},{"network":"base","...":"..."}],"error":"payment_required","license":{"required":true,"product":"h_0123456789abcdef0123456789abcdef","productUrl":"https://open-pay.jp/@seller?product=h_0123456789abcdef0123456789abcdef","chainId":137,"contract":"0x…","tokenId":"0x…"}}
```

この表示確認だけでは x402 Bazaar / agentic.market への掲載は確定しません。**最初の実際の USDC 購入 1 件が settle された時点**で、CDP を通じた掲載が開始されます。USDC 売上は出品者アドレスへ直接着金し、OpenPay の USDC 側手数料は 0% です。USDC requirements 面が一時的に 404、エラー、または応答不能になった場合、ゲートウェイは自動的に JPYC のみへ縮退し、JPYC での販売を継続します。

## 買い手テスト

Claude Desktop と `openpay-x402-mcp`、または OpenPay 対応 SDK で、支払い付きで次のような URL を呼び出します。

```text
https://your-gateway.example/api/consult?q=こんにちは
```

カタログ trust は URL の完全一致を確認します。`?q=` 付き URL に支払う買い手側では、必ず次のように gateway のホストを許可します。

```sh
ALLOWED_HOSTS=open-pay.jp,your-gateway.example
```

成功すると、本文には上流の JSON（coo-icp では `{ "answer": "..." }`）と、`X-PAYMENT-RESPONSE` ヘッダに base64 化された settle 結果が返ります。

## プライバシー

このゲートウェイのアプリケーションは `console.*` によるログを出力せず、エラーレスポンスにも質問、回答、支払いデータを含めません。全レスポンスは `Cache-Control: no-store` です。

ただし、構造上 `q` はリソース URL のクエリとして OpenPay に、また上流（coo-icp または `UPSTREAM_URL`）に届きます。Vercel などのプラットフォームアクセスログにも記録される可能性があります。このリポジトリだけでそれら外部ログを制御することはできません。

## 検証

```sh
npx tsc --noEmit
npx eslint .
npx vitest run
npx next build
```
