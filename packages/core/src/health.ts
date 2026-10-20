import { MIN_CLIENT } from '@mimir/contract';
import { z } from 'zod';

import { SCHEMA_VERSION } from './store-sql/migrator';

/** The health wire response, shared by the host and CLI transports. */
export const healthSchema = z.object({
  minClient: z.string(),
  schema: z.number().int().nonnegative(),
  status: z.literal('ok'),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

/** Use the supported schema so liveness never depends on a database query. */
export function healthOf(version: string): Health {
  return { minClient: MIN_CLIENT, schema: SCHEMA_VERSION, status: 'ok', version };
}
