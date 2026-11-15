import { z } from 'zod';

/** The states of a checklist item (ADR 0044): born `open`, then `checked` or `dropped` for good. */
export const CHECKLIST_ITEM_STATE_VALUES = ['open', 'checked', 'dropped'] as const;

/** The largest item number the stores hold (a 32-bit integer column). */
const MAX_NUMBER = 2147483647;

/** One item as the CLI, MCP, and the transfer document carry it: instants are ISO strings. */
export const checklistItemSchema = z.strictObject({
  content: z.string(),
  created_at: z.string(),
  number: z.number().int().positive().max(MAX_NUMBER),
  reason: z.string().nullable(),
  settled_at: z.string().nullable(),
  state: z.enum(CHECKLIST_ITEM_STATE_VALUES),
});

/** One item as the Engine carries it: instants are `Date` values. */
export const checklistItemEngineSchema = checklistItemSchema.extend({
  created_at: z.date(),
  settled_at: z.date().nullable(),
});

/** A task's whole checklist in number order: every item subcommand returns it. */
export const checklistViewSchema = z.strictObject({
  items: z.array(checklistItemSchema),
  task: z.string(),
});
export const checklistEngineSchema = checklistViewSchema.extend({
  items: z.array(checklistItemEngineSchema),
});

/** An item with the task that holds it: the row the transfer document carries. */
export const checklistRecordSchema = checklistItemSchema.extend({ task: z.string() });

export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type ChecklistItemState = ChecklistItem['state'];
export type ChecklistView = z.infer<typeof checklistViewSchema>;
export type ChecklistRecord = z.infer<typeof checklistRecordSchema>;
export type EngineChecklist = z.output<typeof checklistEngineSchema>;

export function decodeChecklist(view: ChecklistView): EngineChecklist {
  return {
    items: view.items.map((item) => ({
      ...item,
      created_at: new Date(item.created_at),
      settled_at: item.settled_at === null ? null : new Date(item.settled_at),
    })),
    task: view.task,
  };
}

export function encodeChecklist(view: EngineChecklist): ChecklistView {
  return {
    items: view.items.map((item) => ({
      ...item,
      created_at: item.created_at.toISOString(),
      settled_at: item.settled_at === null ? null : item.settled_at.toISOString(),
    })),
    task: view.task,
  };
}

/** The item number an Engine input carries: a positive integer. */
const itemNumber = z.number().int().positive().max(MAX_NUMBER);

export function checklistSchemas() {
  return {
    itemAdd: {
      input: z.strictObject({ content: z.string(), task: z.string() }),
      kind: 'mutation',
      output: checklistEngineSchema,
    },
    itemCheck: {
      input: z.strictObject({ number: itemNumber, task: z.string() }),
      kind: 'mutation',
      output: checklistEngineSchema,
    },
    itemDrop: {
      input: z.strictObject({ number: itemNumber, reason: z.string(), task: z.string() }),
      kind: 'mutation',
      output: checklistEngineSchema,
    },
  } as const;
}
