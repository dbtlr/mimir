/**
 * The checked-in difference list of the parity harness (ADR 0037). An entry is
 * a reviewed, deliberate difference between the old CLI and the Loom CLI for
 * one named case; anything the list does not name must match. An entry that
 * matches nothing fails its command's parity test, so the list stays current.
 */

export type ParityDifference =
  /** `table` or `records` output differs on exactly these lines. */
  | {
      case: string;
      kind: 'styled';
      reason: string;
      lines: readonly { old: string; new: string }[];
    }
  /** Loom's parser raises this failure in its own voice; only the exit code compares. */
  | { case: string; kind: 'loom-voice'; reason: string };

const LOOM_PARSER = "Loom's parser reports a structural fault in Loom's words and failure code.";

export const PARITY_DIFFERENCES: readonly ParityDifference[] = [
  { case: 'get (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'get MMR-3 --tz UTC', kind: 'loom-voice', reason: `${LOOM_PARSER} get takes no --tz.` },
  { case: 'get MMR-3 -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'next -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
];
