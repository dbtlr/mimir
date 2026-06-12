import type { StatusWord } from "@mimir/contract";

/**
 * The status color system — one lookup, used identically everywhere a status
 * word shows (fleet distribution bars, board column headers, tree badges, the
 * drawer). Class strings are literal so Tailwind extracts them.
 */
export interface StatusMeta {
  /** Human label (the glossary's casing). */
  label: string;
  /** Dot/segment fill. */
  dot: string;
  /** Text in the status color. */
  text: string;
  /** Subtle tinted chip (badge background + text). */
  chip: string;
  /** Card accent border. */
  border: string;
}

export const STATUS_META: Record<StatusWord, StatusMeta> = {
  in_progress: {
    label: "In progress",
    dot: "bg-status-in-progress",
    text: "text-status-in-progress",
    chip: "bg-status-in-progress/15 text-status-in-progress",
    border: "border-status-in-progress",
  },
  ready: {
    label: "Ready",
    dot: "bg-status-ready",
    text: "text-status-ready",
    chip: "bg-status-ready/15 text-status-ready",
    border: "border-status-ready",
  },
  awaiting: {
    label: "Awaiting",
    dot: "bg-status-awaiting",
    text: "text-status-awaiting",
    chip: "bg-status-awaiting/15 text-status-awaiting",
    border: "border-status-awaiting",
  },
  blocked: {
    label: "Blocked",
    dot: "bg-status-blocked",
    text: "text-status-blocked",
    chip: "bg-status-blocked/15 text-status-blocked",
    border: "border-status-blocked",
  },
  parked: {
    label: "Parked",
    dot: "bg-status-parked",
    text: "text-status-parked",
    chip: "bg-status-parked/15 text-status-parked",
    border: "border-status-parked",
  },
  done: {
    label: "Done",
    dot: "bg-status-done",
    text: "text-status-done",
    chip: "bg-status-done/15 text-status-done",
    border: "border-status-done",
  },
  abandoned: {
    label: "Abandoned",
    dot: "bg-status-abandoned",
    text: "text-status-abandoned",
    chip: "bg-status-abandoned/15 text-status-abandoned",
    border: "border-status-abandoned",
  },
  new: {
    label: "New",
    dot: "bg-status-new",
    text: "text-status-new",
    chip: "bg-status-new/15 text-ink-dim",
    border: "border-status-new",
  },
};

/** Canonical display order for distribution bars and legends. */
export const STATUS_ORDER: readonly StatusWord[] = [
  "in_progress",
  "ready",
  "awaiting",
  "blocked",
  "parked",
  "new",
  "done",
  "abandoned",
];
