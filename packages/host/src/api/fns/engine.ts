import type { Engine } from '@mimir/contract';

import { hostRuntime } from '../../server/runtime';

/**
 * The host's shared Engine, for server-function handlers only (ADR 0034
 * decision 7). It is typed as the `Engine` interface, not `LocalEngine`, so a
 * handler can reach Engine methods and nothing beneath them: no store and no
 * core function. Tests never reach it; they mock the server-function module by
 * function (see test/setup.ts).
 */
export async function engine(): Promise<Engine> {
  return (await hostRuntime()).engine;
}
