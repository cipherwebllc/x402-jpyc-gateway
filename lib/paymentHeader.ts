// 買い手のヘッダーの base64 JSON を復号する。受理する形は 2 通りあり、わざと揃えていない:
// X-PAYMENT と USDC の PAYMENT-REQUIRED は厳密 (padding 必須・空白なし)、PAYMENT-SIGNATURE は
// OpenPay の relay と同じ緩い規則 (padding なしも可)。relay と食い違うと、どの rail の支払いかの判断がずれる。

export function decodePaymentHeader(header: string): unknown | undefined {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
      return undefined;
    }
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

// Same acceptance rules as OpenPay's decodePaymentSignatureHeaderValue (unpadded base64 allowed),
// so the gateway and the relay always agree on which rail a PAYMENT-SIGNATURE pays.
export function decodePaymentSignature(raw: string): unknown {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}
