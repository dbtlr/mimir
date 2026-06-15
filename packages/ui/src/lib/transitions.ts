import type { StatusWord } from "@mimir/contract";

/** The mutation verbs a human can drive from the console (lifecycle + hold). */
export type TransitionVerb = "start" | "done" | "abandon" | "park" | "unpark" | "block" | "unblock";

export interface VerbSpec {
  verb: TransitionVerb;
  label: string;
  /** park/block/abandon carry an optional reason → open the reason dialog first. */
  needsReason: boolean;
}

const LABEL: Record<TransitionVerb, string> = {
  start: "Start",
  done: "Done",
  abandon: "Abandon",
  park: "Park",
  unpark: "Unpark",
  block: "Block",
  unblock: "Unblock",
};

const NEEDS_REASON = new Set<TransitionVerb>(["park", "block", "abandon"]);

/**
 * The verbs offered for each displayed status word — keyed on what the operator
 * sees, not raw lifecycle, so we never offer Start on a held card. Mirrors the
 * core verb guards exactly (start needs todo; done/abandon need non-terminal;
 * park/block need non-terminal + hold=none; unpark/unblock need the matching
 * hold). The core stays the authority and rejects anything illegal.
 */
const VERBS: Partial<Record<StatusWord, TransitionVerb[]>> = {
  in_progress: ["done", "park", "block", "abandon"],
  ready: ["start", "park", "block", "abandon"],
  awaiting: ["start", "park", "block", "abandon"],
  blocked: ["unblock", "abandon"],
  parked: ["unpark", "abandon"],
};

export function availableTransitions(status: StatusWord): VerbSpec[] {
  return (VERBS[status] ?? []).map((verb) => ({
    verb,
    label: LABEL[verb],
    needsReason: NEEDS_REASON.has(verb),
  }));
}
