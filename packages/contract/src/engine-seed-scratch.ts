import { z } from 'zod';

import { engineViews } from './engine-views';
import { PRIORITY_VALUES, SEED_KIND_VALUES, SIZE_VALUES } from './enums';

/**
 * The Seed and Scratchpad write methods. Built over the caller's bare project-key
 * schema so this file never imports `engine.ts` (which spreads it into the table).
 *
 * A Scratchpad guard (`expectedUpdatedAt`) is the `Date` the previous Scratchpad
 * output carried, so a client echoes the instant it read instead of a string.
 */
export function seedScratchSchemas<P extends z.ZodType<string>>(project: P) {
  const id = z.string();
  const guard = { expectedUpdatedAt: z.date(), id };
  const agendaNumber = z.number().int().positive();

  return {
    scratchAgendaAdd: {
      input: z.strictObject({ ...guard, content: z.string() }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    scratchAgendaComplete: {
      input: z.strictObject({ ...guard, number: agendaNumber }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    scratchAgendaSupersede: {
      input: z.strictObject({ ...guard, number: agendaNumber, reason: z.string() }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    scratchCheckpoint: {
      input: z.strictObject({ ...guard, content: z.string() }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    scratchCreate: {
      input: z.strictObject({
        anchors: z.array(z.string()).optional(),
        project,
        title: z.string(),
      }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    scratchDiscard: {
      input: z.strictObject({
        ...guard,
        force: z.boolean().optional(),
        reason: z.string().optional(),
      }),
      kind: 'mutation',
      output: engineViews.scratchpadDiscard,
    },
    scratchFreeze: {
      input: z.strictObject({
        ...guard,
        summary: z.string(),
        tags: z.array(z.string()).optional(),
      }),
      kind: 'mutation',
      output: engineViews.artifactDetail,
    },
    scratchUpdate: {
      input: z.strictObject({
        ...guard,
        anchors: z.array(z.string()).optional(),
        title: z.string().optional(),
      }),
      kind: 'mutation',
      output: engineViews.scratchpad,
    },
    seedCreate: {
      input: z.strictObject({
        description: z.string().nullable().optional(),
        kind: z.enum(SEED_KIND_VALUES),
        project,
        requester: z.string().nullable().optional(),
        title: z.string(),
      }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    seedPark: {
      input: z.strictObject({ id, reason: z.string().optional() }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    seedPromote: {
      input: z.strictObject({
        description: z.string().nullable().optional(),
        id,
        link: z.string().optional(),
        parent: z.string().optional(),
        priority: z.enum(PRIORITY_VALUES).nullable().optional(),
        size: z.enum(SIZE_VALUES).nullable().optional(),
        tags: z.array(z.string()).optional(),
        title: z.string().optional(),
      }),
      kind: 'mutation',
      output: engineViews.seedPromotion,
    },
    seedReject: {
      input: z.strictObject({ id, reason: z.string() }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    seedResolve: {
      input: z.strictObject({ id, reason: z.string() }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    seedUnpark: {
      input: z.strictObject({ id }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    seedUpdate: {
      input: z.strictObject({
        description: z.string().nullable().optional(),
        id,
        kind: z.enum(SEED_KIND_VALUES).optional(),
        title: z.string().optional(),
      }),
      kind: 'mutation',
      output: engineViews.seed,
    },
    triage: {
      input: z.strictObject({ board: project, dryRun: z.boolean().optional() }),
      kind: 'mutation',
      output: engineViews.triageReport,
    },
  } as const;
}
