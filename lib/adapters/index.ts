import { cooIcpDescriptor } from './coo-icp';
import { httpDescriptor } from './http';
import type { Adapter, AdapterDescriptor } from './types';

// Map にするのは、ADAPTER=toString のような値で Object.prototype の中身を拾わないため。
const DESCRIPTORS = new Map<string, AdapterDescriptor>([
  ['coo-icp', cooIcpDescriptor],
  ['http', httpDescriptor],
]);

function selectedDescriptor(): AdapterDescriptor | undefined {
  return DESCRIPTORS.get(process.env.ADAPTER || 'coo-icp');
}

export function selectedAdapter(): Adapter {
  const descriptor = selectedDescriptor();
  if (!descriptor) throw new Error('unknown adapter');
  return descriptor.run;
}

/** 選んだアダプタが動く設定のときだけ、その応答の schema を返す (ADAPTER が不明なら null)。 */
export function selectedAdapterSchema(): Record<string, unknown> | null {
  const descriptor = selectedDescriptor();
  return descriptor?.configured() ? descriptor.outputSchema : null;
}
