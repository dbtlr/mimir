import { z } from 'zod';

import { engineViews } from './engine-views';
import { GROOMING_VALUES, PRIORITY_VALUES, SIZE_VALUES } from './enums';
import type { HandleFieldKey } from './fields';
import { OP_FACTS, UNIFORM_VERBS } from './ops';
import type { UniformVerb } from './ops';

/**
 * The node-write Engine schemas (MMR-517): create, update, annotate, attach,
 * depend, undepend, move, reorder, groom, tag, untag, and the twelve uniform
 * verbs. Ids are canonical (`KEY-seq`, or a bare `KEY` for a project); parsing
 * flag text and resolving shorthand stays in the client. Every echo is a `Date`
 * view, like the reads.
 *
 * The uniform verbs are derived from {@link OP_FACTS} (ADR 0025): a verb's
 * input takes exactly the arguments its fact declares, so a new fact surfaces
 * here with no hand-written schema.
 */

const nullableText = z.string().nullable().optional();
const handles = z.strictObject({
  branch: nullableText,
  harness: nullableText,
  host: nullableText,
  session: nullableText,
});
const tags = z.array(z.string()).optional();

type Fact<V extends UniformVerb> = (typeof OP_FACTS)[V];
type ReasonShape<V extends UniformVerb> =
  Fact<V> extends { reason: 'optional' } ? { reason: z.ZodOptional<z.ZodString> } : unknown;
type FieldsShape<V extends UniformVerb> =
  Fact<V> extends {
    fields: infer F extends readonly HandleFieldKey[];
  }
    ? Record<F[number], z.ZodOptional<z.ZodNullable<z.ZodString>>>
    : unknown;
type ChoiceShape<V extends UniformVerb> =
  Fact<V> extends {
    choice: { name: infer N extends string; values: readonly (infer C extends string)[] };
  }
    ? Record<N, z.ZodOptional<z.ZodEnum<{ [P in C]: P }>>>
    : unknown;
/** The input fields a uniform verb's fact declares, beyond its subject id. */
type UniformShape<V extends UniformVerb> = { id: z.ZodString } & ReasonShape<V> &
  FieldsShape<V> &
  ChoiceShape<V>;
type UniformOutput<V extends UniformVerb> =
  Fact<V> extends { seeds: true }
    ? z.ZodUnion<[typeof engineViews.node, typeof engineViews.seed]>
    : typeof engineViews.node;
type UniformSchemas = {
  [V in UniformVerb]: {
    input: z.ZodObject<UniformShape<V>, z.core.$strict>;
    kind: 'mutation';
    output: UniformOutput<V>;
  };
};

/** The arguments any uniform verb may carry; each verb's schema admits the ones its fact declares. */
export type UniformArgs = {
  id: string;
  reason?: string;
  on?: string;
} & Partial<Record<HandleFieldKey, string | null>>;

/**
 * One uniform verb's input and output, built from its operation fact: the
 * subject id (a bare project key for a project subject), an optional reason,
 * the resume handles `start` records, and a choice such as `block`'s `on`.
 */
function uniformSchema(verb: UniformVerb, project: z.ZodString) {
  const fact = OP_FACTS[verb];
  const shape: Record<string, z.ZodType> = {
    id: fact.subject === 'project' ? project : z.string(),
  };
  if (fact.reason === 'optional') {
    shape.reason = z.string().optional();
  }
  if ('fields' in fact) {
    for (const key of fact.fields) {
      shape[key] = nullableText;
    }
  }
  if ('choice' in fact) {
    shape[fact.choice.name] = z.enum(fact.choice.values).optional();
  }
  return {
    input: z.strictObject(shape),
    kind: 'mutation',
    output: 'seeds' in fact ? z.union([engineViews.node, engineViews.seed]) : engineViews.node,
  };
}

/** Narrow the runtime-built table to the per-verb schema types the facts imply. */
function uniformSchemas(project: z.ZodString): UniformSchemas {
  const built = Object.fromEntries(
    UNIFORM_VERBS.map((verb) => [verb, uniformSchema(verb, project)]),
  );
  // The table is built by iterating exactly UNIFORM_VERBS, so every key is present.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return built as unknown as UniformSchemas;
}

