import type { Engine } from '@mimir/contract';

import { hostRuntime } from '../../server/runtime';
import type { WireDoctorFacet } from '../types';

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

/**
 * The host's record-health facet (MMR-185), optionally scoped to one project:
 * the `mimir doctor` findings `/api/doctor` serves. Doctor is a host concern,
 * not an Engine method (ADR 0034), so this is the one other thing a handler
 * may ask the runtime for, and it answers the facet alone.
 */
export async function recordHealth(project: string | undefined): Promise<WireDoctorFacet> {
  return (await hostRuntime()).doctor(project);
}
