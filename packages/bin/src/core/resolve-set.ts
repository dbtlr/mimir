/**
 * Working-set token resolution (MMR-160, ADR 0016 Phase 3) — resolves a
 * human `KEY`/`KEY-seq`/`KEY-aN` token against the {@link DerivationSet}
 * snapshot a transport already derives its views over, so no read path
 * touches the raw SQLite executor. Identical error vocabulary throughout (a
 * project token where a node is expected, an unknown key).
 */

import type { DerivationSet } from './derive';
import { findNodeInSet, findProjectInSet } from './derive';
import { notFound, projectNotFound, validation } from './errors';
import { parseIdentity } from './ids';
import type { EntityRef } from './mutations/tags';

/**
 * Resolve a node token (`KEY-seq`) to its surrogate id for a verb that acts
 * on nodes. A token naming a project or artifact is rejected as a behavioral
 * error — `expected` names what the verb acts on, and `hints` lets each
 * transport point at its own surface.
 */
export function resolveNodeTokenInSet(
  set: DerivationSet,
  token: string,
  expected = 'task, phase, or initiative',
  hints: { project?: string; artifact?: string; seed?: string; notFound?: string } = {},
): number {
  const identity = parseIdentity(token);
  if (identity?.kind === 'project') {
    throw validation(`${token} is a project, not a ${expected}`, hints.project);
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${token} is an artifact, not a ${expected}`, hints.artifact);
  }
  if (identity?.kind === 'seed') {
    // A seed id names a grooming record, not work — reject it as a behavioral
    // kind-error (like project/artifact), never a fake `doesn't exist` (MMR-245/B4).
    throw validation(
      `${token} is a seed, not a ${expected}`,
      hints.seed ?? 'act on a seed with promote / reject / resolve',
    );
  }
  const node = findNodeInSet(set, token);
  if (node === undefined) {
    throw notFound(`${token} doesn't exist`, hints.notFound);
  }
  return node.id;
}

/** Set-based project-key resolution — throws `not_found` for an unknown key. */
export function resolveProjectKeyInSet(set: DerivationSet, key: string): number {
  const project = findProjectInSet(set, key);
  if (project === undefined) {
    throw projectNotFound(key);
  }
  return project.id;
}

/**
 * Resolve any rendered identity — `KEY` | `KEY-seq` | `KEY-aN` — to its tag
 * target (entity kind + surrogate id). Throws `not_found` naming the token;
 * the caller decides which kinds it acts on.
 */
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
  if (identity.kind === 'seed') {
    // A seed is not a taggable entity — a behavioral kind-error, not `doesn't exist`.
    throw validation(`${token} is a seed, not a task, project, or artifact`);
  }
  const node = findNodeInSet(set, token);
  if (node === undefined) {
    throw notFound(`${token} doesn't exist`);
  }
  return { entityId: node.id, entityType: 'node' };
}
