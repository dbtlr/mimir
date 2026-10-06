import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';

import { hostnameOf } from '../http/host';

/**
 * Where `serve` listens and the address it hands out (MMR-433). `[serve] bind`
 * is any IP literal, loopback when absent; `[serve] url` is the console's
 * public address, printed in place of the bound one. The two never imply the
 * Host check: only `[serve] hosts` turns it on (MMR-432).
 */

/** The address `serve` binds when `[serve] bind` is absent: loopback only. */
export const DEFAULT_BIND = '127.0.0.1';

const WILDCARDS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);

/** An unbracketed IPv4 or IPv6 literal — what `Bun.serve` takes as `hostname`. */
export function isBindAddress(value: unknown): value is string {
  return typeof value === 'string' && isIP(value) !== 0;
}

/**
 * The origin of an `http`/`https` URL with nothing after the host but an
 * optional `/`, or undefined for anything else: the console is served at the
 * root, so a path, query, fragment, or credential would be a link that misleads.
 */
export function normalizeServeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const url = URL.parse(value);
  if (
    url === null ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return undefined;
  }
  return url.origin;
}

/** An address as it appears in a URL authority: IPv6 bracketed. */
function authorityHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

/**
 * The host a local health probe reaches `serve` at. A wildcard bind answers on
 * loopback; a specific address answers only there, loopback included.
 */
export function probeHost(bind: string | undefined): string {
  if (bind === undefined || bind === '0.0.0.0') {
    return DEFAULT_BIND;
  }
  return bind === '::' ? '[::1]' : authorityHost(bind);
}

/** The URL `serve` is listening on. */
export function listenUrl(bind: string | undefined, port: number): string {
  return `http://${authorityHost(bind ?? DEFAULT_BIND)}:${String(port)}`;
}

/** The console address to show an operator: the configured `url`, else the listening one. */
export function consoleUrl(serve: { bind?: string; url?: string }, port: number): string {
  return serve.url ?? listenUrl(serve.bind, port);
}

/**
 * The Host names to hand the guard: undefined (any Host) without `hosts`;
 * with it, the listed names plus `url`'s host, so the address Mimir prints is
 * always one it answers.
 */
export function acceptedHosts(serve: { hosts?: string[]; url?: string }): string[] | undefined {
  if (serve.hosts === undefined) {
    return undefined;
  }
  if (serve.url === undefined) {
    return serve.hosts;
  }
  return [...serve.hosts, hostnameOf(new URL(serve.url).host)];
}

/**
 * Whether this machine can bind `address`: a wildcard always, a specific one
 * only when an interface carries it. Bun reports an address that is not here
 * as a port collision, so `serve` checks first and names the real problem.
 */
export function isLocalAddress(
  address: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): boolean {
  if (WILDCARDS.has(address)) {
    return true;
  }
  return Object.values(interfaces).some((nics) =>
    (nics ?? []).some((nic) => nic.address === address),
  );
}
