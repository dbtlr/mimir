/**
 * The offline read (ADR 0013 §5): unreachable-for-any-reason is ONE state,
 * derived from the queries on screen — any errored query means the server
 * didn't answer; the freshest `dataUpdatedAt` is the last-sync time. Queries
 * keep polling, so reconnection heals without ceremony.
 */
export type ConnectivitySource = {
  isError: boolean;
  dataUpdatedAt: number;
};

export type Connectivity = {
  offline: boolean;
  /** ms epoch of the freshest successful read on screen; null = never synced. */
  lastSync: number | null;
};

export function connectivity(queries: readonly ConnectivitySource[]): Connectivity {
  const offline = queries.some((q) => q.isError);
  const synced = queries.map((q) => q.dataUpdatedAt).filter((t) => t > 0);
  return { lastSync: synced.length > 0 ? Math.max(...synced) : null, offline };
}
