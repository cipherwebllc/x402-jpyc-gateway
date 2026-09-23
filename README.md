# x402 JPYC Gateway

**既存の API を 1 行も変更せずに、JPYC の「1 支払い = 1 リクエスト」API にするゲートウェイ**です。AWS WAF や Cloudflare が示した「インフラ側で x402 化する」アプローチの日本円 (JPYC) 版 — アプリの前段にこのプロキシを置くだけで、AI エージェントが [OpenPay AI ストア](https://open-pay.jp/discovery)経由であなたの API に都度課金できるようになります。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcipherwebllc%2Fx402-jpyc-gateway&env=MY_RESOURCE_URL,MY_RESOURCE_ID,EXPECTED_RECIPIENT,ADAPTER,UPSTREAM_URL,IC_IDENTITY_SEED&envDescription=MY_RESOURCE_URL%2C%20MY_RESOURCE_ID%20and%20EXPECTED_RECIPIENT%20are%20required.%20For%20a%20first%20deployment%2C%20follow%20the%20README%20placeholder%20setup.%20EXPECTED_USDC_RECIPIENT%20is%20optional%20and%20enables%20USDC.&project-name=x402-jpyc-gateway&repository-name=x402-jpyc-gateway)

アダプタ式で、同梱は 2 種:

- `http` — **任意の JSON API** に中継 (コード変更ゼロの課金化)
- `coo-icp` (既定) — Internet Computer の coo-icp canister (`chat : (text) -> (text)`) に中継。[実売実績あり](https://open-pay.jp/discovery)

決済の実体 (署名検証・オンチェーン決済・手数料分割) は OpenPay のファシリテーターが行い、このゲートウェイは鍵もお金も持ちません。

## 5 分クイックスタート — 既存 API を課金化する (`http` アダプタ)

1. 上の **Deploy with Vercel** を押し、`ADAPTER=http`・`UPSTREAM_URL=<あなたの JSON API>` を設定します。初回で URL と出品 ID が未確定なら、仮の値として `MY_RESOURCE_URL=https://placeholder.invalid/api/consult`・`MY_RESOURCE_ID=pending-listing`・`EXPECTED_RECIPIENT=pending-wallet` を入力してデプロイします。**この段階は設定エラーになるのが正常で、`/` を含む全ルートは 500 になります。**
2. Vercel に表示された実際のデプロイ先 URL に `/api/consult` を付け、[open-pay.jp/discovery](https://open-pay.jp/discovery) で自分の出品として URL と価格 (JPYC 整数) を登録します。OpenPay の掲載プローブはこの段階の 500 を判定不能として扱うため、出品 ID を取得できます。
3. Vercel の Environment Variables で `MY_RESOURCE_URL=<登録した実 URL>`・`MY_RESOURCE_ID=<自分の出品 ID>`・`EXPECTED_RECIPIENT=<自分の JPYC 受取ウォレット>` に置き換え、再デプロイします。USDC も販売する場合だけ `EXPECTED_USDC_RECIPIENT` を設定します。

カスタムドメイン、または重複しないプロジェクト名で URL を先に確定できる場合は、OpenPay への掲載を先に済ませ、実際の ID・受取先を使って初回からデプロイできます。

以上で、AI エージェント (Claude + [openpay-x402-mcp](https://www.npmjs.com/package/openpay-x402-mcp)、または [openpay-x402-sdk](https://www.npmjs.com/package/openpay-x402-sdk)) から JPYC で購入可能になります。売上は登録したウォレットに満額直接着金します (手数料は買い手上乗せ)。

---

価格と手数料は OpenPay のカタログにある `accepts` を使います。出品 ID と受取先は自分の設定で固定し、取得した掲載情報を照合します。同じ URL の別出品を採用することはありません。受取先の設定値を discovery 応答から自動設定しないでください。

## セットアップ

Node.js 20.9 以降を使用します。

```sh
npm install
cp .env.example .env.local
# 起動前に .env.local の出品 ID・JPYC 受取先・URL・アダプタ設定を入力 (USDC は任意)
npm run dev
```

環境変数はローカルでは `.env.local`、Vercel では Project Settings の Environment Variables に設定します。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `MY_RESOURCE_URL` | はい | OpenPay に登録するクエリなしの完全な API URL。例: `https://example.vercel.app/api/consult` |
| `MY_RESOURCE_ID` | はい | 自分の OpenPay 出品一覧に表示される ID。前後の空白は不可。`GET /api/discovery/<ID>` で取得し、URL 検索には戻りません |
| `EXPECTED_RECIPIENT` | はい | 自分で管理する JPYC 受取ウォレット (`0x` + 40 桁の hex)。`accepts[].extra.openpay.merchant` と照合します。`payTo` の forwarder アドレスではありません |
| `EXPECTED_USDC_RECIPIENT` | いいえ | 未設定・空なら JPYC のみ。設定する場合は OpenPay 側 USDC 面に登録した自分の受取ウォレット (`0x` + 40 桁の hex) と一致させます |
| `ADAPTER` | いいえ | `coo-icp`（既定）または `http` |
| `COO_CANISTER_ID` | `coo-icp` 時 | coo-icp の canister ID |
| `IC_HOST` | いいえ | IC エンドポイント。既定は `https://icp-api.io` |
| `IC_IDENTITY_SEED` | 強く推奨 | 設定時は SHA-256 から決定的な Ed25519 identity を生成。未設定なら匿名 identity になるが、coo-icp は caller 毎に会話履歴を保持し**匿名 principal の履歴は誰でも読める**ため、必ずランダムな秘密値を設定すること |
| `UPSTREAM_URL` | `http` 時 | JSON を返す上流 API URL |

必須設定の欠落、出品 ID の前後の空白、不正な受取アドレスは、起動時に `OpenPay seller gate: ...` でまとめて報告します。受取先にゼロアドレスや既知の burn アドレス (`0x000000000000000000000000000000000000dEaD`、`0xdead000000000000000000000000000000000000`) は指定できません。設定エラー中は `/` を含む全ルートが利用できません。

本番が main の変更を自動デプロイする場合は、**merge 前に** `MY_RESOURCE_ID` と `EXPECTED_RECIPIENT` が実際の自分の出品・ウォレットの値になっていることを確認してください。既存の USDC 販売を維持する場合は `EXPECTED_USDC_RECIPIENT` も先に設定します。未設定なら更新後は JPYC のみになります。

受取先を変更するときは、OpenPay 側の登録と対応する `EXPECTED_RECIPIENT` / `EXPECTED_USDC_RECIPIENT` を揃えて更新し、再デプロイしてください。切替途中は pin 不一致による 500 を想定してください。

`http` アダプタは `UPSTREAM_URL` に `q` クエリを付けて GET し、その JSON を返します。coo-icp は `chat(q)` の応答を `{ "answer": "..." }` として返します。

coo-icp canister は caller (principal) 毎に会話履歴を蓄積して LLM のコンテキストに使うため、ゲートウェイは「1 支払い = 独立した 1 問 1 答」を守る目的で毎回 `chat` の前に `clear_conversation` を呼びます (per-caller なので他の利用者の会話には影響しません)。なお同時に複数の支払いリクエストが重なった場合、clear と chat の間に他のリクエストが割り込み、直前の質問が文脈に混ざる可能性が理論上残ります (低トラフィックでは実質問題になりません)。

## Vercel へのデプロイ

1. このリポジトリを Git プロバイダーへ push し、Vercel で Import します。
2. URL が未確定なら、クイックスタートの仮設定で一度デプロイし、実 URL を使って OpenPay に掲載します。URL が先に確定している場合は掲載から始められます。
3. 自分の出品 ID と受取先を使って上表の環境変数を Production（必要なら Preview も）に登録し、Vercel の既定の Next.js ビルド設定で再デプロイします。`MY_RESOURCE_URL` は最終的な Production URL と完全一致させます。
4. 必須設定が揃っていても、出品が見つからない・非公開・掲載情報が不一致・OpenPay が一時停止中の場合は `500 {"error":"accepts_unavailable"}` を返し、402 や支払い処理を行いません。サーバーログは 404 を `OpenPay listing not found or not public (HTTP 404)`、5xx を `OpenPay temporarily unavailable (HTTP <status>)` と区別します。設定不足は起動時のエラーです。

## OpenPay への掲載

仮設定での初回デプロイ、またはカスタムドメイン・重複しないプロジェクト名で実 URL を確定し、[open-pay.jp/discovery](https://open-pay.jp/discovery) で SIWE 接続して次を登録します。

1. URL に `MY_RESOURCE_URL` と完全に同じ値を入力します。
2. 価格は JPYC の整数で指定し、説明には英語で `1 question per payment, returns {answer}` のようなエージェントが解釈しやすい内容を記載します。
3. カテゴリは `api`、Docs URL と利用条件を設定します。
4. 正当性表明を行って登録します。
5. 自分の出品一覧から ID を `MY_RESOURCE_ID` に設定し、自分で管理する JPYC 受取先を `EXPECTED_RECIPIENT` に設定して再デプロイします。USDC を販売する場合は、OpenPay 側 USDC 面に登録した受取先を `EXPECTED_USDC_RECIPIENT` にも設定します。

掲載・設定・デプロイ後、次で 402 を確認します。取得した出品の ID・URL・JPYC 受取先・forwarder を検証してから、掲載値を 5 分キャッシュします。

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

## USDC (Base) 併売と x402 Bazaar 掲載

OpenPay 側で `MY_RESOURCE_ID` の出品の USDC 面を有効化し、OpenPay 側 USDC 面に登録した受取先と `EXPECTED_USDC_RECIPIENT` が一致することを確認して再デプロイします。JPYC と同じ受取先なら同じアドレスを設定できます。ゲートは v1・v2・厳密な base64 検査を通った `PAYMENT-REQUIRED` ヘッダ内の全受取先と、network・asset・scheme・amount の整合性を検証してから USDC 面を提示します。

`EXPECTED_USDC_RECIPIENT` が未設定または空なら USDC 面を取得・提示せず、USDC 支払いも受け付けません。JPYC だけで販売する場合はこの変数を空にしてください。`MY_RESOURCE_ID` と `EXPECTED_RECIPIENT` は JPYC のみの場合も必須です。

デプロイ後、次の確認で 402 本文の `accepts` が JPYC、USDC の順に 2 件あり、`PAYMENT-REQUIRED` ヘッダも返ることを確認します。

```sh
curl -i "$MY_RESOURCE_URL"
```

```http
HTTP/2 402
payment-required: ...

{"x402Version":1,"accepts":[{"network":"eip155:137","...":"..."},{"network":"base","...":"..."}],"error":"payment_required"}
```

この表示確認だけでは x402 Bazaar / agentic.market への掲載は確定しません。**最初の実際の USDC 購入 1 件が settle された時点**で、CDP を通じた掲載が開始されます。USDC 売上は出品者アドレスへ直接着金し、OpenPay の USDC 側手数料は 0% です。USDC requirements 面の非 2xx・通信失敗・JSON 読み取り失敗は、従来どおり JPYC のみへ縮退します。取得できた出品 ID・受取先・決済条件が検証に失敗した場合は両レールを停止してログに理由を記録し、JPYC のみに縮退しません。

USDC の verify / settle には検証済みの決済条件も送信します。掲載内容の変更でリレーが 409 を返した場合、USDC キャッシュを破棄してその場で再取得・再検証し、新しい決済条件と `PAYMENT-REQUIRED` ヘッダを含む `402 requirements_mismatch` を返します。買い手は新しい条件を確認して再試行できます。元の支払いは自動再送しません。再取得や pin 検証に失敗した場合は 500 を返し、古い条件での支払い処理を続けません。

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

このゲートウェイのアプリケーションは、設定不足・出品取得失敗・受取先や決済条件の不一致について固定の理由だけをサーバーログに記録します。ログとエラーレスポンスに質問、回答、支払いデータ、ウォレットアドレス、リソース URL は含めません。全レスポンスは `Cache-Control: no-store` です。

ただし、構造上 `q` はリソース URL のクエリとして OpenPay に、また上流（coo-icp または `UPSTREAM_URL`）に届きます。Vercel などのプラットフォームアクセスログにも記録される可能性があります。このリポジトリだけでそれら外部ログを制御することはできません。

## 検証

```sh
npx tsc --noEmit
npx eslint .
npx vitest run
npx next build
```
