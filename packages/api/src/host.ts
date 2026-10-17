import { hostnameOf } from '@mimir/core';

import { json } from './respond';

/**
 * The Host guard (MMR-425). A page whose domain rebinds to 127.0.0.1 is
 * same-origin with a loopback-bound server — the bind alone does not keep it
 * out. Such a page still sends its own name as `Host`, so an operator who sets
 * `MIMIR_HOSTS` gets a host that answers only the loopback names and the
 * listed hosts. The check is opt-in (MMR-432): without `hosts`, every name an
 * install is reached by (an IP, a MagicDNS name, a proxy host) just works.
 * `X-Forwarded-Host` is never consulted: a same-origin page can set it.
 *
 * The same guard always refuses writes from another origin (MMR-426). The API grants
 * no CORS, so another page cannot read it, but a browser still sends a
 * "simple" POST (a `text/plain` body, no preflight) from any origin, and the
 * Host of that request is the server's own. Every current browser marks such
 * a write with `Sec-Fetch-Site` or `Origin`, so a write either one shows as
 * cross-origin is refused. The CLI, agents, and other clients send no Origin and pass.
 */

/** Names a rebinding page can never present: they are not the page's domain. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

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

/** Bound diagnostics even when a caller keeps inventing refused names. */
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
          ? `⚠ http: refused a request for host ${JSON.stringify(name)} — add it to the Host allowlist if your proxy forwards it`
          : `⚠ http: refused a request for host ${JSON.stringify(name)}; further refused hosts are not logged`,
      );
    }
    return json(
      { error: { code: 'forbidden_host', message: 'this server does not answer for that host' } },
      403,
    );
  };
}
