import type { Priority, Size, TagEntityType } from '@mimir/contract';

import { allocateSeq, isValidKey } from './allocation';
import type { Db, Tx } from './context';
import { conflict, notFound, validation } from './errors';
import { loadNode } from './lookup';
import type { Node, Project } from './model';
import { assertProjectActive } from './mutations/common';
import { appendRank } from './rank';

/**
 * Create verbs. Each opens one transaction: validate the behavioral invariants
 * (the DB can't check parent type-correctness), allocate the per-project `seq`,
 * insert, and echo the row. Creation establishes initial state and is *not* a
 * transition — no `transition_log` row (the log records later changes, ADR 0003).
 *
 * Parent rules (design spec §3.4): initiative → project (top-level, `parent_id`
 * null); phase → initiative; task → phase or initiative.
 */

/** Insert creation-time tags (MMR-31) — idempotent, note-less, same transaction. */
async function insertTags(
  tx: Tx,
  entityType: TagEntityType,
  entityId: number,
  tags?: string[],
): Promise<void> {
  for (const tag of tags ?? []) {
    await tx
      .insertInto('tag')
      .values({ entity_id: entityId, entity_type: entityType, note: null, tag })
      .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doNothing())
      .execute();
  }
}

export type CreateProjectInput = {
  key: string;
  name: string;
  description?: string | null;
  tags?: string[];
};

export async function createProject(db: Db, input: CreateProjectInput): Promise<Project> {
  if (!isValidKey(input.key)) {
    throw validation(`project key must match [A-Z]{2,4}: ${input.key}`);
  }
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('project')
      .select('id')
      .where('key', '=', input.key)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw conflict(`project key already exists: ${input.key}`);
    }
    const project = await tx
      .insertInto('project')
      .values({
        description: input.description ?? null,
        key: input.key,
        name: input.name,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertTags(tx, 'project', project.id, input.tags);
    return project;
  });
}

export type CreateInitiativeInput = {
  projectId: number;
  title: string;
  description?: string | null;
  tags?: string[];
};

export async function createInitiative(db: Db, input: CreateInitiativeInput): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const project = await tx
      .selectFrom('project')
      .select('id')
      .where('id', '=', input.projectId)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    await assertProjectActive(tx, input.projectId);
    const seq = await allocateSeq(tx, input.projectId);
    const node = await tx
      .insertInto('node')
      .values({
        description: input.description ?? null,
        parent_id: null,
        project_id: input.projectId,
        seq,
        title: input.title,
        type: 'initiative',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertTags(tx, 'node', node.id, input.tags);
    return node;
  });
}

export type CreatePhaseInput = {
  parentId: number;
  title: string;
  description?: string | null;
  target?: string | null;
  tags?: string[];
};

export async function createPhase(db: Db, input: CreatePhaseInput): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const parent = await loadNode(tx, input.parentId);
    if (parent === undefined) {
      throw notFound('the parent was not found');
    }
    if (parent.type !== 'initiative') {
      throw validation(`a phase's parent must be an initiative, not a ${parent.type}`);
    }
    await assertProjectActive(tx, parent.project_id);
    const seq = await allocateSeq(tx, parent.project_id);
    const node = await tx
      .insertInto('node')
      .values({
        description: input.description ?? null,
        parent_id: parent.id,
        project_id: parent.project_id,
        seq,
        target: input.target ?? null,
        title: input.title,
        type: 'phase',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertTags(tx, 'node', node.id, input.tags);
    return node;
  });
}

export type CreateTaskInput = {
  parentId: number;
  title: string;
  description?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  externalRef?: string | null;
  tags?: string[];
};

export async function createTask(db: Db, input: CreateTaskInput): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const parent = await loadNode(tx, input.parentId);
    if (parent === undefined) {
      throw notFound('the parent was not found');
    }
    if (parent.type !== 'phase' && parent.type !== 'initiative') {
      throw validation(`a task's parent must be a phase or initiative, not a ${parent.type}`);
    }
    await assertProjectActive(tx, parent.project_id);
    const seq = await allocateSeq(tx, parent.project_id);
    // A fresh task is todo + none → in the rankable set → append to bottom.
    const rank = await appendRank(tx, parent.project_id);
    const node = await tx
      .insertInto('node')
      .values({
        description: input.description ?? null,
        external_ref: input.externalRef ?? null,
        hold: 'none',
        lifecycle: 'todo',
        parent_id: parent.id,
        priority: input.priority ?? null,
        project_id: parent.project_id,
        rank,
        seq,
        size: input.size ?? null,
        title: input.title,
        type: 'task',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertTags(tx, 'node', node.id, input.tags);
    return node;
  });
}
