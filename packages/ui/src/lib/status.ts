import type { StatusWord, TaskStatusWord } from '@mimir/contract';
import { TASK_STATUS_WORD_VALUES } from '@mimir/contract';

/**
 * The status color system — one lookup, used identically everywhere a status
 * word shows (overview distribution bars, board column headers, tree badges, the
 * drawer). Class strings are literal so Tailwind extracts them.
 */
export type StatusMeta = {
  /** Human label (the glossary's casing). */
  label: string;
  /** Dot/segment fill. */
  dot: string;
  /** Text in the status color. */
  text: string;
  /** Text in the status *foreground* tone — the legible-on-ground text tier. */
  foreground: string;
  /** Card/control left-accent border — a literal `border-l-status-*` class so Tailwind extracts it. */
  border: string;
};

export const STATUS_META: Record<StatusWord, StatusMeta> = {
  abandoned: {
    border: 'border-l-status-abandoned',
    dot: 'bg-status-abandoned',
    foreground: 'text-status-abandoned-foreground',
    label: 'Abandoned',
    text: 'text-status-abandoned',
  },
  awaiting: {
    border: 'border-l-status-awaiting',
    dot: 'bg-status-awaiting',
    foreground: 'text-status-awaiting-foreground',
    label: 'Awaiting',
    text: 'text-status-awaiting',
  },
  blocked: {
    border: 'border-l-status-blocked',
    dot: 'bg-status-blocked',
    foreground: 'text-status-blocked-foreground',
    label: 'Blocked',
    text: 'text-status-blocked',
  },
  done: {
    border: 'border-l-status-done',
    dot: 'bg-status-done',
    foreground: 'text-status-done-foreground',
    label: 'Done',
    text: 'text-status-done',
  },
  in_progress: {
    border: 'border-l-status-in-progress',
    dot: 'bg-status-in-progress',
    foreground: 'text-status-in-progress-foreground',
    label: 'In progress',
    text: 'text-status-in-progress',
  },
  new: {
    border: 'border-l-status-new',
    dot: 'bg-status-new',
    foreground: 'text-status-new-foreground',
    label: 'New',
    text: 'text-status-new',
  },
  parked: {
    border: 'border-l-status-parked',
    dot: 'bg-status-parked',
    foreground: 'text-status-parked-foreground',
    label: 'Parked',
    text: 'text-status-parked',
  },
  ready: {
    border: 'border-l-status-ready',
    dot: 'bg-status-ready',
    foreground: 'text-status-ready-foreground',
    label: 'Ready',
    text: 'text-status-ready',
  },
  under_review: {
    border: 'border-l-status-under-review',
    dot: 'bg-status-under-review',
    foreground: 'text-status-under-review-foreground',
    label: 'Under review',
    text: 'text-status-under-review',
  },
};

/** Canonical display order for distribution bars and legends. */
export const STATUS_ORDER: readonly StatusWord[] = [
  'in_progress',
  'under_review',
  'ready',
  'awaiting',
  'blocked',
  'parked',
  'new',
  'done',
  'abandoned',
];

/**
 * {@link STATUS_ORDER} narrowed to the task-reachable vocabulary — `new` is
 * container-only (a task never projects to it, and the status selector rejects
 * it), so task-only surfaces must offer this set, not the full one.
 */
export const TASK_STATUS_ORDER: readonly TaskStatusWord[] = STATUS_ORDER.filter(
  (w): w is TaskStatusWord => (TASK_STATUS_WORD_VALUES as readonly string[]).includes(w),
);
