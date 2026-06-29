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
  /** Subtle tinted chip (badge background + text). */
  chip: string;
  /** Card/control left-accent border — a literal `border-l-status-*` class so Tailwind extracts it. */
  border: string;
};

export const STATUS_META: Record<StatusWord, StatusMeta> = {
  abandoned: {
    border: 'border-l-status-abandoned',
    chip: 'bg-status-abandoned/15 text-status-abandoned',
    dot: 'bg-status-abandoned',
    label: 'Abandoned',
    text: 'text-status-abandoned',
  },
  awaiting: {
    border: 'border-l-status-awaiting',
    chip: 'bg-status-awaiting/15 text-status-awaiting',
    dot: 'bg-status-awaiting',
    label: 'Awaiting',
    text: 'text-status-awaiting',
  },
  blocked: {
    border: 'border-l-status-blocked',
    chip: 'bg-status-blocked/15 text-status-blocked',
    dot: 'bg-status-blocked',
    label: 'Blocked',
    text: 'text-status-blocked',
  },
  done: {
    border: 'border-l-status-done',
    chip: 'bg-status-done/15 text-status-done',
    dot: 'bg-status-done',
    label: 'Done',
    text: 'text-status-done',
  },
  in_progress: {
    border: 'border-l-status-in-progress',
    chip: 'bg-status-in-progress/15 text-status-in-progress',
    dot: 'bg-status-in-progress',
    label: 'In progress',
    text: 'text-status-in-progress',
  },
  new: {
    border: 'border-l-status-new',
    chip: 'bg-status-new/15 text-ink-dim',
    dot: 'bg-status-new',
    label: 'New',
    text: 'text-status-new',
  },
  parked: {
    border: 'border-l-status-parked',
    chip: 'bg-status-parked/15 text-status-parked',
    dot: 'bg-status-parked',
    label: 'Parked',
    text: 'text-status-parked',
  },
  ready: {
    border: 'border-l-status-ready',
    chip: 'bg-status-ready/15 text-status-ready',
    dot: 'bg-status-ready',
    label: 'Ready',
    text: 'text-status-ready',
  },
  under_review: {
    border: 'border-l-status-under-review',
    chip: 'bg-status-under-review/15 text-status-under-review',
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
