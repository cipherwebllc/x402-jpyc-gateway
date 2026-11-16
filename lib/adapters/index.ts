import { selectedAdapterName } from './catalog';
import type { Adapter } from './types';
import { cooIcpAdapter } from './coo-icp';
import { httpAdapter } from './http';

export function selectedAdapter(): Adapter {
  const adapter = selectedAdapterName();
  if (adapter === 'coo-icp') return cooIcpAdapter;
  if (adapter === 'http') return httpAdapter;
  throw new Error('unknown adapter');
}
