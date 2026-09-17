import type { Transaction } from 'kysely';

import { conflict, invariant } from '../errors';
import { renderId } from '../ids';
import type { Artifact, Node, Project } from '../model';
import type { NewNodeRecord, NewProjectRecord, NewTransitionRecord, StoreWriter } from '../store';
import { now } from '../time';
import type { DB, NodeUpdate, ProjectUpdate } from './schema';
import { loadWorkingSet, toNode, toProject } from './working-set';

/**
 * The Postgres `StoreWriter` (MMR-135) — the primitives a verb composes inside
 * one `transact`.
 *
 * Every method runs on the transaction itself, so "sees the transaction's own
 * in-flight state" comes free: read-your-writes is what a transaction already
 * gives. There is no accumulator, no overlay, and no drift replay — the Norn
 * writer needs all three because a markdown vault has no transaction to hold
 * the intermediate state in.
 */

/** PostgreSQL SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

/** The columns a fresh node is born with — the defaults the seam implies. */
function newNodeRow(row: NewNodeRecord, id: string, seq: number, timestamp: string) {
  return {
    branch: row.branch ?? null,
    completed_at: null,
    created_at: timestamp,
    description: row.description,
    external_ref: row.external_ref ?? null,
    harness: row.harness ?? null,
    // A task is born unheld; a container carries no hold axis at all.
    hold: row.hold ?? (row.type === 'task' ? ('none' as const) : null),
    hold_reason: null,
    host: row.host ?? null,
    id,
    lifecycle: row.lifecycle ?? null,
    next_present: false,
    next_text: null,
    open_ended: row.open_ended ?? null,
    parent_id: row.parent_id,
    priority: row.priority ?? null,
    project_key: row.project_id,
    rank: row.rank ?? null,
    seq,
    session: row.session ?? null,
    size: row.size ?? null,
    summary: row.summary ?? null,
    target: row.target ?? null,
    title: row.title,
    type: row.type,
    updated_at: timestamp,
    upstream: row.upstream ?? null,
  };
}

