/**
 * Working-set token resolution (MMR-160, ADR 0016 Phase 3) — the in-memory
 * twins of the db-backed guards in `lookup.ts`. Every transport resolves a
 * human `KEY`/`KEY-seq`/`KEY-aN` token against the {@link DerivationSet}
 * snapshot it already derives its views over, so no read path touches the raw
 * SQLite executor. Identical error vocabulary to the db path (a project token
 * where a node is expected, an unknown key) — the guards are the same, only the
 * lookup substrate differs.
 */

import type { DerivationSet } from './derive';
import { findNodeInSet } from './derive';
import { notFound, projectNotFound, validation } from './errors';
import { parseIdentity } from './ids';
import type { EntityRef } from './mutations/tags';

/** Set-based twin of {@link import('./lookup').resolveNodeToken}. */
export function resolveNodeTokenInSet(
  set: DerivationSet,
  token: string,
  expected = 'task, phase, or initiative',
  hints: { project?: string; artifact?: string; notFound?: string } = {},
): number {
  const identity = parseIdentity(token);
  if (identity?.kind === 'project') {
    throw validation(`${token} is a project, not a ${expected}`, hints.project);
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${token} is an artifact, not a ${expected}`, hints.artifact);
  }
  const node = findNodeInSet(set, token);
  if (node === undefined) {
    throw notFound(`${token} doesn't exist`, hints.notFound);
  }
  return node.id;
}

/** Set-based project-key resolution — throws `not_found` for an unknown key. */
export function resolveProjectKeyInSet(set: DerivationSet, key: string): number {
  const project = set.ws.projects.find((p) => p.key === key);
  if (project === undefined) {
    throw projectNotFound(key);
  }
  return project.id;
}

/** Set-based twin of {@link import('./lookup').resolveEntityToken} (tag targets). */
export function resolveEntityTokenInSet(set: DerivationSet, token: string): EntityRef {
  const identity = parseIdentity(token);
  if (identity === null) {
    throw notFound(
      `${token} is not a valid id`,
      'ids: KEY (project) · KEY-seq (task/phase/initiative) · KEY-aN (artifact)',
    );
  }
  if (identity.kind === 'project') {
    return { entityId: resolveProjectKeyInSet(set, identity.key), entityType: 'project' };
  }
  if (identity.kind === 'artifact') {
    // Artifact tags route through the seam by external identity (MMR-143) — no
    // node/project row to resolve; existence is the seam's concern.
    return { entityType: 'artifact', key: identity.key, seq: identity.seq };
  }
  const node = findNodeInSet(set, token);
  if (node === undefined) {
    throw notFound(`${token} doesn't exist`);
  }
  return { entityId: node.id, entityType: 'node' };
}
