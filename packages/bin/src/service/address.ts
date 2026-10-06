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

/**
 * An unbracketed IPv4 or IPv6 literal — what `Bun.serve` takes as `hostname`.
 * A zone-scoped address (`fe80::1%en0`) is refused: no URL carries the zone,
 * so neither the health probe nor a printed address could reach it.
 */
export function isBindAddress(value: unknown): value is string {
  return typeof value === 'string' && isIP(value) !== 0 && !value.includes('%');
}

/**
 * An IP literal in the one spelling a URL and `os.networkInterfaces()` use:
 * IPv6 lowercased and compressed (`0:0:0:0:0:0:0:1` is `::1`), IPv4 as given.
 */
export function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) {
    return address;
  }
  return URL.parse(`http://[${address}]`)?.hostname.slice(1, -1) ?? address;
}

/** Whether `address` listens on every interface. Expects a canonical address. */
export function isWildcard(address: string): boolean {
  return WILDCARDS.has(address);
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
 * The address a client on this machine reaches `serve` at, unbracketed. A
 * wildcard bind answers on loopback; a specific address answers only there.
 */
export function localAddress(bind: string | undefined): string {
  if (bind === undefined || bind === '0.0.0.0') {
    return DEFAULT_BIND;
  }
  return bind === '::' ? '::1' : bind;
}

/** The host a local health probe reaches `serve` at, IPv6 bracketed. */
export function probeHost(bind: string | undefined): string {
  return authorityHost(localAddress(bind));
}

/** The URL `serve` is listening on. */
export function listenUrl(bind: string | undefined, port: number): string {
  return `http://${authorityHost(bind ?? DEFAULT_BIND)}:${String(port)}`;
}

/**
 * The console address to show an operator: the configured `url`, else the
 * address that reaches `serve` from this machine (loopback for a wildcard bind).
 */
export function consoleUrl(serve: { bind?: string; url?: string }, port: number): string {
  return serve.url ?? `http://${probeHost(serve.bind)}:${String(port)}`;
}

/**
 * What `serve` prints once bound: where it listens, then the console address
 * when that differs (the configured `url`, or loopback for a wildcard bind).
 */
export function serveBanner(serve: { bind?: string; url?: string }, port: number): string[] {
  const listening = listenUrl(serve.bind, port);
  const console = consoleUrl(serve, port);
  const lines = [`mimir serve — listening on ${listening}`];
  if (console !== listening) {
    lines.push(`console: ${console}`);
  }
  return lines;
}

/**
 * The Host names to hand the guard: undefined (any Host) without `hosts`;
 * with it, the listed names plus a specific bind address and `url`'s host, so
 * every console address Mimir prints is one it answers. A wildcard bind adds
 * nothing: its console address is loopback, which the guard always answers.
 */
export function acceptedHosts(serve: {
  bind?: string;
  hosts?: string[];
  url?: string;
}): string[] | undefined {
  if (serve.hosts === undefined) {
    return undefined;
  }
  const names = [...serve.hosts];
  if (serve.bind !== undefined && !isWildcard(serve.bind)) {
    names.push(authorityHost(serve.bind));
  }
  if (serve.url !== undefined) {
    names.push(hostnameOf(new URL(serve.url).host));
  }
  return names;
}

/**
 * Whether this machine can bind `address`, in any spelling: a wildcard always,
 * a specific one only when an interface carries it. Bun reports an address
 * that is not here as a port collision, so `serve` checks first and names the
 * real problem. Linux routes all of 127.0.0.0/8 to loopback but lists only
 * 127.0.0.1, so there any 127.x address counts.
 */
export function isLocalAddress(
  address: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const canonical = canonicalAddress(address);
  if (isWildcard(canonical)) {
    return true;
  }
  if (platform === 'linux' && isIP(canonical) === 4 && canonical.startsWith('127.')) {
    return true;
  }
  return Object.values(interfaces).some((nics) =>
    (nics ?? []).some((nic) => canonicalAddress(nic.address) === canonical),
  );
}
