// アダプタは 1 支払い分の入力 q を受け取り、JSON 化可能な値を返す。
// 失敗は throw で表現する (route 側が未課金のまま 502 に変換する)。
export type Adapter = (input: { q: string }) => Promise<unknown>;
