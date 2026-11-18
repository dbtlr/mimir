/*
 * The origin checks every outbound integration's settings share (ADR 0040):
 * which names are loopback, and which origins are secure enough to send a
 * browser to. T3 and the Web Push channel both read them.
 */

/** Names a browser on this machine can reach the console or T3 by. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL hostname is a loopback name. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * An origin T3 accepts as a redirect, the console accepts as T3's, or an
 * integration accepts as `MIMIR_URL`: HTTPS, or HTTP on loopback.
 */
export function isSecureOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'https:' || isLoopbackHostname(url.hostname);
}
