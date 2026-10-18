import { z } from 'zod';

import { FACET_NAMES } from './dto';
import { nodeWriteSchemas } from './engine-node-writes';
import { engineViews } from './engine-views';
import { PRIORITY_VALUES, SEED_STATUS_SELECTOR_VALUES, SIZE_VALUES } from './enums';
import { MimirError } from './errors';
import {
  DATE_OP_VALUES,
  PROJECT_STATUS_SELECTOR_VALUES,
  QUERY_OP_VALUES,
  STATUS_SELECTOR_VALUES,
  VERDICT_VALUES,
} from './query';

export { engineViews, intentViews } from './engine-views';
export type { UniformArgs } from './engine-node-writes';

export type EngineNode = z.output<typeof engineViews.node>;

const facets = z.array(z.enum(FACET_NAMES)).optional();
const count = z.number().int().nonnegative().optional();
/** A bare project key (ADR 0006), the grammar every rendered id starts with. */
export const PROJECT_KEY_PATTERN = /^[A-Z]{2,4}$/;
/** Board reads name one project; only `projects` spans boards, and no key means "all". */
const project = z.string().regex(PROJECT_KEY_PATTERN, 'project must be a project key, such as MMR');
const timeZone = z.string().optional();
const dates = z
  .array(z.strictObject({ field: z.string(), op: z.enum(DATE_OP_VALUES), value: z.string() }))
  .optional();

const nextInput = z.strictObject({
  facets,
  filters: z
    .array(
      z.strictObject({
        field: z.string(),
        op: z.enum(QUERY_OP_VALUES),
        value: z.string().nullable(),
      }),
    )
    .optional(),
  limit: count,
  priority: z.enum(PRIORITY_VALUES).optional(),
  project,
  q: z.string().optional(),
  size: z.enum(SIZE_VALUES).optional(),
  timeZone,
  verdicts: z
    .array(z.strictObject({ negate: z.boolean(), verdict: z.enum(VERDICT_VALUES) }))
    .optional(),
});
const statusSelector = z.enum(STATUS_SELECTOR_VALUES);

export const engineSchemas = {
  artifacts: {
    input: z.strictObject({
      dates,
      limit: count,
      offset: count,
      project,
      q: z.string().optional(),
      tag: z.string().optional(),
      timeZone,
    }),
    kind: 'query',
    output: engineViews.artifactSet,
  },
  getArtifact: {
    input: z.strictObject({ content: z.boolean().optional(), id: z.string() }),
    kind: 'query',
    output: engineViews.artifactDetail,
  },
  getNode: {
    input: z.strictObject({ facets, id: z.string() }),
    kind: 'query',
    output: engineViews.node,
  },
  getSeed: {
    input: z.strictObject({ content: z.boolean().optional(), id: z.string() }),
    kind: 'query',
    output: engineViews.seed,
  },
  list: {
    input: nextInput.extend({
      offset: count,
      status: z.union([statusSelector, z.array(statusSelector)]).optional(),
      tag: z.string().optional(),
    }),
    kind: 'query',
    output: engineViews.nodeSet,
  },
  next: {
    input: nextInput,
    kind: 'query',
    output: engineViews.nodeSet,
  },
  overview: {
    input: z.strictObject({ asOf: z.date().optional(), project }),
    kind: 'query',
    output: engineViews.overview,
  },
  projects: {
    input: z.strictObject({ facets, status: z.enum(PROJECT_STATUS_SELECTOR_VALUES).optional() }),
    kind: 'query',
    output: engineViews.nodes,
  },
  scratchGet: {
    input: z.strictObject({ id: z.string() }),
    kind: 'query',
    output: engineViews.scratchpad,
  },
  scratchList: {
    input: z.strictObject({ project }),
    kind: 'query',
    output: engineViews.scratchpadRows,
  },
  search: {
    input: z.strictObject({ limit: z.number().int().optional(), project, query: z.string() }),
    kind: 'query',
    output: engineViews.searchSet,
  },
  seeds: {
    input: z.strictObject({
      dates,
      project,
      requester: z.string().optional(),
      sort: z.enum(['asc', 'desc']).optional(),
      status: z.enum(SEED_STATUS_SELECTOR_VALUES).optional(),
      timeZone,
    }),
    kind: 'query',
    output: engineViews.seeds,
  },
  status: {
    input: z.strictObject({ id: z.string() }),
    kind: 'query',
    output: engineViews.status,
  },
  tree: {
    input: z.strictObject({ facets, id: z.string() }),
    kind: 'query',
    output: engineViews.tree,
  },
  ...nodeWriteSchemas(project),
} as const;

type EngineSchemas = typeof engineSchemas;
export type EngineInput<K extends keyof EngineSchemas> = z.input<EngineSchemas[K]['input']>;
export type EngineOutput<K extends keyof EngineSchemas> = z.output<EngineSchemas[K]['output']>;

/** One method per operation, typed by its contract schemas. */
export type Engine = {
  [K in keyof EngineSchemas]: (input: EngineInput<K>) => Promise<EngineOutput<K>>;
};

/** Both implementations report malformed method input as the same domain error. */
export function parseEngineInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MimirError('validation', z.prettifyError(result.error));
  }
  return result.data;
}
