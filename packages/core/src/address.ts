/**
 * The host's network identity, as its environment declares it (MMR-425,
 * MMR-432, MMR-433): `MIMIR_HOSTS` names the Hosts it answers and `MIMIR_URL`
 * is its public origin. Only `hosts` turns the Host check on; `url` alone never
 * does.
 */
export type ServeConfig = {
  /**
   * Hostnames the host answers beside the loopback names. Absent, any Host is
   * answered; empty, the loopback names only.
   */
  hosts?: string[];
  /** The console's public origin, whose host joins `hosts`. */
  url?: string;
};

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

/** A bare hostname or bracketed IPv6 literal — a port here would be ignored, so it is refused. */
export function isHostName(value: unknown): value is string {
  return typeof value === 'string' && /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)$/i.test(value);
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

/**
 * The Host names to hand the guard: undefined (any Host) without `hosts`;
 * with it, the listed names plus `url`'s host, so every console address the
 * host is reached by is one it answers.
 */
export function acceptedHosts(serve: ServeConfig): string[] | undefined {
  if (serve.hosts === undefined) {
    return undefined;
  }
  const names = [...serve.hosts];
  if (serve.url !== undefined) {
    names.push(hostnameOf(new URL(serve.url).host));
  }
  return names;
}
