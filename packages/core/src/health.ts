import { MIN_CLIENT } from '@mimir/contract';
import type { Health } from '@mimir/contract';

import { SCHEMA_VERSION } from './store-sql/migrator';

/** Use the supported schema so liveness never depends on a database query. */
export function healthOf(version: string): Health {
  return { minClient: MIN_CLIENT, schema: SCHEMA_VERSION, status: 'ok', version };
}
