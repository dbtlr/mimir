import type { StatusWord } from '@mimir/contract';

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
  /** Card/control left-accent border — a literal `border-l-status-*` class so Tailwind extracts it. */
  border: string;
};

export const STATUS_META: Record<StatusWord, StatusMeta> = {
  abandoned: {
    border: 'border-l-status-abandoned',
    dot: 'bg-status-abandoned',
    label: 'Abandoned',
    text: 'text-status-abandoned',
  },
  awaiting: {
    border: 'border-l-status-awaiting',
    dot: 'bg-status-awaiting',
    label: 'Awaiting',
    text: 'text-status-awaiting',
  },
  blocked: {
    border: 'border-l-status-blocked',
    dot: 'bg-status-blocked',
    label: 'Blocked',
    text: 'text-status-blocked',
  },
  done: {
    border: 'border-l-status-done',
    dot: 'bg-status-done',
    label: 'Done',
    text: 'text-status-done',
  },
  in_progress: {
    border: 'border-l-status-in-progress',
    dot: 'bg-status-in-progress',
    label: 'In progress',
    text: 'text-status-in-progress',
  },
  new: {
    border: 'border-l-status-new',
    dot: 'bg-status-new',
    label: 'New',
    text: 'text-status-new',
  },
  parked: {
    border: 'border-l-status-parked',
    dot: 'bg-status-parked',
    label: 'Parked',
    text: 'text-status-parked',
  },
  ready: {
    border: 'border-l-status-ready',
    dot: 'bg-status-ready',
    label: 'Ready',
    text: 'text-status-ready',
  },
  under_review: {
    border: 'border-l-status-under-review',
    dot: 'bg-status-under-review',
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
