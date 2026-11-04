/** The handles of a task's agent context that name a T3 thread. */
export type T3ThreadHandles = {
  harness?: string | null;
  host?: string | null;
  session?: string | null;
};

/** A handle that cannot be one safe path segment. */
const unsafe = (handle: string | null | undefined): handle is null | undefined | '' | '.' | '..' =>
  handle == null || handle === '' || handle === '.' || handle === '..';

/**
 * The Open in T3 link (ADR 0040): `<origin>/<host>/<session>`, each handle
 * percent-encoded as one path segment. Null without an origin, for another
 * harness, or when a handle is empty, `.`, or `..`.
 */
export function t3ThreadLink(origin: string | null, handles: T3ThreadHandles): string | null {
  const { harness, host, session } = handles;
  if (origin === null || harness !== 't3' || unsafe(host) || unsafe(session)) {
    return null;
  }
  return `${origin}/${encodeURIComponent(host)}/${encodeURIComponent(session)}`;
}
