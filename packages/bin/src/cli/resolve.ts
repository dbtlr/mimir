/**
 * Shared resolution + echo helpers for every mutation handler. Resolves
 * human-readable `KEY-seq` / `KEY` tokens to surrogate ids and echoes the
 * affected node back to stdout in the requested format.
 */

import type { FacetName } from '@mimir/contract';

import {
  nodeViewOf,
  projectViewOf,
  loadNode,
  notFound,
  projectNotFound,
  parseIdentity,
  resolveNodeToken,
  validation,
} from '../core';
import type { Db, Store } from '../core';
import { renderNodeView, signpost } from './render';
// Format is re-exported AND used locally — a plain `export … from` wouldn't bind it
// oxlint-disable-next-line unicorn/prefer-export-from
import type { Format, Io } from './render';

export type { Format };

/**
 * The write-echo facet set. `description` is facet-gated (MMR-162), so a mutation
 * that set it must request the facet to echo the value back — otherwise the
 * record a `create`/`update` prints omits the field it just wrote. Kept to
 * `description` alone to match the pre-MMR-162 bare-field echo shape.
 */
const WRITE_ECHO_FACETS = new Set<FacetName>(['description']);

/**
 * Resolve a node token to its surrogate integer id — the CLI's binding of the
 * core `resolveNodeToken` guard, contributing the CLI-shaped not-found hint.
 * `expected` names what the verb acts on; the default enumerates the work
 * types rather than leaking the internal "node" word into the message.
 */
export async function resolveNode(
  db: Db,
  token: string,
  expected = 'task, phase, or initiative',
): Promise<number> {
  return resolveNodeToken(db, token, expected, { notFound: 'see what exists: mimir list -f ids' });
}

/**
 * Resolve a bare project KEY to its surrogate integer id. Throws `not_found`
 * (MimirError) if no project with that key exists.
 */
export async function resolveProject(db: Db, key: string): Promise<number> {
  const row = await db.selectFrom('project').select('id').where('key', '=', key).executeTakeFirst();
  if (row === undefined) {
    throw projectNotFound(key);
  }
  return row.id;
}

/**
 * Resolve a parent token — either a bare project KEY or a `KEY-seq` node
 * reference — returning a tagged id so the caller knows which table to target.
 */
export async function resolveParent(
  db: Db,
  token: string,
): Promise<{ kind: 'project'; id: number } | { kind: 'node'; id: number }> {
  const identity = parseIdentity(token);
  if (identity?.kind === 'artifact') {
    throw validation(
      `${token} is an artifact — a parent must be a project (KEY) or a task/phase/initiative (KEY-seq)`,
    );
  }
  if (identity?.kind === 'node') {
    return { id: await resolveNode(db, token), kind: 'node' };
  }
  return { id: await resolveProject(db, token), kind: 'project' };
}

/**
 * Echo the affected node to stdout in the requested format. Accepts the
 * surrogate integer id (as returned by `resolveNode`), loads the row, and
 * projects it to a view. Matches the single-node renderer semantics of
 * `renderSingle` in `run.ts`.
 */
export async function echoNode(
  store: Store,
  nodeId: number,
  format: Format,
  io: Io,
): Promise<void> {
  const node = await loadNode(store.db, nodeId);
  if (node === undefined) {
    throw notFound('the record vanished before echo');
  }
  const view = await nodeViewOf(store, node, WRITE_ECHO_FACETS);
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
  nodeId: number,
  format: Format,
  io: Io,
  makeSignpost: (renderedId: string) => string,
): Promise<void> {
  const node = await loadNode(store.db, nodeId);
  if (node === undefined) {
    throw notFound('the record vanished before echo');
  }
  const view = await nodeViewOf(store, node, WRITE_ECHO_FACETS);
  signpost(io, format, makeSignpost(view.id));
  renderNodeView(view, format, io);
}

/**
 * Echo the updated project record to stdout in the requested format. Accepts
 * the project key, loads the row, and projects it to a view through the same
 * path as `get KEY`. Matches the write-echo idiom of every other mutation.
 */
export async function echoProject(
  store: Store,
  key: string,
  format: Format,
  io: Io,
): Promise<void> {
  const project = await store.db
    .selectFrom('project')
    .selectAll()
    .where('key', '=', key)
    .executeTakeFirst();
  if (project === undefined) {
    throw notFound(`project ${key} vanished before echo`);
  }
  const view = await projectViewOf(store, project);
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
