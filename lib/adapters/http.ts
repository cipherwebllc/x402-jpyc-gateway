import type { Adapter } from './types';

// 汎用 HTTP アダプタ: UPSTREAM_URL に ?q=... を付けて GET し、JSON をそのまま中継する。
// coo-icp 以外の上流に転用するための口。
export const httpAdapter: Adapter = async ({ q }) => {
  const upstream = process.env.UPSTREAM_URL;
  if (!upstream) throw new Error('UPSTREAM_URL is not set');
  const url = new URL(upstream);
  url.searchParams.set('q', q);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('upstream responded ' + res.status);
  return res.json();
};
