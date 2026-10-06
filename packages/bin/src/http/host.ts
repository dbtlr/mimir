import type { Serve, Server } from 'bun';

import { json } from './respond';

/**
 * The Host guard (MMR-425). `serve` binds loopback and the proxy is the
 * boundary (ADR 0012), but a page whose domain rebinds to 127.0.0.1 is
 * same-origin with the daemon — the bind alone does not keep it out. Such a
 * page still sends its own name as `Host`, so the daemon answers only the
 * loopback names and the proxy hosts the operator lists in `[serve] hosts`.
 * `X-Forwarded-Host` is never consulted: a same-origin page can set it.
 */

/** Names a rebinding page can never present: they are not the page's domain. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** A Host header's hostname, lowercased, without its port. */
export function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']');
    return end === -1 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(':');
  return colon === -1 ? lower : lower.slice(0, colon);
}

/** The refusal for a request whose Host is not the daemon's; null admits it. */
export type HostGuard = (req: Request) => Response | null;

/**
 * Build the guard over the loopback names plus `hosts`. Each refused host is
 * logged once to stderr, JSON-escaped since the header is the caller's text.
 */
export function hostGuard(hosts: readonly string[]): HostGuard {
  const allowed = new Set([...LOOPBACK_HOSTS, ...hosts.map(hostnameOf)]);
  const reported = new Set<string>();
  return (req) => {
    const host = req.headers.get('host') ?? '';
    if (allowed.has(hostnameOf(host))) {
      return null;
    }
    if (!reported.has(host)) {
      reported.add(host);
      console.error(
        `⚠ serve: refused a request for host ${JSON.stringify(host)} — add its name to [serve] hosts if your proxy forwards it`,
      );
    }
    return json(
      req,
      { error: { code: 'forbidden_host', message: 'this server does not answer for that host' } },
      403,
    );
  };
}

/**
 * Put the guard in front of every route handler. Bun matches `routes` before
 * `fetch`, so the fallback's own check cannot cover them.
 */
export function guardRoutes<R extends string>(
  guard: HostGuard,
  routes: Serve.Routes<undefined, R>,
): Serve.Routes<undefined, R> {
  const guarded: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(routes)) {
    if (typeof methods !== 'object' || methods === null || methods instanceof Response) {
      throw new TypeError(`route ${path} must map methods to handlers`);
    }
    guarded[path] = Object.fromEntries(
      Object.entries(methods).map(([method, handler]) => {
        if (typeof handler !== 'function') {
          throw new TypeError(`route ${method} ${path} must be a handler`);
        }
        // Checked just above: a method handler, which Bun calls as (req, server).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const run = handler as (req: Request, server: Server<undefined>) => Promise<Response>;
        return [
          method,
          (req: Request, server: Server<undefined>) => guard(req) ?? run(req, server),
        ];
      }),
    );
  }
  // The same paths and methods as `routes`, each handler wrapped with its signature intact.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return guarded as Serve.Routes<undefined, R>;
}
