import type { Engine } from '@mimir/contract';
import { getRequest } from '@tanstack/react-start/server';

import type { AgentConsole } from '../../server/agent-console-states';
import type { DeviceTokens } from '../../server/devices';
import { hostRuntime } from '../../server/runtime';
import type { T3Adapter } from '../../server/t3';
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

/**
 * The T3 Code adapter (ADR 0040): Connect, status, and the launch catalog.
 * Like {@link deviceTokens}, a host concern beside the Engine; its credential
 * stays in the host-secret store and never crosses to the browser.
 */
export async function t3Integration(): Promise<T3Adapter> {
  return (await hostRuntime()).t3;
}

/**
 * The agent runtime's console surface (ADR 0041, MMR-633): the task card's
 * read, the running run for Now, and Groom with agent. Like
 * {@link t3Integration}, a host concern beside the Engine; the token and the
 * runs table stay on the host.
 */
export async function agentConsole(): Promise<AgentConsole> {
  return (await hostRuntime()).agentConsole;
}

/**
 * The origin of the request a server function is answering. Connect and the
 * status read need it when `MIMIR_URL` is unset: only a loopback origin can
 * receive T3's redirect then.
 */
export function requestOrigin(): string {
  return new URL(getRequest().url).origin;
}
