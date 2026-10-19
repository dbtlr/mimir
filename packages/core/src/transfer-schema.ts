import {
  AGENDA_ITEM_STATE_VALUES,
  BLOCK_OWNER_VALUES,
  GROOMING_VALUES,
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  SEED_KIND_VALUES,
  SEED_LIFECYCLE_VALUES,
  SIZE_VALUES,
  TRANSITION_KIND_VALUES,
} from '@mimir/contract';
import { z } from 'zod';

import { defaultBlockOwner } from './block-owner';
import type { StoreExport } from './export';
import { STORE_EXPORT_SCHEMA_VERSION } from './export';
import { isScratchpadId } from './scratchpads/store';

// Plain text, not the canonical-instant grammar: import copies stored facts as they
// stand, including a legacy empty timestamp a v0.20 export can carry. Refusing it
// would strand that export and re-stamping it would invent a time, so doctor's
// malformed-timestamp check reports it instead.
const text = z.string();
const nullableText = text.nullable();
const integer = z.int32();
const key = text.regex(/^[A-Z]{2,4}$/);
const handles = z.object({
  branch: text.optional(),
  harness: text.optional(),
  host: text.optional(),
  session: text.optional(),
  worker_harness: text.optional(),
  worker_session: text.optional(),
});
const history = z.object({
  at: text,
  from: nullableText,
  handles: handles.optional(),
  kind: z.enum(['lifecycle', 'hold', 'dependency', 'move', 'archive']),
  reason: nullableText,
  to: nullableText,
});

/** Shape and vocabulary at the import boundary, checked against the Store record type. */
export const transferSchema = z.object({
  annotations: z.array(z.object({ content: text, created_at: text, node_id: text })),
  artifacts: z.array(
    z.object({
      content: text,
      created_at: text,
      key,
      links: z.array(text),
      seq: integer.nonnegative(),
      source_scratch: nullableText,
      summary: nullableText,
      tags: z.array(text),
      title: text,
      updated_at: text,
    }),
  ),
  bodySections: z.array(
    z.object({
      description: nullableText.optional(),
      next: z.object({ present: z.boolean(), text: nullableText }),
      stem: text,
    }),
  ),
  edges: z.array(z.object({ depends_on_node_id: text, node_id: text })),
  exported_at: text,
  nodes: z.array(
    z
      .object({
        // Absent in a document written before the field existed (MMR-438); the
        // transform below derives it.
        block_owner: z.enum(BLOCK_OWNER_VALUES).nullable().optional(),
        branch: nullableText,
        completed_at: nullableText,
        created_at: text,
        description: nullableText,
        external_ref: nullableText,
        // Absent in a document written before the field existed (ADR 0033); the
        // transform below defaults it.
        grooming: z.enum(GROOMING_VALUES).nullable().optional(),
        harness: nullableText,
        hold: z.enum(HOLD_VALUES).nullable(),
        hold_reason: nullableText,
        host: nullableText,
        id: text,
        lifecycle: z.enum(LIFECYCLE_VALUES).nullable(),
        open_ended: z.boolean().nullable(),
        parent_id: nullableText,
        priority: z.enum(PRIORITY_VALUES).nullable(),
        project_id: key,
        rank: integer.nullable(),
        seq: integer.nonnegative(),
        session: nullableText,
        size: z.enum(SIZE_VALUES).nullable(),
        summary: nullableText,
        target: nullableText,
        title: text,
        type: z.enum(NODE_TYPE_VALUES),
        updated_at: text,
        upstream: nullableText,
        worker_harness: nullableText.optional(),
        worker_session: nullableText.optional(),
      })
      // A document written before `grooming` existed imports with the default a
      // fresh node is born with: `not_groomed` for a task, none for a container.
      // A document written before `block_owner` existed (or one that left a
      // blocked task's owner null) takes the owner its `upstream` implies; the
      // owner is empty unless the hold is `blocked`, which the validator checks.
      .transform((node) => ({
        ...node,
        block_owner:
          node.block_owner ?? (node.hold === 'blocked' ? defaultBlockOwner(node.upstream) : null),
        grooming: node.grooming ?? (node.type === 'task' ? ('not_groomed' as const) : null),
        worker_harness: node.worker_harness ?? null,
        worker_session: node.worker_session ?? null,
      })),
  ),
  projects: z.array(
    z
      .object({
        archived_at: nullableText,
        counters: z.object({ artifact: integer, node: integer, seed: integer }),
        created_at: text,
        description: nullableText,
        key,
        name: text,
        // Absent in a document written before the field existed (MMR-493); the
        // transform below defaults it to unpinned.
        pinned: z.boolean().optional(),
        // Absent before version 5 (MMR-543); the transform defaults it to none.
        remote: nullableText.optional(),
        updated_at: text,
      })
      .transform((project) => ({
        ...project,
        pinned: project.pinned ?? false,
        remote: project.remote ?? null,
      })),
  ),
  // A version-1 to -5 document parses into the current shape: its nodes'
  // missing `grooming` and `block_owner` and its projects' missing `pinned` and `remote` are
  // defaulted above, so the version normalizes too.
  schema_version: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(STORE_EXPORT_SCHEMA_VERSION),
    ])
    .transform((): typeof STORE_EXPORT_SCHEMA_VERSION => STORE_EXPORT_SCHEMA_VERSION),
  scratchpads: z.array(
    z.object({
      agenda: z.array(
        z.object({
          content: text,
          number: integer,
          reason: nullableText,
          state: z.enum(AGENDA_ITEM_STATE_VALUES),
        }),
      ),
      anchors: z.array(text),
      createdAt: text,
      freezingAt: nullableText,
      id: text.refine(isScratchpadId, 'expected a canonical scratchpad UUID'),
      journal: z.array(z.object({ at: text, content: text, number: integer })),
      project: key,
      title: text,
      updatedAt: text,
    }),
  ),
  seeds: z.array(
    z.object({
      created_at: text,
      description: nullableText,
      history: z.array(history),
      key,
      kind: z.enum(SEED_KIND_VALUES),
      lifecycle: z.enum(SEED_LIFECYCLE_VALUES),
      requester: nullableText,
      seq: integer.nonnegative(),
      spawned: z.array(text),
      title: text,
      updated_at: text,
    }),
  ),
  tags: z.array(z.object({ entity_id: text, entity_type: z.enum(['node', 'project']), tag: text })),
  transitions: z.array(
    z.object({
      at: text,
      from_value: nullableText,
      handles: handles.optional(),
      kind: z.enum(TRANSITION_KIND_VALUES),
      node_id: nullableText.optional(),
      project_id: nullableText.optional(),
      reason: nullableText.optional(),
      to_value: nullableText,
    }),
  ),
}) satisfies z.ZodType<StoreExport>;
