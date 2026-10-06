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

/**
 * A Host header's hostname, lowercased, without its port. Anything after the
 * name other than `:<digits>` is not a Host a browser sends, so the whole
 * header comes back unchanged and matches no accepted name.
 */
export function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith('[') ? lower.indexOf(']') + 1 : lower.indexOf(':');
  if (end <= 0) {
    return lower;
  }
  return /^(:\d+)?$/.test(lower.slice(end)) ? lower.slice(0, end) : lower;
}

/** The refusal for a request whose Host is not the daemon's; null admits it. */
export type HostGuard = (req: Request) => Response | null;

/** How many distinct refused names `serve` logs before it stops logging them. */
const REFUSAL_LOG_CAP = 64;

/**
 * Build the guard over the loopback names plus `hosts`. Each refused name is
 * logged once, JSON-escaped since the header is the caller's text, up to
 * {@link REFUSAL_LOG_CAP} names: a wildcard domain can mint names forever.
 */
export function hostGuard(hosts: readonly string[]): HostGuard {
  const allowed = new Set([...LOOPBACK_HOSTS, ...hosts.map(hostnameOf)]);
  const reported = new Set<string>();
  return (req) => {
    const name = hostnameOf(req.headers.get('host') ?? '');
    if (allowed.has(name)) {
      return null;
    }
    if (reported.size < REFUSAL_LOG_CAP && !reported.has(name)) {
      reported.add(name);
      console.error(
        reported.size < REFUSAL_LOG_CAP
          ? `⚠ serve: refused a request for host ${JSON.stringify(name)} — add it to [serve] hosts if your proxy forwards it`
          : `⚠ serve: refused a request for host ${JSON.stringify(name)}; further refused hosts are not logged`,
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
