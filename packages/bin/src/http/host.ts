import type { Serve, Server } from 'bun';

import { json } from './respond';

/**
 * The Host guard (MMR-425). `serve` binds loopback and the proxy is the
 * boundary (ADR 0012), but a page whose domain rebinds to 127.0.0.1 is
 * same-origin with the daemon — the bind alone does not keep it out. Such a
 * page still sends its own name as `Host`, so an operator who sets
 * `[serve] hosts` gets a daemon that answers only the loopback names and the
 * listed hosts. The check is opt-in (MMR-432): without `hosts`, every name an
 * install is reached by (an IP, a MagicDNS name, a proxy host) just works.
 * `X-Forwarded-Host` is never consulted: a same-origin page can set it.
 *
 * The same guard always refuses writes from another origin (MMR-426). The API grants
 * no CORS, so another page cannot read it, but a browser still sends a
 * "simple" POST (a `text/plain` body, no preflight) from any origin, and the
 * Host of that request is the daemon's own. Every current browser marks such
 * a write with `Sec-Fetch-Site` or `Origin`, so a write either one shows as
 * cross-origin is refused. The CLI, agents, and other clients send no Origin and pass.
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

/** Methods that never write: a browser's cross-origin GET and HEAD stay unreadable. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** `Sec-Fetch-Site` values a browser sends for the page's own requests. */
const SAME_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/**
 * Whether a browser sent this write from another origin: a non-safe method
 * that `Sec-Fetch-Site` marks as not same-origin, or whose `Origin` host
 * (name and port) is not the request's `Host`. Host is read through the
 * Origin's scheme so both sides drop a default port alike. An opaque `null`
 * Origin parses to no host and never matches.
 */
export function isCrossOriginWrite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) {
    return false;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && !SAME_ORIGIN_FETCH_SITES.has(site)) {
    return true;
  }
  const origin = req.headers.get('origin');
  if (origin === null) {
    return false;
  }
  const from = URL.parse(origin);
  const host = (req.headers.get('host') ?? '').trim();
  return from === null || URL.parse(`${from.protocol}//${host}`)?.host !== from.host;
}

/** The refusal for a request this server must not answer; null admits it. */
export type HostGuard = (req: Request) => Response | null;

/** How many distinct refused names `serve` logs before it stops logging them. */
const REFUSAL_LOG_CAP = 64;

/**
 * Build the guard. With `hosts` undefined any Host is answered; with a list
 * (even an empty one) only the loopback names plus `hosts` are. Each refused
 * name is logged once, JSON-escaped since the header is the caller's text, up
 * to {@link REFUSAL_LOG_CAP} names: a wildcard domain can mint names forever.
 */
export function hostGuard(hosts: readonly string[] | undefined): HostGuard {
  const allowed =
    hosts === undefined ? undefined : new Set([...LOOPBACK_HOSTS, ...hosts.map(hostnameOf)]);
  const reported = new Set<string>();
  return (req) => {
    const name = hostnameOf(req.headers.get('host') ?? '');
    if (allowed === undefined || allowed.has(name)) {
      return isCrossOriginWrite(req)
        ? json(
            {
              error: {
                code: 'forbidden_origin',
                message: 'this server does not accept writes from another origin',
              },
            },
            403,
          )
        : null;
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
