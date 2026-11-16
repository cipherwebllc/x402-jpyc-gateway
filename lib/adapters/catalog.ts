// アダプタの名前ごとの、設定がそろっているかと /openapi.json に載せる 200 の応答の schema。
// アダプタ本体 (coo-icp.ts / http.ts) は import しない。/openapi.json に ICP の SDK を読み込ませないため。

type CatalogEntry = {
  // 呼ぶたびに env を読む。値の形 (URL として正しいか等) は見ない。
  configured(): boolean;
  outputSchema: Record<string, unknown>;
};

// Map にするのは、ADAPTER=toString のような値で Object.prototype の中身を拾わないため。
const CATALOG = new Map<string, CatalogEntry>([
  ['coo-icp', {
    configured: () => Boolean(process.env.COO_CANISTER_ID && process.env.IC_IDENTITY_SEED),
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  }],
  ['http', {
    configured: () => Boolean(process.env.UPSTREAM_URL),
    // 上流の JSON をそのまま返すので、形を決められない。
    outputSchema: { description: 'JSON returned by the upstream API, relayed as is' },
  }],
]);

/** env ADAPTER の値。未設定なら coo-icp。 */
export function selectedAdapterName(): string {
  return process.env.ADAPTER || 'coo-icp';
}

/**
 * 選んだアダプタが動く設定のときだけ、その応答の schema を返す (ADAPTER が不明なら null)。
 * 呼ぶたびに複製を返し、文書を書き換えられても次の文書に残らないようにする。
 */
export function selectedAdapterSchema(): Record<string, unknown> | null {
  const entry = CATALOG.get(selectedAdapterName());
  return entry?.configured() ? structuredClone(entry.outputSchema) : null;
}
