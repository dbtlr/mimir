/*
 * What every area's reads share: the poll interval, the browser's zone, and
 * the key roots the persister treats specially. Each area keeps its reads, as
 * shared `queryOptions`, in its own module beside this one
 * (`shell-queries.ts`, `view-queries.ts`, `node-queries.ts`,
 * `browse-queries.ts`), so work on one area never edits another's file.
 */

/**
 * Polling is the liveness model (ADR 0013 — websockets deferred): ~10s while
 * the document is visible; TanStack Query pauses interval refetches while
 * hidden and refetches on reconnect/focus by default.
 */
export const POLL_MS = 10_000;

/** This browser's IANA timezone — the calendar a bare date is read against.
 * `UTC` is the fallback for a runtime that reports none; the server refuses a
 * bare date with no zone rather than guessing one. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Key roots (`queryKey[0]`) of every infinite query. The persister's restore
 * guard (see persist.ts `sanitizePersistedClient`) drops a persisted entry
 * under one of these whose cached data isn't infinite-shaped
 * (`{ pages, pageParams }`) — a legacy flat-collection payload from before the
 * query became infinite, or any shape drift a missed persister-buster bump let
 * through. Add an infinite query's root here when you add the query.
 */
export const INFINITE_QUERY_KEY_ROOTS: ReadonlySet<string> = new Set(['artifacts']);

/**
 * Key roots of the queries kept out of the persisted offline snapshot: passing
 * questions, not board state (`devices` holds pairing codes and paired devices).
 * A restored entry would also take the client's
 * week-long `gcTime`, so it would outlive every reload.
 */
export const UNPERSISTED_QUERY_KEY_ROOTS: ReadonlySet<string> = new Set(['devices', 'search']);
