import type { Engine } from '@mimir/contract';

import type { DeviceTokens } from '../../server/devices';
import { hostRuntime } from '../../server/runtime';
import type { WireDoctorFacet } from '../doctor-facet';

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
 * the `mimir doctor` findings. Doctor is a host concern,
 * not an Engine method (ADR 0034), so this is the one other thing a handler
 * may ask the runtime for, and it answers the facet alone.
 */
export async function recordHealth(project: string | undefined): Promise<WireDoctorFacet> {
  return (await hostRuntime()).doctor(project);
}

/**
 * The host's device-token store, narrowed to what the console's device pages
 * use (MMR-585): list, check, decide, and revoke. Like {@link recordHealth}, a
 * host concern beside the Engine, not an Engine method.
 */
export async function deviceTokens(): Promise<DeviceTokens> {
  return (await hostRuntime()).tokens;
}
