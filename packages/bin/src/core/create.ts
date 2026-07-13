import type { Priority, Size } from '@mimir/contract';

import { isValidKey } from './allocation';
import { conflict, notFound, validation } from './errors';
import type { Node, Project } from './model';
import { assertProjectActive } from './mutations/common';
import { normalizeSummary } from './mutations/data';
import { appendRank } from './rank';
import type { Store } from './store';

/**
 * Create verbs. Each opens one write scope: validate the behavioral invariants
 * (the DB can't check parent type-correctness), allocate the per-project `seq`,
 * insert, and echo the row. Creation establishes initial state and is *not* a
 * transition — no `transition_log` row (the log records later changes, ADR 0003).
 *
 * Parent rules (design spec §3.4): initiative → project (top-level, `parent_id`
 * null); phase → initiative; task → phase or initiative.
 */

export type CreateProjectInput = {
  key: string;
  name: string;
  description?: string | null;
  tags?: string[];
};

export async function createProject(store: Store, input: CreateProjectInput): Promise<Project> {
  if (!isValidKey(input.key)) {
    throw validation(`project key must match [A-Z]{2,4}: ${input.key}`);
  }
  return store.transact(async (w) => {
    if (await w.hasIdentityCollision(input.key)) {
      throw conflict(`project key is ambiguous across multiple documents: ${input.key}`);
    }
    const existing = await w.loadProject(input.key);
    if (existing !== undefined) {
      throw conflict(`project key already exists: ${input.key}`);
    }
    const project = await w.insertProject({
      description: input.description ?? null,
      key: input.key,
      name: input.name,
      tags: input.tags,
    });
    return project;
  });
}

export type CreateInitiativeInput = {
  projectId: string;
  title: string;
  description?: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  /** Purposefully open-ended: opt out of done-rollup (MMR-204). */
  openEnded?: boolean;
  tags?: string[];
};

export async function createInitiative(store: Store, input: CreateInitiativeInput): Promise<Node> {
  return store.transact(async (w) => {
    const project = await w.loadProject(input.projectId);
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    await assertProjectActive(w, input.projectId);
    const node = await w.insertNode({
      description: input.description ?? null,
      open_ended: input.openEnded ?? null,
      parent_id: null,
      project_id: input.projectId,
      summary: normalizeSummary(input.summary ?? null),
      tags: input.tags,
      title: input.title,
      type: 'initiative',
    });
    return node;
  });
}

export type CreatePhaseInput = {
  parentId: string;
  title: string;
  description?: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  target?: string | null;
  /** Purposefully open-ended: opt out of done-rollup (MMR-204). */
  openEnded?: boolean;
  tags?: string[];
};

export async function createPhase(store: Store, input: CreatePhaseInput): Promise<Node> {
  return store.transact(async (w) => {
    const parent = await w.loadNode(input.parentId);
    if (parent === undefined) {
      throw notFound('the parent was not found');
    }
    if (parent.type !== 'initiative') {
      throw validation(`a phase's parent must be an initiative, not a ${parent.type}`);
    }
    await assertProjectActive(w, parent.project_id);
    const node = await w.insertNode({
      description: input.description ?? null,
      open_ended: input.openEnded ?? null,
      parent_id: parent.id,
      project_id: parent.project_id,
      summary: normalizeSummary(input.summary ?? null),
      tags: input.tags,
      target: input.target ?? null,
      title: input.title,
      type: 'phase',
    });
    return node;
  });
}

export type CreateTaskInput = {
  parentId: string;
  title: string;
  description?: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  externalRef?: string | null;
  /** The requester-side seed pointer (`KEY-sN`), nullable (MMR-244). */
  upstream?: string | null;
  tags?: string[];
};

export async function createTask(store: Store, input: CreateTaskInput): Promise<Node> {
  return store.transact(async (w) => {
    const parent = await w.loadNode(input.parentId);
    if (parent === undefined) {
      throw notFound('the parent was not found');
    }
    if (parent.type !== 'phase' && parent.type !== 'initiative') {
      throw validation(`a task's parent must be a phase or initiative, not a ${parent.type}`);
    }
    await assertProjectActive(w, parent.project_id);
    // A fresh task is todo + none → in the rankable set → append to bottom.
    const rank = await appendRank(w, parent.project_id);
    const node = await w.insertNode({
      description: input.description ?? null,
      external_ref: input.externalRef ?? null,
      hold: 'none',
      lifecycle: 'todo',
      parent_id: parent.id,
      priority: input.priority ?? null,
      project_id: parent.project_id,
      rank,
      size: input.size ?? null,
      summary: normalizeSummary(input.summary ?? null),
      tags: input.tags,
      title: input.title,
      type: 'task',
      upstream: input.upstream ?? null,
    });
    return node;
  });
}
