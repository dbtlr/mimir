import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { isValidKey } from './allocation';
import { deriveSet } from './derive';
import { conflict, notFound, validation } from './errors';
import { parseIdentity, parseUpstreamField, UPSTREAM_CLEAR } from './ids';
import type { Node, Project } from './model';
import { assertProjectActive } from './mutations/common';
import { normalizeSummary } from './mutations/data';
import { appendRank } from './rank';
import { resolveNodeTokenInSet, resolveProjectKeyInSet } from './resolve-set';
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
      throw notFound(`${input.projectId} doesn't exist`);
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
      throw notFound(`${input.parentId} doesn't exist`);
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
      throw notFound(`${input.parentId} doesn't exist`);
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

// ─── Unified create dispatch (MMR-304) ──────────────────────────────────────

/**
 * The single create surface every transport maps onto. It owns what the CLI,
 * MCP, and HTTP handlers used to each re-implement: the type dispatch, the
 * parent token shape+kind rules, priority/size enum validation, the `upstream`
 * wire parse, and the open_ended container-only rule (MMR-204). A transport is
 * left with argument mapping and echo.
 *
 * Parent tokens are the raw human ids, resolved against the working set
 * (MMR-160): an initiative's parent is a bare project KEY, a phase's an
 * initiative node ref (`KEY-seq`), a task's a phase-or-initiative node ref.
 * The per-type verbs above keep their in-transact invariants (parent-type
 * recheck, project-active, rank append) — createNode composes them, never
 * bypasses them. Required-argument presence stays with each transport (its
 * native error class); everything here is value validation and dispatch.
 */

export type CreateNodeProjectInput = {
  type: 'project';
  key: string;
  name: string;
  description?: string;
  openEnded?: boolean;
  tags?: string[];
};

/**
 * Transport-supplied hint lines for parent-resolution errors — the
 * {@link resolveNodeTokenInSet} hint seam carried through `createNode`, so each
 * envelope can point at its own surface (the CLI at `mimir list`, HTTP at its
 * routes) while the message wording stays core-owned.
 */
export type CreateParentHints = {
  project?: string;
  artifact?: string;
  seed?: string;
  notFound?: string;
};

export type CreateNodeInitiativeInput = {
  type: 'initiative';
  /** A bare project KEY. */
  parent: string;
  title: string;
  description?: string;
  summary?: string;
  openEnded?: boolean;
  tags?: string[];
};

export type CreateNodePhaseInput = {
  type: 'phase';
  /** An initiative node ref (`KEY-seq`). */
  parent: string;
  parentHints?: CreateParentHints;
  title: string;
  description?: string;
  summary?: string;
  target?: string;
  openEnded?: boolean;
  tags?: string[];
};

export type CreateNodeTaskInput = {
  type: 'task';
  /** A phase-or-initiative node ref (`KEY-seq`). */
  parent: string;
  parentHints?: CreateParentHints;
  title: string;
  description?: string;
  summary?: string;
  /** Raw priority token — validated against the enum here. */
  priority?: string;
  /** Raw size token — validated against the enum here. */
  size?: string;
  externalRef?: string;
  /** Raw `upstream` wire token (`KEY-sN` or the `none` clear sentinel). */
  upstream?: string;
  openEnded?: boolean;
  tags?: string[];
};

export type CreateNodeInput =
  | CreateNodeProjectInput
  | CreateNodeInitiativeInput
  | CreateNodePhaseInput
  | CreateNodeTaskInput;

