import {
  AGENDA_ITEM_STATE_VALUES,
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

import type { StoreExport } from './export';
import { STORE_EXPORT_SCHEMA_VERSION } from './export';
import { isScratchpadId } from './scratchpads/store';

// Preserve legacy empty timestamps. Import copies stored facts; doctor repairs them.
const text = z.string();
const nullableText = text.nullable();
const integer = z.int32();
const key = text.regex(/^[A-Z]{2,4}$/);
const handles = z.object({
  branch: text.optional(),
  harness: text.optional(),
  host: text.optional(),
  session: text.optional(),
});
const history = z.object({
  at: text,
  from: nullableText,
  handles: handles.optional(),
  kind: z.enum(TRANSITION_KIND_VALUES),
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
    z.object({
      branch: nullableText,
      completed_at: nullableText,
      created_at: text,
      description: nullableText,
      external_ref: nullableText,
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
    }),
  ),
  projects: z.array(
    z.object({
      archived_at: nullableText,
      counters: z.object({ artifact: integer, node: integer, seed: integer }),
      created_at: text,
      description: nullableText,
      key,
      name: text,
      updated_at: text,
    }),
  ),
  schema_version: z.literal(STORE_EXPORT_SCHEMA_VERSION),
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
