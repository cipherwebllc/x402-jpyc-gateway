// 支払いの各モジュールが共有する型。sellerPins.ts もここから読むので、型だけの循環が起きない。

export type PaymentRequirements = {
  resource?: string;
  [key: string]: unknown;
};

export type UsdcFace = {
  resourceId: string;
  v1Accepts: PaymentRequirements;
  v2Accept: PaymentRequirements;
  paymentRequiredHeader: string;
  /** Arc (Circle Gateway) face: v2 only. The header lists Base then Arc, built by the relay. */
  arc?: { v2Accept: PaymentRequirements; paymentRequiredHeader: string };
  [key: string]: unknown;
};

export type UsdcRail = 'base' | 'arc';

export type SellerConfig = {
  resourceId: string;
  resourceUrl: string;
  expectedRecipient: string;
  expectedUsdcRecipient?: string;
};

export type CatalogItem = {
  id: string;
  resource: string;
  accepts: PaymentRequirements[];
};
