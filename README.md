# x402 JPYC Gateway

OpenPay の x402 ファシリテーターを使い、上流 API を JPYC の「1 支払い = 1 リクエスト」API にする Next.js ゲートウェイです。標準アダプタは Internet Computer の coo-icp canister (`chat : (text) -> (text)`) で、任意の JSON API に中継する HTTP アダプタもあります。

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
| `ADAPTER` | いいえ | `coo-icp`（既定）または `http` |
| `COO_CANISTER_ID` | `coo-icp` 時 | coo-icp の canister ID |
| `IC_HOST` | いいえ | IC エンドポイント。既定は `https://icp-api.io` |
| `IC_IDENTITY_SEED` | いいえ | 設定時は SHA-256 から決定的な Ed25519 identity を生成。未設定なら匿名 identity |
| `UPSTREAM_URL` | `http` 時 | JSON を返す上流 API URL |

`http` アダプタは `UPSTREAM_URL` に `q` クエリを付けて GET し、その JSON を返します。coo-icp は `chat(q)` の応答を `{ "answer": "..." }` として返します。

## Vercel へのデプロイ

1. このリポジトリを Git プロバイダーへ push し、Vercel で Import します。
2. 上表の環境変数を Production（必要なら Preview も）に登録します。`MY_RESOURCE_URL` は最終的な Production URL と完全一致させます。
3. Vercel の既定の Next.js ビルド設定でデプロイします。
4. まだ OpenPay に未掲載の段階では `GET $MY_RESOURCE_URL` は `500 {"error":"accepts_unavailable"}` です。これはカタログ掲載前の正常な bootstrap 挙動です。

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

{"x402Version":1,"accepts":[{"scheme":"exact","resource":"https://example.vercel.app/api/consult", "...":"..."}],"error":"payment_required"}
```

OpenPay は毎時自動で再検証します。確定した違反が 3 回連続すると掲載は一時非表示になり、問題を修復すれば自動的に復帰します。

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
