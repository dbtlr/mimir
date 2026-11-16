import type { ChecklistItem } from '@mimir/contract';

/** The read side of a task's checklist (ADR 0044). Every write goes through `StoreWriter`. */
export type ChecklistStore = {
  /** A task's items in number order. */
  forTask: (id: string) => Promise<ChecklistItem[]>;
  /** Several tasks' items in one read, each in number order; a task with none maps to []. */
  forTasks: (ids: readonly string[]) => Promise<Map<string, ChecklistItem[]>>;
};

/** What `add` records: the number is allocated inside the writing transaction. */
export type NewChecklistItem = {
  task: string;
  content: string;
  created_at: string;
};

/** What `check` and `drop` record on an open item. */
export type ChecklistSettle = {
  state: 'checked' | 'dropped';
  reason: string | null;
  settled_at: string;
};