export function createPostgresWriter(tx: Transaction<DB>): StoreWriter {
  const nodeExists = async (id: string): Promise<boolean> =>
    (await tx.selectFrom('node').select('id').where('id', '=', id).executeTakeFirst()) !==
    undefined;

  const projectExists = async (key: string): Promise<boolean> =>
    (await tx.selectFrom('project').select('key').where('key', '=', key).executeTakeFirst()) !==
    undefined;

  return {
    async appendTransition(row: NewTransitionRecord) {
      // Fail loud on an unresolvable target rather than dropping the row: a lost
      // transition is lost History. Creation is not a transition (ADR 0003).
      if (row.node_id != null) {
        if (!(await nodeExists(row.node_id))) {
          throw invariant('a transition targets a node absent from the snapshot');
        }
      } else if (row.project_id != null) {
        if (!(await projectExists(row.project_id))) {
          throw invariant('a transition targets a project absent from the snapshot');
        }
      } else {
        throw invariant('a transition targets neither a node nor a project');
      }
      await tx
        .insertInto('transition_log')
        .values({
          at: row.at,
          from_value: row.from_value,
          // The resume-handle echo rides only the boundary rows that move them.
          handles: row.handles === undefined ? null : JSON.stringify(row.handles),
          kind: row.kind,
          node_id: row.node_id ?? null,
          project_key: row.project_id ?? null,
          reason: row.reason ?? null,
          to_value: row.to_value,
        })
        .execute();
    },

    async deleteDependency(edge) {
      const deleted = await tx
        .deleteFrom('dependency')
        .where('node_id', '=', edge.node_id)
        .where('depends_on_node_id', '=', edge.depends_on_node_id)
        .executeTakeFirst();
      return (deleted.numDeletedRows ?? 0n) > 0n;
    },

    async deleteTags(entityType, entityId, tags) {
      if (tags.length === 0) {
        return 0;
      }
      const deleted = await tx
        .deleteFrom('tag')
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .where('tag', 'in', tags)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0n);
    },

    // The primary key forbids two rows claiming one identity, so the collision a
    // markdown vault can hold is not a state this store can reach.
    hasIdentityCollision: () => Promise.resolve(false),

    async insertAnnotation(row) {
      if (!(await nodeExists(row.node_id))) {
        throw invariant('an annotation targets a node absent from the snapshot');
      }
      await tx
        .insertInto('annotation')
        .values({ content: row.content, created_at: row.created_at, node_id: row.node_id })
        .execute();
    },

    async insertDependency(edge) {
      await tx
        .insertInto('dependency')
        .values({ depends_on_node_id: edge.depends_on_node_id, node_id: edge.node_id })
        .onConflict((oc) => oc.doNothing())
        .execute();
    },

    async insertNode(row: NewNodeRecord): Promise<Node> {
      // The counter bump IS the allocation (ADR 0006), inside this transaction:
      // two concurrent creates serialize on the project row rather than racing.
      const allocated = await tx
        .updateTable('project')
        .set((eb) => ({ last_seq: eb('last_seq', '+', 1) }))
        .where('key', '=', row.project_id)
        .returning('last_seq')
        .executeTakeFirst();
      if (allocated === undefined) {
        throw invariant('the project vanished mid-transaction');
      }
      const seq = allocated.last_seq;
      const id = renderId({ key: row.project_id, seq });
      const values = newNodeRow(row, id, seq, now());
      await tx.insertInto('node').values(values).execute();
      const tags = [...new Set(row.tags)];
      if (tags.length > 0) {
        await tx
          .insertInto('tag')
          .values(tags.map((tag) => ({ entity_id: id, entity_type: 'node' as const, tag })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      // The echo carries the description the caller passed, while the working
      // set reads it back as null — the prose is body-authoritative (MMR-162).
      return { ...toNode(values), description: row.description };
    },

    async insertProject(row: NewProjectRecord): Promise<Project> {
      const timestamp = now();
      const project: Project = {
        archived_at: null,
        created_at: timestamp,
        description: row.description,
        key: row.key,
        name: row.name,
        updated_at: timestamp,
      };
      try {
        await tx.insertInto('project').values(project).execute();
      } catch (error) {
        // The verb fences duplicates first; a RAW writer call reaches the key,
        // and must fail the way the verb does rather than as a driver error.
        if (isUniqueViolation(error)) {
          throw conflict(`project key already exists: ${row.key}`);
        }
        throw error;
      }
      const tags = [...new Set(row.tags)];
      if (tags.length > 0) {
        await tx
          .insertInto('tag')
          .values(tags.map((tag) => ({ entity_id: row.key, entity_type: 'project' as const, tag })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      return project;
    },

    async insertTag(row) {
      const inserted = await tx
        .insertInto('tag')
        .values({ entity_id: row.entity_id, entity_type: row.entity_type, tag: row.tag })
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async listChildren(parentId) {
      const rows = await tx
        .selectFrom('node')
        .select('id')
        .where('parent_id', '=', parentId)
        .orderBy('seq')
        .execute();
      return rows.map((row) => row.id);
    },

    async listPrereqsOf(nodeId) {
      const rows = await tx
        .selectFrom('dependency')
        .select('depends_on_node_id')
        .where('node_id', '=', nodeId)
        .orderBy('depends_on_node_id')
        .execute();
      return rows.map((row) => row.depends_on_node_id);
    },

    async listRankedTasks(projectId) {
      const rows = await tx
        .selectFrom('node')
        .select(['id', 'rank', 'seq'])
        .where('project_key', '=', projectId)
        .where('rank', 'is not', null)
        .orderBy('rank')
        .orderBy('seq')
        .execute();
      return rows.flatMap((row) =>
        row.rank === null ? [] : [{ id: row.id, rank: row.rank, seq: row.seq }],
      );
    },

    async loadArtifact(id): Promise<Artifact | undefined> {
      const row = await tx
        .selectFrom('artifact')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            content: row.content,
            created_at: row.created_at,
            id: row.id,
            project_id: row.project_key,
            seq: row.seq,
            title: row.title,
          };
    },

    async loadNode(id) {
      const row = await tx.selectFrom('node').selectAll().where('id', '=', id).executeTakeFirst();
      return row === undefined ? undefined : toNode(row);
    },

    async loadProject(key) {
      const row = await tx
        .selectFrom('project')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined ? undefined : toProject(row);
    },

    loadWorkingSet: () => loadWorkingSet(tx),

    async setNextSection(entityType, entityId, write) {
      // Presence is DERIVED from the prose here, not trusted from the caller: a
      // markdown backend needs it to pick between inserting, replacing, and
      // deleting a heading, while here the heading IS the column pair — so a
      // null text is simply absence, and any text is presence.
      const values = { next_present: write.text !== null, next_text: write.text };
      const present =
        entityType === 'node' ? await nodeExists(entityId) : await projectExists(entityId);
      if (!present) {
        throw invariant('a ## Next write targets a record absent from the snapshot');
      }
      await (entityType === 'node'
        ? tx.updateTable('node').set(values).where('id', '=', entityId).execute()
        : tx.updateTable('project').set(values).where('key', '=', entityId).execute());
    },

    async updateNode(id, patch) {
      if (!(await nodeExists(id))) {
        throw invariant('the record vanished mid-transaction');
      }
      const columns: NodeUpdate = { ...patch };
      if (Object.keys(columns).length === 0) {
        return;
      }
      await tx.updateTable('node').set(columns).where('id', '=', id).execute();
    },

    async updateProject(key, patch) {
      if (!(await projectExists(key))) {
        throw invariant('the record vanished mid-transaction');
      }
      const columns: ProjectUpdate = { ...patch };
      if (Object.keys(columns).length === 0) {
        return;
      }
      await tx.updateTable('project').set(columns).where('key', '=', key).execute();
    },
  };
}
