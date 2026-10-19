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
   * Both CLIs refuse a flag the command does not own. Loom raises it as an
   * unknown option in its own words, so the message and code differ, but the
   * failure carries the old CLI's redirect for the flag, so the hints and
   * the exit code compare.
   */
  | { case: string; kind: 'flag-redirect'; reason: string }
  /**
   * The old CLI accepted the argv and Loom's parser refuses it, exit 2, with a
   * failure code of Loom's own. Argv cases only.
   */
  | { case: string; kind: 'loom-refusal'; reason: string }
  /**
   * The old CLI printed styled text or refused; the new CLI exits 0 and prints
   * a declared JSON view. Every non-empty output line must parse as JSON.
   */
  | { case: string; kind: 'new-view'; reason: string }
  /**
   * A board read names one project (ADR 0034). The old CLI accepted the argv;
   * the new one refuses it with a Mimir code, or exits 0 with different output.
   */
  | { case: string; kind: 'board-read'; reason: string };

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

// MMR-549: the read commands (list, projects, status, tree, overview, artifacts, search, seeds, scratch).
const NO_VIEW =
  "The old CLI printed the status text under this format; Loom's formatter has no such view for the command, so the parser refuses it.";
const NEW_VIEW =
  'The old CLI printed text (or refused) here; the new CLI prints one declared JSON document.';
const BOARD_READ =
  "ADR 0034: a board read names one project; the old CLI's wider read is gone, so the new CLI refuses or returns only that project.";
const REDIRECT =
  "Loom's parser reports a misplaced flag as an unknown option in its own words; the hint is the old CLI's redirect for the flag (flag-owners.ts).";
const COMPOSITE =
  "overview is a composite: the old CLI refused a set format in its own words; Loom's formatter has no such view.";

/**
 * The argv words after `list` and `get` that misplace or retire a flag, one
 * flag each; the owner table (flag-owners.ts) redirects every one. The parity
 * tests run them, and each is a `flag-redirect` entry. A flag `list` owns is
 * misplaced on `get`.
 */
export const LIST_REDIRECTS: readonly string[] = [
  '-s MMR --offset 1 -f ids',
  '-s MMR --since 2020-01-01',
  '-s MMR --not-before created_at:2020-01-01',
  '-s MMR --not-after created_at:2020-01-01',
  '-s MMR --parent MMR-2',
  '-s MMR --title x',
  '-s MMR --summary x',
  '-s MMR --target x',
  '-s MMR --ref x',
  '-s MMR --upstream x',
  '-s MMR --groomed',
  '-s MMR --pinned',
  '-s MMR --not-pinned',
  '-s MMR --remote x',
  '-s MMR --host x',
  '-s MMR --harness x',
  '-s MMR --session x',
  '-s MMR --branch x',
  '-s MMR --project XX',
  '-s MMR --requester XX',
  '-s MMR --direction x',
  '-s MMR --next',
  '-s MMR --clear-links',
  '-s MMR --expected-updated-at x',
  '-s MMR --force',
  '-s MMR --reason x',
  '-s MMR --dry-run',
  '-s MMR --apply',
  '-s MMR --resume',
];
export const GET_REDIRECTS: readonly string[] = [
  'MMR-3 --tz UTC',
  'MMR-3 --at-or-before created_at:2020-01-01',
  'MMR-3 --at-or-after created_at:2020-01-01',
  'MMR-3 --on created_at:2020-01-01',
  'MMR-3 --query x',
  'MMR-3 -q x',
];

/** The `flag-redirect` entry for a redirect line run on `command`. */
const redirectEntry =
  (command: string) =>
  (line: string): ParityDifference => ({
    case: `${command} argv: ${line}`,
    kind: 'flag-redirect',
    reason: REDIRECT,
  });

const MMR_549_READS: readonly ParityDifference[] = [
  { case: 'list -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'list argv: -s MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'list argv: -s MMR -p p1 -p p2 -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'list argv: extra -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'list argv: -s MMR list -f ids', kind: 'loom-refusal', reason: LEADING },
  {
    case: 'projects --scope MMR',
    kind: 'loom-voice',
    reason: `${LOOM_PARSER} projects takes no -s.`,
  },
  {
    case: 'projects --limit 2',
    kind: 'loom-voice',
    reason: `${LOOM_PARSER} projects takes no -n.`,
  },
  {
    case: 'projects argv: --status all --status archived -f ids',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  { case: 'projects argv: extra', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'status (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'status MMR-3 -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'status argv: MMR-3 -f ids', kind: 'loom-refusal', reason: NO_VIEW },
  { case: 'status argv: MMR-3 extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'tree (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'tree argv: MMR extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'overview -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'overview argv: -s MMR -f table', kind: 'loom-voice', reason: COMPOSITE },
  { case: 'overview argv: -s MMR -f ids', kind: 'loom-voice', reason: COMPOSITE },
  { case: 'overview argv: -s MMR extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'artifacts -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'artifacts argv: -s MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'artifacts argv: -s MMR -t a -t b -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'artifacts argv: extra -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'artifacts argv: -s MMR artifacts -f ids', kind: 'loom-refusal', reason: LEADING },
  { case: 'search (no query)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'search store -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'search argv: store -s MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'search argv: store -s MMR -n 1 -n 2 -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'search argv: -s MMR search store -f ids', kind: 'loom-refusal', reason: LEADING },
  { case: 'seeds -p MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'seeds argv: -p MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'seeds argv: -p MMR --status new --status all -f ids',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  { case: 'seeds argv: extra -p MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'seeds argv: -p MMR seeds -f ids', kind: 'loom-refusal', reason: LEADING },
  { case: 'scratch get (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch list -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch argv: list -s MMR -s XX -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'scratch argv: list extra -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'status argv: MMR-3 -f jsonl', kind: 'new-view', reason: NEW_VIEW },
  { case: 'overview argv: -s MMR -f jsonl', kind: 'new-view', reason: NEW_VIEW },
  { case: 'search argv: ours -s MMR -f ids', kind: 'board-read', reason: BOARD_READ },
  { case: 'scratch argv: list -s ZZZ', kind: 'board-read', reason: BOARD_READ },
  { case: 'projects argv: -q x', kind: 'flag-redirect', reason: REDIRECT },
  { case: 'projects argv: -t x', kind: 'flag-redirect', reason: REDIRECT },
  { case: 'projects argv: -n 1', kind: 'flag-redirect', reason: REDIRECT },
  { case: 'scratch argv: (no arguments)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch argv: bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  ...LIST_REDIRECTS.map(redirectEntry('list')),
  ...GET_REDIRECTS.map(redirectEntry('get')),
  {
    case: 'artifacts argv: -s MMR --not-before created_at:2020-01-01',
    kind: 'flag-redirect',
    reason: REDIRECT,
  },
];

export const PARITY_DIFFERENCES: readonly ParityDifference[] = [
  { case: 'get (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'get MMR-3 --tz UTC', kind: 'flag-redirect', reason: REDIRECT },
  { case: 'get MMR-3 -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'next -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'get argv: MMR-3 -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'get argv: MMR-3 extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'next argv: -s MMR -p p1 -p p2 -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'next argv: -s MMR --ascii --ascii', kind: 'loom-refusal', reason: REPEATED },
  { case: 'next argv: extra -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'next argv: -s MMR next -f ids', kind: 'loom-refusal', reason: LEADING },
  { case: 'next argv: -s MMR --bogus -f json', kind: 'loom-voice', reason: LOOM_PARSER },
  ...MMR_549_READS,
];
