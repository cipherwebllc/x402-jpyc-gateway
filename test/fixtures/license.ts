import type { LicenseDescriptor } from 'openpay-x402-sdk';
import { keccak256, toBytes } from 'viem';

export const product = 'h_0123456789abcdef0123456789abcdef';
export const descriptor: LicenseDescriptor = {
  version: 1,
  productId: product,
  chainId: 137,
  contract: '0x2222222222222222222222222222222222222222',
  tokenId: keccak256(toBytes(`openpay:license:${product}`)),
  productUrl: `https://open-pay.jp/@gateway?product=${product}`,
  verifyUrl: `https://open-pay.jp/api/license/verify?product=${product}`,
  saleActive: true,
  registered: true,
  transferable: false,
  termsUrl: 'https://open-pay.jp/terms',
  termsVersion: '1',
  supply: 100,
  remaining: 99,
  sellerRole: 'operator',
};
