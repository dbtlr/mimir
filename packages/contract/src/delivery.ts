import { z } from 'zod';

export const DELIVERY_LIFECYCLE_VALUES = [
  'agreed',
  'running',
  'milestone',
  'landed',
  'abandoned',
] as const;
export const DELIVERY_HOLD_VALUES = ['none', 'stopped', 'paused'] as const;
export const DELIVERY_HISTORY_KIND_VALUES = ['lifecycle', 'hold', 'member'] as const;
/** What a `member` history row records happened to its task (ADR 0042). */
export const DELIVERY_MEMBER_EVENT_VALUES = ['joined', 'left', 'released', 'abandoned'] as const;
export type DeliveryLifecycle = (typeof DELIVERY_LIFECYCLE_VALUES)[number];
export type DeliveryHold = (typeof DELIVERY_HOLD_VALUES)[number];
/** The largest time cap or sequence a delivery stores: both columns are int32. */
export const DELIVERY_INT_MAX = 2_147_483_647;
/** A whole number of minutes or a sequence: positive, and within the stores' int32 columns. */
const positiveInt32 = z.number().int().positive().max(DELIVERY_INT_MAX);
export const deliveryFields = {
  agreement: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  external_ref: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
  time_cap_minutes: positiveInt32.nullable().optional(),
};
export const deliveryHistorySchema = z.strictObject({
  at: z.string(),
  from_value: z.string().nullable(),
  kind: z.enum(DELIVERY_HISTORY_KIND_VALUES),
  reason: z.string().nullable(),
  task: z.string().nullable(),
  to_value: z.string().nullable(),
});
export const deliveryRecordSchema = z.strictObject({
  agreement: z.string().nullable(),
  branch: z.string().nullable(),
  created_at: z.string(),
  external_ref: z.string().nullable(),
  harness: z.string().nullable(),
  hold: z.enum(DELIVERY_HOLD_VALUES),
  hold_reason: z.string().nullable(),
  host: z.string().nullable(),
  id: z.string(),
  lifecycle: z.enum(DELIVERY_LIFECYCLE_VALUES),
  phase: z.string(),
  project_key: z.string(),
  seq: positiveInt32,
  session: z.string().nullable(),
  time_cap_minutes: positiveInt32.nullable(),
  title: z.string(),
  updated_at: z.string(),
});
export const deliveryViewSchema = deliveryRecordSchema.extend({
  elapsed_minutes: z.number().nonnegative().nullable(),
  history: z.array(deliveryHistorySchema),
  members: z.array(z.string()),
});
export const deliveryEngineSchema = deliveryViewSchema.extend({
  created_at: z.date(),
  history: z.array(deliveryHistorySchema.extend({ at: z.date() })),
  updated_at: z.date(),
});
export type EngineDelivery = z.output<typeof deliveryEngineSchema>;
export function decodeDelivery(view: DeliveryView): EngineDelivery {
  return {
    ...view,
    created_at: new Date(view.created_at),
    history: view.history.map((entry) => ({ ...entry, at: new Date(entry.at) })),
    updated_at: new Date(view.updated_at),
  };
}
export function encodeDelivery(view: EngineDelivery): DeliveryView {
  return {
    ...view,
    created_at: view.created_at.toISOString(),
    history: view.history.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
    updated_at: view.updated_at.toISOString(),
  };
}
export type DeliveryRecord = z.output<typeof deliveryRecordSchema>;
export type DeliveryHistory = z.output<typeof deliveryHistorySchema>;
export type DeliveryView = z.output<typeof deliveryViewSchema>;
export function deliverySchemas<P extends z.ZodType<string>>(project: P) {
  return {
    deliveries: {
      input: z.strictObject({ project }),
      kind: 'query',
      output: z.array(deliveryEngineSchema),
    },
    deliveryAbandon: {
      input: z.strictObject({ id: z.string(), reason: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryBlock: {
      input: z.strictObject({ id: z.string(), reason: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryCreate: {
      input: z.strictObject({
        ...deliveryFields,
        phase: z.string(),
        tasks: z.array(z.string()).optional(),
        title: z.string().min(1),
      }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryLand: {
      input: z.strictObject({ id: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryPark: {
      input: z.strictObject({ id: z.string(), reason: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryReturn: {
      input: z.strictObject({ id: z.string(), reason: z.string().optional() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryStart: {
      input: z.strictObject({ id: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliverySubmit: {
      input: z.strictObject({ id: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryUnblock: {
      input: z.strictObject({ id: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryUnpark: {
      input: z.strictObject({ id: z.string() }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    deliveryUpdate: {
      input: z.strictObject({
        ...deliveryFields,
        id: z.string(),
        title: z.string().min(1).optional(),
      }),
      kind: 'mutation',
      output: deliveryEngineSchema,
    },
    getDelivery: {
      input: z.strictObject({ id: z.string() }),
      kind: 'query',
      output: deliveryEngineSchema,
    },
  } as const;
}

/** Delivery claims shared by domain rules and transport descriptors (ADR 0025). */
export const DELIVERY_OP_FACTS = {
  abandon: {
    axis: 'lifecycle',
    from: ['agreed', 'running', 'milestone'],
    method: 'deliveryAbandon',
    reason: 'required',
    to: 'abandoned',
  },
  block: {
    axis: 'hold',
    from: ['none'],
    method: 'deliveryBlock',
    reason: 'required',
    to: 'stopped',
  },
  land: {
    axis: 'lifecycle',
    from: ['milestone'],
    method: 'deliveryLand',
    reason: 'none',
    to: 'landed',
  },
  park: { axis: 'hold', from: ['none'], method: 'deliveryPark', reason: 'required', to: 'paused' },
  return: {
    axis: 'lifecycle',
    from: ['milestone'],
    method: 'deliveryReturn',
    reason: 'optional',
    to: 'running',
  },
  start: {
    axis: 'lifecycle',
    from: ['agreed'],
    method: 'deliveryStart',
    reason: 'none',
    to: 'running',
  },
  submit: {
    axis: 'lifecycle',
    from: ['running'],
    method: 'deliverySubmit',
    reason: 'none',
    to: 'milestone',
  },
  unblock: {
    axis: 'hold',
    from: ['stopped'],
    method: 'deliveryUnblock',
    reason: 'none',
    to: 'none',
  },
  unpark: { axis: 'hold', from: ['paused'], method: 'deliveryUnpark', reason: 'none', to: 'none' },
} as const;
export type DeliveryVerb = keyof typeof DELIVERY_OP_FACTS;

/** Whether a flat verb has delivery semantics. */
export function isDeliveryVerb(verb: string): verb is DeliveryVerb {
  return Object.hasOwn(DELIVERY_OP_FACTS, verb);
}
