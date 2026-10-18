import { z } from 'zod';

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
  STATUS_WORD_VALUES,
  TRANSITION_KIND_VALUES,
} from './enums';

const nodeRefSchema = z.object({
  id: z.string(),
  status: z.enum(STATUS_WORD_VALUES).optional(),
  title: z.string().optional(),
});
const distributionSchema = z.partialRecord(z.enum(STATUS_WORD_VALUES), z.number());
const viewTypeSchema = z.enum([...NODE_TYPE_VALUES, 'project']);
const warningSchema = z.object({
  code: z.literal('no_match_value'),
  expected: z.array(z.string()),
  field: z.string(),
  message: z.string(),
  value: z.string(),
});

function setSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    returned: z.number(),
    startsAt: z.number(),
    total: z.number(),
    warnings: z.array(warningSchema).optional(),
  });
}

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
    type: viewTypeSchema,
    updatedAt: instant,
    upstream: z.string().nullable().optional(),
    verdicts: z
      .object({ blocking: z.boolean(), orphaned: z.boolean(), stale: z.boolean() })
      .optional(),
  });
}

function seedSchema<T extends z.ZodType>(instant: T) {
  return z.object({
    createdAt: instant,
    description: z.string().nullable().optional(),
    id: z.string(),
    kind: z.enum(SEED_KIND_VALUES),
    lede: z.string().nullable().optional(),
    lifecycle: z.enum(SEED_LIFECYCLE_VALUES),
    project: z.string(),
    readyToResolve: z.boolean(),
    requester: z.string().nullable(),
    spawned: z.array(z.string()),
    title: z.string(),
    updatedAt: instant,
  });
}

/** Every read projection built over one instant codec, so both directions share a shape. */
function viewSchemas<T extends z.ZodType>(instant: T) {
  const node = nodeSchema(instant);
  // `children` carries full nested records instead of light refs.
  const tree = node.omit({ children: true }).extend({
    get children(): z.ZodArray<typeof tree> {
      return z.array(tree);
    },
  });
  const scratchpadRow = z.object({
    id: z.string(),
    linkedWork: z.array(z.string()),
    openAgenda: z.number(),
    project: z.string(),
    state: z.enum(['active', 'freezing']),
    title: z.string(),
    updatedAt: instant,
  });
  const seed = seedSchema(instant);
  const section = z.object({ count: z.number(), tasks: z.array(node) });
  const attention = z.object({ stale: z.boolean(), task: node });
  return {
    artifactDetail: z.object({
      content: z.string().optional(),
      createdAt: instant,
      id: z.string(),
      links: z.array(z.string()),
      project: z.string(),
      summary: z.string().optional(),
      tags: z.array(z.string()),
      title: z.string(),
    }),
    artifactSet: setSchema(
      z.object({
        createdAt: instant,
        id: z.string(),
        links: z.array(z.string()),
        project: z.string(),
        summary: z.string().optional(),
        tags: z.array(z.string()),
        title: z.string(),
      }),
    ),
    node,
    nodeSet: setSchema(node),
    nodes: z.array(node),
    overview: z.object({
      awaiting: z.object({
        count: z.number(),
        tasks: z.array(z.object({ awaitingOn: z.array(z.string()), task: node })),
      }),
      direction: z.object({
        containers: z.array(z.object({ id: z.string(), next: z.string(), title: z.string() })),
        count: z.number(),
        project: z.string().nullable(),
      }),
      hygiene: z.object({
        blocked: z.number(),
        listings: z.object({
          blocked: z.array(attention),
          stale: z.array(attention),
          untriaged: z.array(
            z.object({ id: z.string(), lede: z.string().nullable(), title: z.string() }),
          ),
        }),
        parkedSeeds: z.number(),
        stale: z.number(),
        untriaged: z.number(),
      }),
      inFlight: section,
      next: section,
      project: z.object({
        distribution: distributionSchema,
        id: z.string(),
        status: z.enum(STATUS_WORD_VALUES),
      }),
      scratchpads: z.object({ count: z.number(), scratchpads: z.array(scratchpadRow) }),
      sessions: z.object({
        entries: z.array(
          z.object({
            artifact: z
              .object({ id: z.string(), summary: z.string().optional(), title: z.string() })
              .optional(),
            from: instant,
            id: z.string().nullable(),
            tasks: z.array(nodeRefSchema),
            to: instant,
            transitions: z.number(),
          }),
        ),
        shown: z.number(),
      }),
    }),
    scratchpad: z.object({
      agenda: z.array(
        z.object({
          content: z.string(),
          number: z.number(),
          reason: z.string().nullable(),
          state: z.enum(AGENDA_ITEM_STATE_VALUES),
        }),
      ),
      anchors: z.array(z.string()),
      createdAt: instant,
      freezingAt: instant.nullable(),
      id: z.string(),
      journal: z.array(z.object({ at: instant, content: z.string(), number: z.number() })),
      project: z.string(),
      title: z.string(),
      updatedAt: instant,
    }),
    scratchpadRows: z.array(scratchpadRow),
    searchSet: setSchema(
      z.object({
        finished: z.boolean(),
        id: z.string(),
        kind: z.enum([...NODE_TYPE_VALUES, 'project', 'seed', 'artifact']),
        lifecycle: z.enum([...LIFECYCLE_VALUES, ...SEED_LIFECYCLE_VALUES]).nullable(),
        link: z
          .enum([
            'parent',
            'child',
            'depends_on',
            'blocks',
            'artifact',
            'upstream',
            'spawned',
            'downstream',
            'attached',
          ])
          .optional(),
        match: z.enum(['id', 'title', 'description', 'link']),
        project: z.string(),
        snippet: z.string().optional(),
        title: z.string(),
        updatedAt: instant,
      }),
    ),
    seed,
    seeds: z.array(seed),
    status: z.object({
      distribution: distributionSchema,
      id: z.string(),
      status: z.enum(STATUS_WORD_VALUES),
      type: viewTypeSchema,
    }),
    tree,
  };
}

/** Engine outputs: every instant is a `Date`. */
export const engineViews = viewSchemas(z.date());

/** The string-valued core projections, decoded into Engine outputs by `LocalEngine`. */
export const intentViews = viewSchemas(z.iso.datetime().transform((value) => new Date(value)));
