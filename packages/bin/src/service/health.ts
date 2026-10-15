import { healthSchema } from '@mimir/core';
import type { Health } from '@mimir/core';

/** A malformed or foreign responder is the same as no health response. */
export function parseHealth(value: unknown): Health | undefined {
  const parsed = healthSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * GET `/api/health` from a `serve` at `host` (a URL authority host) and `port`,
 * undefined when nothing answers or the answer is not ours. The request names
 * itself `localhost`: the Host guard always admits a loopback name, so a
 * specific bind under a `[serve] hosts` allowlist still answers its own probe.
 */
export async function probeHealth(host: string, port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://${host}:${String(port)}/api/health`, {
      headers: { host: 'localhost' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return undefined;
    }
    return parseHealth(await res.json());
  } catch {
    return undefined;
  }
}
