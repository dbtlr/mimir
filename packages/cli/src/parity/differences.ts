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
  /**
   * Both CLIs refuse; Loom's parser raises the new failure in its own voice, so
   * only the exit code compares. The new code must be Loom's, and the two
   * failures must differ.
   */
  | { case: string; kind: 'loom-voice'; reason: string }
  /**
   * The old CLI accepted the argv and Loom's parser refuses it, exit 2, with a
   * failure code of Loom's own. Argv cases only.
   */
  | { case: string; kind: 'loom-refusal'; reason: string };

/**
 * Two reviewed differences every case carries, which the harness normalizes
 * rather than listing per line (ADR 0037):
 *
 * - through argv, help's plugin appends this pointer as the last hint of every
 *   usage failure; the old CLI named no help page, or named it in its own hint;
 * - on a terminal, Loom closes each style with its own reset (`\e[22m` after
 *   bold, `\e[39m` after a color) where the old CLI wrote `\e[0m`.
 */
export const HELP_POINTER = /^Run "mimir(?: [a-z-]+)* --help" to see the usage\.$/;
/** Loom's style resets, each of which the old CLI wrote as `\\e[0m`. */
export const LOOM_RESETS: readonly string[] = ['\u001B[22m', '\u001B[39m'];

const LOOM_PARSER = "Loom's parser reports a structural fault in Loom's words and failure code.";
const REPEATED = 'Loom refuses a repeated single-value option; the old CLI kept the last value.';
const STRAY = 'Loom refuses a positional the command does not declare; the old CLI ignored it.';
const LEADING =
  'Loom scopes an option to the command that declares it; the old CLI read -s before the verb.';

export const PARITY_DIFFERENCES: readonly ParityDifference[] = [
  { case: 'get (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'get MMR-3 --tz UTC', kind: 'loom-voice', reason: `${LOOM_PARSER} get takes no --tz.` },
  { case: 'get MMR-3 -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'next -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'get argv: MMR-3 -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'get argv: MMR-3 extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'next argv: -s MMR -p p1 -p p2 -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'next argv: -s MMR --ascii --ascii', kind: 'loom-refusal', reason: REPEATED },
  { case: 'next argv: extra -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'next argv: -s MMR next -f ids', kind: 'loom-refusal', reason: LEADING },
  { case: 'next argv: -s MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
];