export function createNode(store: Store, input: CreateNodeProjectInput): Promise<Project>;
export function createNode(
  store: Store,
  input: CreateNodeInitiativeInput | CreateNodePhaseInput | CreateNodeTaskInput,
): Promise<Node>;
export async function createNode(store: Store, input: CreateNodeInput): Promise<Node | Project> {
  // open_ended is container-only — reject it on task/project create (symmetry with
  // `update`, which throws for the same; MMR-204). Only initiative/phase consume it.
  if ((input.type === 'task' || input.type === 'project') && input.openEnded !== undefined) {
    throw validation('open_ended applies only to phases and initiatives');
  }
  // An if-chain, not a switch: the discriminated union is exhaustive, so the
  // final `task` return needs no unreachable default (keeps consistent-return
  // satisfied without a dead branch).
  if (input.type === 'project') {
    return createProject(store, {
      description: input.description,
      key: input.key,
      name: input.name,
      tags: input.tags,
    });
  }
  if (input.type === 'initiative') {
    return createInitiative(store, {
      description: input.description,
      openEnded: input.openEnded,
      projectId: await resolveInitiativeParent(store, input.parent),
      summary: input.summary,
      tags: input.tags,
      title: input.title,
    });
  }
  if (input.type === 'phase') {
    return createPhase(store, {
      description: input.description,
      openEnded: input.openEnded,
      parentId: await resolveNodeParent(store, input.parent, {
        expected: 'initiative',
        hints: input.parentHints,
        shapeError: "a phase's parent must be an initiative (KEY-seq)",
      }),
      summary: input.summary,
      tags: input.tags,
      target: input.target,
      title: input.title,
    });
  }
  return createTask(store, {
    description: input.description,
    externalRef: input.externalRef,
    parentId: await resolveNodeParent(store, input.parent, {
      expected: 'phase or initiative',
      hints: input.parentHints,
      shapeError: "a task's parent must be a phase or initiative (KEY-seq)",
    }),
    priority: parsePriorityValue(input.priority),
    size: parseSizeValue(input.size),
    summary: input.summary,
    tags: input.tags,
    title: input.title,
    upstream: parseUpstreamValue(input.upstream),
  });
}

/**
 * Resolve an initiative's parent — a bare project KEY — to its canonical
 * identity over the working set. A node/artifact/seed token is the wrong shape
 * for a top-level parent; a malformed token falls through to the key miss.
 */
async function resolveInitiativeParent(store: Store, token: string): Promise<string> {
  const identity = parseIdentity(token);
  if (identity !== null && identity.kind !== 'project') {
    throw validation("an initiative's parent must be a project (KEY)");
  }
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), token);
}

/**
 * Resolve a phase/task parent — a `KEY-seq` node ref — over the working set.
 * A token of a recognizable-but-wrong kind (project/artifact/seed) gets the
 * resolver's kind-aware wording (`X is an artifact, not a <expected>`) with any
 * transport hint; a token no identity grammar matches gets `shapeError`, which
 * names the accepted parent shape. The per-type verb still rechecks the
 * resolved node's actual type in-transact.
 */
async function resolveNodeParent(
  store: Store,
  token: string,
  rules: { expected: string; shapeError: string; hints?: CreateParentHints },
): Promise<string> {
  if (parseIdentity(token) === null) {
    throw validation(rules.shapeError);
  }
  return resolveNodeTokenInSet(
    deriveSet(await store.loadWorkingSet()),
    token,
    rules.expected,
    rules.hints ?? {},
  );
}

/**
 * Validate a raw priority token against the enum — the one `invalid
 * priority: <x>` assert every transport shares (create, update, and promote
 * paths alike, MMR-306). `undefined` passes through untouched (no change).
 */
export function parsePriorityValue(value: string | undefined): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, PRIORITY_VALUES)) {
    throw validation(`invalid priority: ${value}`, `priorities: ${PRIORITY_VALUES.join(', ')}`);
  }
  return value;
}

/**
 * Validate a raw size token against the enum — the shared `invalid size:
 * <x>` assert (MMR-306), sibling to {@link parsePriorityValue}.
 */
export function parseSizeValue(value: string | undefined): Size | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, SIZE_VALUES)) {
    throw validation(`invalid size: ${value}`, `sizes: ${SIZE_VALUES.join(', ')}`);
  }
  return value;
}

/**
 * Parse the raw `upstream` wire token: `KEY-sN` passes through, the `none`
 * sentinel clears (MMR-301), anything else is rejected in shared wording.
 * Exported as the single wire parser — the MCP update path shares it, so the
 * wording can't drift between create and update.
 */
export function parseUpstreamValue(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseUpstreamField(value);
  if (parsed === undefined) {
    throw validation(
      `upstream must be a seed id (KEY-sN) or '${UPSTREAM_CLEAR}' to clear, got ${value}`,
    );
  }
  return parsed;
}
