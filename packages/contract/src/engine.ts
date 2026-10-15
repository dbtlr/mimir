import { z } from 'zod';

import { FACET_NAMES } from './dto';
import {
  BLOCK_OWNER_VALUES,
  GROOMING_VALUES,
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  SIZE_VALUES,
  STATUS_WORD_VALUES,
  TRANSITION_KIND_VALUES,
} from './enums';
import { MimirError } from './errors';

const nodeRefSchema = z.object({
  id: z.string(),
  status: z.enum(STATUS_WORD_VALUES).optional(),
  title: z.string().optional(),
});
const distributionSchema = z.partialRecord(z.enum(STATUS_WORD_VALUES), z.number());

/** One projection shape, with timestamps decoded only at the Engine boundary. */
function nodeSchema<T extends z.ZodType>(instant: T) {
  return z.object({
    annotations: z.array(z.object({ content: z.string(), createdAt: instant })).optional(),
    archivedAt: instant.nullable().optional(),
    artifactCount: z.number().optional(),
    artifacts: z
      .array(
        z.object({
          createdAt: instant,
          id: z.string(),
          summary: z.string().optional(),
          tags: z.array(z.string()),
          title: z.string(),
        }),
      )
      .optional(),
    blockOwner: z.enum(BLOCK_OWNER_VALUES).nullable().optional(),
    branch: z.string().nullable().optional(),
    children: z.array(nodeRefSchema).optional(),
    completedAt: instant.nullable().optional(),
    createdAt: instant,
    deps: z
      .object({
        awaitingOn: z.array(nodeRefSchema.extend({ via: z.string().optional() })),
        blocking: z.array(nodeRefSchema),
        dependsOn: z.array(nodeRefSchema),
      })
      .optional(),
    description: z.string().nullable().optional(),
    distribution: distributionSchema.optional(),
    externalRef: z.string().nullable().optional(),
    grooming: z.enum(GROOMING_VALUES).optional(),
    harness: z.string().nullable().optional(),
    history: z
      .array(
        z.object({
          at: instant,
          from: z.string().nullable(),
          handles: z
            .object({
              branch: z.string().optional(),
              harness: z.string().optional(),
              host: z.string().optional(),
              session: z.string().optional(),
            })
            .optional(),
          kind: z.enum(TRANSITION_KIND_VALUES),
          reason: z.string().nullable(),
          to: z.string().nullable(),
        }),
      )
      .optional(),
    hold: z.enum(HOLD_VALUES).optional(),
    holdReason: z.string().nullable().optional(),
    home: z
      .object({
        parentId: z.string().nullable(),
        parentOpenEnded: z.boolean().nullable(),
        parentTitle: z.string().nullable(),
        projectKey: z.string(),
      })
      .optional(),
    host: z.string().nullable().optional(),
    id: z.string(),
    lastActivityAt: instant.optional(),
    leafCounts: distributionSchema.optional(),
    lede: z.string().nullable().optional(),
    lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
    next: z.string().optional(),
    open_ended: z.boolean().nullable().optional(),
    parent: z.string().nullable(),
    pinned: z.boolean().optional(),
    priority: z.enum(PRIORITY_VALUES).nullable().optional(),
    session: z.string().nullable().optional(),
    size: z.enum(SIZE_VALUES).nullable().optional(),
    status: z.enum(STATUS_WORD_VALUES),
    summary: z.string().nullable().optional(),
    tags: z.array(z.object({ createdAt: instant, tag: z.string() })).optional(),
    target: z.string().nullable().optional(),
    title: z.string(),
    type: z.enum([...NODE_TYPE_VALUES, 'project']),
    updatedAt: instant,
    upstream: z.string().nullable().optional(),
    verdicts: z
      .object({ blocking: z.boolean(), orphaned: z.boolean(), stale: z.boolean() })
      .optional(),
  });
}

export const engineNodeSchema = nodeSchema(z.date());
export type EngineNode = z.output<typeof engineNodeSchema>;

/** The existing intent projection stays string-valued for CLI, MCP, and HTTP. */
export const engineNodeFromViewSchema = nodeSchema(
  z.iso.datetime().transform((value) => new Date(value)),
);

export const engineSchemas = {
  done: {
    input: z.strictObject({ id: z.string() }),
    kind: 'mutation',
    output: engineNodeSchema,
  },
  getNode: {
    input: z.strictObject({ facets: z.array(z.enum(FACET_NAMES)).optional(), id: z.string() }),
    kind: 'query',
    output: engineNodeSchema,
  },
} as const;

export type Engine = {
  getNode: (input: z.input<typeof engineSchemas.getNode.input>) => Promise<EngineNode>;
  done: (input: z.input<typeof engineSchemas.done.input>) => Promise<EngineNode>;
};

/** Both implementations report malformed method input as the same domain error. */
export function parseEngineInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MimirError('validation', result.error.message);
  }
  return result.data;
}
