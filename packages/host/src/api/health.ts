import { ApiError } from './errors';

/** The host's `/health` body: its build, minimum client, and supported store schema (MMR-260). */
export type HostHealth = {
  minClient: string;
  status: 'ok';
  version: string;
  schema: number;
};

/**
 * Read the host's `/health` route, the one console read that is not an Engine
 * method. It answers from the running build alone, so it proves the host is up
 * and which build and schema it runs, not that the store is reachable.
 */
export async function fetchHealth(): Promise<HostHealth> {
  const res = await fetch('/health', { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new ApiError(`GET /health → ${String(res.status)}`, res.status);
  }
  // The host's own route; the footer only compares `version` and `schema`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await res.json()) as HostHealth;
}
