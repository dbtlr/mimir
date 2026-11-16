import { z } from 'zod';

import { checklistItemEngineSchema } from './checklist';
import { decisionViewSchema, decisionEngineSchema } from './decision';
import { deliveryDetailEngineSchema, deliveryEngineSchema } from './delivery';
import { engineViews, nodeRefSchema, nodeSchema, seedSchema } from './engine-views';

/** A work-page row tagged with the project it belongs to, as the review page lists them. */
const tagged = <S extends z.ZodRawShape>(shape: S) => z.object({ ...shape, project: z.string() });

/** The console's composite pages, built over one instant codec like the read views. */
function consoleViewSchemas<T extends z.ZodType>(instant: T) {
  const node = nodeSchema(instant);
  const seed = seedSchema(instant);
  const stale = z.boolean();
  const project = z.object({ key: z.string(), name: z.string() });
  const reason = z.enum(['blocked', 'needs_answers']);
  const nowRow = z.object({
    latestNote: z.object({ content: z.string(), createdAt: instant }).nullable(),
    scratchpads: z.array(z.object({ id: z.string(), title: z.string() })),
    stale,
    startedAt: instant,
    submittedAt: instant.nullable(),
    task: node,
  });
  const taskNeedsYouRow = z.object({
    kind: z.literal('task'),
    question: z.string().nullable(),
    reason,
    stale,
    task: node,
  });
  const needsYouRow = z.discriminatedUnion('kind', [
    taskNeedsYouRow,
    z.object({
      decision: decisionViewSchema.omit({ history: true }).extend({
        created_at: instant,
        updated_at: instant,
      }),
      kind: z.literal('decision'),
      workBuiltOnIt: z.boolean(),
    }),
    z.object({
      delivery: z.object({
        hold_reason: z.string().nullable(),
        id: z.string(),
        lifecycle: deliveryEngineSchema.shape.lifecycle,
        phase: z.string(),
        project: z.string(),
        seq: z.number(),
        title: z.string(),
        updated_at: instant,
      }),
      kind: z.literal('delivery'),
    }),
  ]);
  const frontierRow = z.object({
    awaitingOn: z.array(z.string()),
    breakDown: z.boolean(),
    stale,
    task: node,
  });
  const shippedRow = z.object({
    abandonReason: z.string().nullable(),
    finishedAt: instant,
    stale,
    task: node,
  });
  return {
    review: z.object({
      goingCold: z.array(z.object({ project: z.string(), task: node })),
      lastFinished: shippedRow.nullable(),
      needsYou: z.array(z.object({ project, rows: z.array(needsYouRow) })),
      now: z.array(tagged(nowRow.shape)),
      projects: z.array(
        project.extend({
          goingCold: z.number(),
          inFlight: z.number(),
          live: z.number(),
          needsYou: z.number(),
          triage: z.number(),
        }),
      ),
      queue: z.array(z.object({ id: z.string(), kind: z.enum(['delivery', 'decision', 'task']) })),
      runnable: z.array(tagged(frontierRow.shape)),
      shipped: z.array(tagged(shippedRow.shape)),
      triage: z.array(
        z.object({
          findings: z.number(),
          goingCold: z.number(),
          project,
          seeds: z.array(seed),
        }),
      ),
    }),
    work: z.object({
      frontier: z.object({
        nextToUnlock: z.array(
          z.object({ prerequisite: nodeRefSchema, tasks: z.array(frontierRow) }),
        ),
        runnable: z.array(frontierRow),
        toGroom: z.array(frontierRow),
        waitingOnOthers: z.array(
          z.object({ blockReason: z.string().nullable(), stale, task: node }),
        ),
      }),
      goingCold: z.array(node),
      needsYou: z.array(needsYouRow),
      now: z.array(nowRow),
      scope: z.object({
        id: z.string(),
        kind: z.enum(['project', 'initiative', 'phase']),
        title: z.string(),
      }),
      shipped: z.array(shippedRow),
    }),
  };
}

/** Console outputs: every instant is a `Date`. */
export const consoleEngineViews = consoleViewSchemas(z.date());

/** The string-valued core reports, decoded into console outputs by `LocalEngine`. */
export const consoleIntentViews = consoleViewSchemas(
  z.iso.datetime().transform((value) => new Date(value)),
);

const timeZone = z.string().optional();
const asOf = z.date().optional();

/**
 * The console's methods (ADR 0034 decision 6). Their scope is what the page
 * needs, not the one project key that governs the CLI and MCP reads: `review`
 * spans every active project, the work pages take a project key or a container
 * id, the overview takes a project key, `search` (the jump palette) spans
 * every project, ranking the optional `project` first, `openTasks` (the
 * dependency picker) finds the open tasks on any board whose id or title holds
 * the text, and `upstreamTasks` (a seed page's outcomes) finds the tasks on any
 * board that name a seed as their upstream. Keys are checked in
 * core, so the refusals match the Engine's other reads. The time zone is required there
 * for the pages that place a shipped window.
 */
export const consoleSchemas = {
  deliveryPage: {
    input: z.strictObject({ id: z.string() }),
    kind: 'query',
    output: z.object({
      decisions: z.array(decisionEngineSchema),
      delivery: deliveryDetailEngineSchema,
      followUps: z.array(
        z.object({
          id: z.string(),
          items: z.array(checklistItemEngineSchema),
          status: z.string(),
          title: z.string(),
        }),
      ),
      journal: engineViews.scratchpad.shape.journal,
      members: z.array(engineViews.node),
      now: consoleEngineViews.work.shape.now,
      phase: engineViews.node,
    }),
  },
  nodeWork: {
    input: z.strictObject({ asOf, id: z.string(), timeZone }),
    kind: 'query',
    output: consoleEngineViews.work,
  },
  openTasks: {
    input: z.strictObject({ q: z.string() }),
    kind: 'query',
    output: engineViews.nodeSet,
  },
  overview: {
    input: z.strictObject({ asOf, project: z.string() }),
    kind: 'query',
    output: engineViews.overview,
  },
  phaseDeliveries: {
    input: z.strictObject({ id: z.string() }),
    kind: 'query',
    output: z.array(
      z.object({ delivery: deliveryEngineSchema, members: z.array(engineViews.node) }),
    ),
  },
  projectWork: {
    input: z.strictObject({ asOf, project: z.string(), timeZone }),
    kind: 'query',
    output: consoleEngineViews.work,
  },
  review: {
    input: z.strictObject({ asOf, timeZone }),
    kind: 'query',
    output: consoleEngineViews.review,
  },
  search: {
    input: z.strictObject({
      limit: z.number().int().optional(),
      project: z.string().optional(),
      query: z.string(),
    }),
    kind: 'query',
    output: engineViews.searchSet,
  },
  upstreamTasks: {
    input: z.strictObject({ seed: z.string() }),
    kind: 'query',
    output: engineViews.nodeSet,
  },
} as const;

type ConsoleSchemas = typeof consoleSchemas;
export type ConsoleInput<K extends keyof ConsoleSchemas> = z.input<ConsoleSchemas[K]['input']>;
export type ConsoleOutput<K extends keyof ConsoleSchemas> = z.output<ConsoleSchemas[K]['output']>;

/** The Engine's `console` namespace, typed by its contract schemas. */
export type ConsoleEngine = {
  [K in keyof ConsoleSchemas]: (input: ConsoleInput<K>) => Promise<ConsoleOutput<K>>;
};
