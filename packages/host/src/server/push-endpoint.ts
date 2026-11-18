/*
 * The push service allowlist (ADR 0045, the MMR-709 refinement). The browser
 * chooses the endpoint, so the allowlist is what keeps the host from posting
 * to an address of the browser's choosing.
 */

/** The longest endpoint the channel stores, as the URL parser serializes it. */
export const PUSH_ENDPOINT_LIMIT = 1024;

/** The push hosts named exactly: Apple's and Google's. */
const PUSH_HOSTS: ReadonlySet<string> = new Set(['fcm.googleapis.com', 'web.push.apple.com']);

/** The push host suffixes: Apple's, Mozilla's, and Microsoft's. */
const PUSH_HOST_SUFFIXES = ['.notify.windows.com', '.push.apple.com', '.push.services.mozilla.com'];

/**
 * Whether a parsed, lowercased hostname is a push service's. A suffix match
 * needs a nonempty label before the suffix, and no hostname with an empty
 * label (a leading, doubled, or trailing dot) matches.
 */
function isPushHost(hostname: string): boolean {
  if (hostname.split('.').includes('')) {
    return false;
  }
  return (
    PUSH_HOSTS.has(hostname) ||
    PUSH_HOST_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
    )
  );
}

/**
 * The endpoint as the URL parser serializes it, or undefined when it is not
 * an `https:` URL on the default port, with no user, password, or fragment,
 * on a push host, and at most {@link PUSH_ENDPOINT_LIMIT} characters long.
 */
/**
 * The endpoint as the URL parser serializes it, or undefined when it does not
 * parse: the form every function that takes an endpoint looks a row up by.
 */
export function serializePushEndpoint(raw: string): string | undefined {
  return URL.parse(raw)?.href;
}

export function normalizePushEndpoint(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.href.includes('#') ||
    url.href.length > PUSH_ENDPOINT_LIMIT ||
    !isPushHost(url.hostname)
  ) {
    return undefined;
  }
  return url.href;
}
