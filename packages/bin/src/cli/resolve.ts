/**
 * Shared resolution + echo helpers for every mutation handler. Resolves
 * human-readable `KEY-seq` / `KEY` tokens to canonical identities and echoes the
 * affected node back to stdout in the requested format.
 */

import { WRITE_ECHO_FACETS } from '@mimir/contract';

import {
  deriveSet,
  nodeViewById,
  projectViewByKey,
  notFound,
  resolveNodeTokenInSet,
  resolveProjectKeyInSet,
} from '../core';
import type { Store } from '../core';
import { renderNodeView, signpost } from './render';
// Format is re-exported AND used locally — a plain `export … from` wouldn't bind it
// oxlint-disable-next-line unicorn/prefer-export-from
import type { Format, Io } from './render';

export type { Format };

/** The write-echo facet set — {@link WRITE_ECHO_FACETS}, as a `Set` for the seams below. */
const WRITE_ECHO_FACET_SET = new Set(WRITE_ECHO_FACETS);

/**
 * Resolve a node token to its canonical stem — the CLI's binding of the
 * core resolution guard, over the working-set snapshot (MMR-160, no raw db).
 * `expected` names what the verb acts on; the default enumerates the work
 * types rather than leaking the internal "node" word into the message.
 */
export async function resolveNode(
  store: Store,
  token: string,
  expected = 'task, phase, or initiative',
): Promise<string> {
  const set = deriveSet(await store.loadWorkingSet());
  return resolveNodeTokenInSet(set, token, expected, {
    notFound: 'see what exists: mimir list -f ids',
  });
}

/**
 * Resolve a bare project KEY to its canonical identity over the working set.
 * Throws `not_found` (MimirError) if no project with that key exists.
 */
export async function resolveProject(store: Store, key: string): Promise<string> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/**
 * Echo the affected node to stdout in the requested format. Accepts the
 * canonical stem (as returned by `resolveNode`), loads the row, and
 * projects it to a view. Matches the single-node renderer semantics of
 * `renderSingle` in `run.ts`.
 */
export async function echoNode(
  store: Store,
  nodeId: string,
  format: Format,
  io: Io,
): Promise<void> {
  const view = await nodeViewById(store, nodeId, WRITE_ECHO_FACET_SET);
  if (view === undefined) {
    throw notFound('the record vanished before echo');
  }
  renderNodeView(view, format, io);
}

/**
 * Echo the affected node with a what-happened signpost above it. `makeSignpost`
 * receives the canonical rendered id (so the line matches the record header)
 * and returns the effect line — `started MMR-3 · todo → in_progress`,
 * `reordered MMR-3 → top`. The signpost shows on styled formats only; the
 * record always follows (so a write needs no follow-up `get`).
 */
export async function echoNodeWith(
  store: Store,
  nodeId: string,
  format: Format,
  io: Io,
  makeSignpost: (renderedId: string) => string,
): Promise<void> {
  const view = await nodeViewById(store, nodeId, WRITE_ECHO_FACET_SET);
  if (view === undefined) {
    throw notFound('the record vanished before echo');
  }
  signpost(io, format, makeSignpost(view.id));
  renderNodeView(view, format, io);
}

/**
 * Echo the updated project record to stdout in the requested format. Accepts
 * the project key, loads the row, and projects it to a view through the same
 * path as `get KEY`. Matches the write-echo idiom of every other mutation —
 * including the shared write-echo facets, so the echoed rollup covers the
 * project's real root children (MMR-242).
 */
export async function echoProject(
  store: Store,
  key: string,
  format: Format,
  io: Io,
): Promise<void> {
  const view = await projectViewByKey(store, key, WRITE_ECHO_FACET_SET);
  if (view === undefined) {
    throw notFound(`project ${key} vanished before echo`);
  }
  renderNodeView(view, format, io);
}

/**
 * Read inline content from the trailing positionals or from stdin (when
 * piped). Returns an empty string if both sources are absent (interactive
 * TTY with no tail args — callers decide how to handle the gap).
 */
export async function readContent(tail: string[], io: Io): Promise<string> {
  if (tail.length > 0) {
    return tail.join(' ');
  }
  if (!io.isTTY) {
    return (await Bun.stdin.text()).trim();
  }
  return '';
}
