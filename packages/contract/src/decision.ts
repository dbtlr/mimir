import { z } from 'zod';

export const DECISION_LIFECYCLE_VALUES = ['provisional', 'confirmed', 'overturned'] as const;
export const DECISION_CLASS_VALUES = ['product', 'architecture', 'other'] as const;
export const decisionHistorySchema = z.strictObject({
  at: z.string(),
  from_value: z.string().nullable(),
  kind: z.enum(['lifecycle', 'link', 'delivery']),
  reason: z.string().nullable(),
  task: z.string().nullable(),
  to_value: z.string().nullable(),
});
export const decisionRecordSchema = z.strictObject({
  class: z.enum(DECISION_CLASS_VALUES),
  created_at: z.string(),
  delivery: z.string().nullable(),
  id: z.string(),
  lifecycle: z.enum(DECISION_LIFECYCLE_VALUES),
  options: z.array(z.string()),
  outcome_note: z.string().nullable(),
  overturn_option: z.number().int().nullable(),
  project_key: z.string(),
  question: z.string(),
  recommended: z.number().int(),
  seq: z.number().int().positive().max(2147483647),
  taken: z.number().int(),
  updated_at: z.string(),
  why: z.string().nullable(),
});
export const decisionViewSchema = decisionRecordSchema.extend({
  history: z.array(decisionHistorySchema),
  tasks: z.array(z.string()),
});
export const decisionEngineSchema = decisionViewSchema.extend({
  created_at: z.date(),
  history: z.array(decisionHistorySchema.extend({ at: z.date() })),
  updated_at: z.date(),
});
export type EngineDecision = z.output<typeof decisionEngineSchema>;
export function decodeDecision(view: DecisionView): EngineDecision {
  return {
    ...view,
    created_at: new Date(view.created_at),
    history: view.history.map((entry) => ({ ...entry, at: new Date(entry.at) })),
    updated_at: new Date(view.updated_at),
  };
}
export function encodeDecision(view: EngineDecision): DecisionView {
  return {
    ...view,
    created_at: view.created_at.toISOString(),
    history: view.history.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
    updated_at: view.updated_at.toISOString(),
  };
}
export type DecisionView = z.infer<typeof decisionViewSchema>;
export type DecisionHistory = z.infer<typeof decisionHistorySchema>;
export function decisionSchemas<P extends z.ZodType<string>>(project: P) {
  return {
    confirm: {
      input: z.strictObject({ id: z.string(), note: z.string().optional() }),
      kind: 'mutation',
      output: decisionEngineSchema,
    },
    decide: {
      input: z.strictObject({
        class: z.enum(DECISION_CLASS_VALUES),
        delivery: z.string().optional(),
        options: z.array(z.string()),
        project: project.optional(),
        question: z.string(),
        recommended: z.number().int(),
        taken: z.number().int().optional(),
        tasks: z.array(z.string()).optional(),
        why: z.string().optional(),
      }),
      kind: 'mutation',
      output: decisionEngineSchema,
    },
    decisionUpdate: {
      input: z.strictObject({
        delivery: z.string().nullable().optional(),
        id: z.string(),
        tasks: z.array(z.string()).optional(),
        untasks: z.array(z.string()).optional(),
      }),
      kind: 'mutation',
      output: decisionEngineSchema,
    },
    decisions: {
      input: z.strictObject({
        classes: z.array(z.enum(DECISION_CLASS_VALUES)).optional(),
        delivery: z.string().optional(),
        linked: z.literal(true).optional(),
        project,
        status: z.enum([...DECISION_LIFECYCLE_VALUES, 'all']).optional(),
      }),
      kind: 'query',
      output: z.array(decisionEngineSchema),
    },
    getDecision: {
      input: z.strictObject({ id: z.string() }),
      kind: 'query',
      output: decisionEngineSchema,
    },
    overturn: {
      input: z.strictObject({
        id: z.string(),
        note: z.string().optional(),
        option: z.number().int().optional(),
      }),
      kind: 'mutation',
      output: decisionEngineSchema,
    },
  } as const;
}
