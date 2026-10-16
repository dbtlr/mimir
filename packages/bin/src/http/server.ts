import { createApiHandler, hostGuard, json } from '@mimir/api';
import {
  canonicalAddress,
  DEFAULT_BIND,
  isLocalAddress,
  isWildcard,
  localAddress,
} from '@mimir/core';
import type { DoctorFacet, Store } from '@mimir/core';
import type { Server } from 'bun';

import { uiResponse } from './static';
import type { UiAssetMap } from './static';
import { UI_ASSETS } from './ui-assets.generated';

export { nodeBodyFields, uniformRoutes } from '@mimir/api';

export type ServeOptions = {
  port: number;
  /**
   * The IP literal to listen on (`[serve] bind`, MMR-433); absent, loopback.
   * A wildcard listens on every interface.
   */
  hostname?: string;
  /** Reported by /api/health — how `service status` asks a live process what it is. */
  version: string;
  /** The embedded-UI manifest; tests inject fixtures, prod uses the generated map. */
  assets?: UiAssetMap;
  /** The MMR-53 walk-upward convenience; the daemon posture passes false (declared port, loud failure). */
  hunt?: boolean;
  /**
   * The `/api/doctor` record-health facet provider (MMR-185) — computes the
   * record-health diagnostics over the store, scoped to an optional project.
   * Optional so a doctor-agnostic test server can skip wiring it; the route
   * then serves the empty facet. A live server always supplies one, from its
   * backend's doctor (ADR 0030 Decision 6).
   */
  doctor?: (scope: string | undefined) => Promise<DoctorFacet>;
  /**
   * Hostnames answered beside the loopback names (`[serve] hosts`, MMR-425);
   * any other `Host` is refused before routing. Absent, any `Host` is
   * answered (MMR-432).
   */
  hosts?: readonly string[];
};

/** How far past a taken port the hunt walks before giving up (MMR-53). */
export const PORT_HUNT_SPAN = 20;

/** Bun's bind-collision error — the only one the hunt may swallow. */
function isPortTaken(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';
}

/**
 * Throw Bun's `EADDRINUSE` when another listener holds `address` on `port`.
 * On macOS a wildcard bind succeeds over such a listener, yet local clients
 * (the health probe, the printed console address) still reach the other one,
 * so a wildcard bind first takes and releases its loopback address. Any other
 * failure (no IPv6 loopback, say) means nothing local can collide there.
 */
function assertLocalPortFree(address: string, port: number): void {
  let claim: Server<undefined>;
  try {
    claim = Bun.serve({
      fetch: () => new Response(null, { status: 503 }),
      hostname: address,
      port,
    });
  } catch (err) {
    if (isPortTaken(err)) {
      throw err;
    }
    return;
  }
  void claim.stop(true);
}

/**
 * Build and start the server on `hostname`, loopback when absent (ADR 0012).
 * A specific address must be on this machine: Bun reports one that is not as
 * a taken port, so it is refused first, by name, with code `EADDRNOTAVAIL`. A
 * wildcard bind treats its port as taken when another listener holds it on
 * loopback. A taken port hunts upward (+1 … +`PORT_HUNT_SPAN`) to the next
 * free one — a dev convenience; a supervised deployment pins the port. Callers
 * must surface the bound port: it may differ from the request.
 */
export function createServer(store: Store, opts: ServeOptions): Server<undefined> {
  const hostname = canonicalAddress(opts.hostname ?? DEFAULT_BIND);
  if (!isLocalAddress(hostname)) {
    throw Object.assign(new Error(`${hostname} is not an address on this machine`), {
      code: 'EADDRNOTAVAIL',
    });
  }
  const last = Math.min(opts.port + PORT_HUNT_SPAN, 65535);
  for (let port = opts.port; ; port++) {
    try {
      if (isWildcard(hostname) && port !== 0) {
        assertLocalPortFree(localAddress(hostname), port);
      }
      return bindServer(store, opts, hostname, port);
    } catch (err) {
      if (!isPortTaken(err) || opts.port === 0 || opts.hunt === false) {
        throw err;
      }
      if (port >= last) {
        throw Object.assign(
          new Error(`ports ${String(opts.port)}–${String(last)} are all in use`),
          {
            code: 'EADDRINUSE',
          },
        );
      }
    }
  }
}

function bindServer(
  store: Store,
  opts: ServeOptions,
  hostname: string,
  port: number,
): Server<undefined> {
  const guard = hostGuard(opts.hosts);
  const api = createApiHandler(store, opts);
  return Bun.serve({
    async fetch(req) {
      const refusal = guard(req);
      if (refusal !== null) {
        return refusal;
      }
      const { pathname } = new URL(req.url);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return api(req);
      }
      if (req.method === 'GET') {
        const ui = uiResponse(pathname, opts.assets ?? UI_ASSETS);
        if (ui !== null) {
          return ui;
        }
      }
      return json({ error: { code: 'not_found', message: `${pathname} doesn't exist` } }, 404);
    },
    hostname,
    port,
  });
}