/** `project` is the bare-key schema `engine.ts` already uses for board scope. */
export function nodeWriteSchemas(project: z.ZodString) {
  return {
    ...uniformSchemas(project),
    annotate: {
      input: z.strictObject({ content: z.string(), id: z.string() }),
      kind: 'mutation',
      output: engineViews.node,
    },
    attach: {
      input: z.strictObject({
        content: z.string(),
        links: z.array(z.string()).optional(),
        project: project.optional(),
        summary: z.string().nullable().optional(),
        tags,
        title: z.string(),
      }),
      kind: 'mutation',
      output: engineViews.artifactDetail,
    },
    create: {
      input: z.discriminatedUnion('type', [
        z.strictObject({
          description: z.string().optional(),
          key: project,
          name: z.string(),
          tags,
          type: z.literal('project'),
        }),
        z.strictObject({
          description: z.string().optional(),
          openEnded: z.boolean().optional(),
          parent: project,
          summary: z.string().optional(),
          tags,
          title: z.string(),
          type: z.literal('initiative'),
        }),
        z.strictObject({
          description: z.string().optional(),
          openEnded: z.boolean().optional(),
          parent: z.string(),
          summary: z.string().optional(),
          tags,
          target: z.string().optional(),
          title: z.string(),
          type: z.literal('phase'),
        }),
        z.strictObject({
          description: z.string().optional(),
          externalRef: z.string().optional(),
          groomed: z.boolean().optional(),
          handles: handles.optional(),
          parent: z.string(),
          priority: z.enum(PRIORITY_VALUES).optional(),
          size: z.enum(SIZE_VALUES).optional(),
          summary: z.string().optional(),
          tags,
          title: z.string(),
          type: z.literal('task'),
          upstream: z.string().optional(),
        }),
      ]),
      kind: 'mutation',
      output: engineViews.node,
    },
    depend: {
      input: z.strictObject({ id: z.string(), on: z.array(z.string()).min(1) }),
      kind: 'mutation',
      output: engineViews.node,
    },
    groom: {
      input: z.strictObject({
        ids: z.array(z.string()).min(1),
        note: z.string().optional(),
        state: z.enum(GROOMING_VALUES),
      }),
      kind: 'mutation',
      output: engineViews.nodes,
    },
    move: {
      input: z.strictObject({ id: z.string(), to: z.string() }),
      kind: 'mutation',
      output: engineViews.node,
    },
    reorder: {
      input: z.discriminatedUnion('position', [
        z.strictObject({ id: z.string(), position: z.literal('top') }),
        z.strictObject({ id: z.string(), position: z.literal('bottom') }),
        z.strictObject({ id: z.string(), position: z.literal('before'), ref: z.string() }),
        z.strictObject({ id: z.string(), position: z.literal('after'), ref: z.string() }),
      ]),
      kind: 'mutation',
      output: engineViews.node,
    },
    tag: {
      input: z.strictObject({
        ids: z.array(z.string()).min(1),
        tags: z.array(z.string()).min(1),
      }),
      kind: 'mutation',
      output: z.object({ ids: z.array(z.string()), tags: z.array(z.string()) }),
    },
    undepend: {
      input: z.strictObject({ id: z.string(), on: z.array(z.string()).min(1) }),
      kind: 'mutation',
      output: engineViews.node,
    },
    untag: {
      input: z.strictObject({
        ids: z.array(z.string()).min(1),
        tags: z.array(z.string()).min(1),
      }),
      kind: 'mutation',
      output: z.object({
        ids: z.array(z.string()),
        removed: z.number(),
        tags: z.array(z.string()),
      }),
    },
    update: {
      input: z.strictObject({
        branch: nullableText,
        description: nullableText,
        externalRef: nullableText,
        harness: nullableText,
        host: nullableText,
        id: z.string(),
        next: nullableText,
        openEnded: z.boolean().optional(),
        priority: z.enum(PRIORITY_VALUES).nullable().optional(),
        session: nullableText,
        size: z.enum(SIZE_VALUES).nullable().optional(),
        summary: nullableText,
        target: nullableText,
        title: z.string().optional(),
        upstream: nullableText,
      }),
      kind: 'mutation',
      output: engineViews.node,
    },
    updateProject: {
      input: z.strictObject({
        description: nullableText,
        id: project,
        name: z.string().optional(),
        next: nullableText,
        pinned: z.boolean().optional(),
      }),
      kind: 'mutation',
      output: engineViews.node,
    },
  } as const;
}
