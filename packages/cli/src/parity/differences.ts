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
  | { case: string; kind: 'board-read'; reason: string }
  /**
   * The old CLI refused with exit 1 and a Mimir code because the command does not
   * take an option; Loom scopes options to the command that declares them, so its
   * parser refuses with exit 2 and a code of its own. Both write nothing.
   */
  | { case: string; kind: 'loom-scoped'; reason: string }
  /**
   * The old CLI accepted and wrote; the Engine refuses the input with a Mimir code,
   * exit 1, and writes nothing.
   */
  | { case: string; kind: 'engine-refusal'; reason: string };

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
const EXCLUSIVE =
  'Loom refuses options that exclude each other; the old CLI took the first one it read.';
const ELSEWHERE =
  'Loom scopes an option to the command that declares it; the old CLI took it on any create type and ignored it.';
const NOT_TAKEN =
  'Loom scopes an option to the command that declares it, so a flag this create type does not take is an unknown option at exit 2; the old CLI refused it as a validation failure at exit 1.';
const BLANK =
  'The Engine refuses blank text, a title, or a name with a validation failure; the old CLI accepted and wrote it.';
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

/** The `flag-redirect` entries for full argv lines, each `command rest`, named as `argvCase` names them. */
const redirectEntries = (lines: readonly string[]): ParityDifference[] =>
  lines.map((line) => ({
    case: line.replace(' ', ' argv: '),
    kind: 'flag-redirect',
    reason: REDIRECT,
  }));

/** One misplaced flag per seed verb and `triage`, each a `flag-redirect` entry. */
export const SEED_REDIRECTS: readonly string[] = [
  'seed x -k idea -s MMR --parent MMR-2',
  'promote MMR-s1 --summary x',
  'reject MMR-s1 no --force',
  // `--reason` is the scratch flag; reject and resolve take the reason as words.
  'resolve MMR-s1 done --reason x',
  'triage MMR --force',
];

/** One misplaced flag per scratch write, each a `flag-redirect` entry. */
export const SCRATCH_REDIRECTS: readonly string[] = [
  'scratch create x -s MMR --parent MMR-2',
  'scratch update abc --parent MMR-2',
  'scratch checkpoint abc t --dry-run',
  'scratch agenda add abc x --dry-run',
  'scratch freeze abc --direction x',
  'scratch discard abc --parent MMR-2',
];

/** One misplaced flag per node-write verb, each a `flag-redirect` entry. */
export const NODE_REDIRECTS: readonly string[] = [
  'annotate MMR-3 note --parent MMR-2',
  'attach MMR-5 --file notes.md --parent MMR-2',
  'create task x --parent MMR-2 --direction x',
  'create phase x --parent MMR-1 --clear-links',
  'create initiative x --parent MMR --not-pinned',
  'create project x --key GAM -y --since 2020-01-01',
  'depend MMR-5 --on MMR-3 --parent MMR-2',
  'undepend MMR-5 --on MMR-3 --parent MMR-2',
  'groom MMR-4 groomed --parent MMR-2',
  'move MMR-5 --to MMR-1 --parent MMR-2',
  'reorder MMR-3 --top --parent MMR-2',
  'tag MMR-5 design --parent MMR-2',
  'untag MMR-3 alpha --parent MMR-2',
  'update MMR-3 --title x --clear-links',
  'update MMR-3 --title x --groomed',
];

/** One misplaced flag per machine-local verb, each a `flag-redirect` entry. */
export const MACHINE_REDIRECTS: readonly string[] = [
  'bind MMR --parent MMR-2',
  'doctor -s MMR --parent MMR-2',
  'store upgrade --parent MMR-2',
  'store export - --parent MMR-2',
  'store import x.json --parent MMR-2',
];

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
  // MMR-552: seed verbs, triage, and scratch writes.
  ...redirectEntries([...SEED_REDIRECTS, ...SCRATCH_REDIRECTS]),
  { case: 'seed (no title)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'seed --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'seed -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'promote (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'promote MMR-s1 --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'reject (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'reject MMR-s1 --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'resolve (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'resolve MMR-s1 --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'triage --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'triage argv: MMR XX', kind: 'loom-refusal', reason: STRAY },
  { case: 'triage argv: MMR -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'scratch create --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch update (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch agenda (no action)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch agenda (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch checkpoint (no id)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'scratch argv: create x -s MMR -s XX', kind: 'loom-refusal', reason: REPEATED },
  {
    case: 'scratch argv: update {pad} --expected-updated-at {token} --title t --title u',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  { case: 'seed argv: "Cache it" -k idea -k bug -s MMR', kind: 'loom-refusal', reason: REPEATED },
  { case: 'seed argv: a b -k idea -s MMR', kind: 'loom-refusal', reason: STRAY },
  { case: 'seed argv: -s MMR seed "Cache it" -k idea', kind: 'loom-refusal', reason: LEADING },
  {
    case: 'promote argv: MMR-s1 --parent MMR-2 -p p1 -p p2',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'promote argv: MMR-s1 --link MMR-3 --link MMR-4',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  { case: 'scratch argv: -s MMR scratch create x', kind: 'loom-refusal', reason: LEADING },
  { case: 'promote argv: MMR-s1 extra --parent MMR-2', kind: 'loom-refusal', reason: STRAY },
  { case: 'resolve argv: MMR-s1 shipped -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  // MMR-551: structure and node writes.
  ...redirectEntries(NODE_REDIRECTS),
  {
    case: 'annotate argv: (no arguments)',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'annotate argv: MMR-3 "a note" --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  { case: 'depend argv: MMR-5', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'depend argv: --on MMR-3', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'undepend argv: MMR-4', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'depend argv: MMR-5 --on MMR-3 --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'depend argv: MMR-5 --on MMR-3 --on MMR-4',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'depend argv: MMR-5 MMR-6 --on MMR-3',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  { case: 'move argv: MMR-5', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'move argv: --to MMR-1', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'move argv: MMR-5 --to MMR-1 --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  { case: 'reorder argv: MMR-3', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'reorder argv: (no arguments)',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'reorder argv: MMR-3 --top --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'move argv: MMR-5 --to MMR-1 --to MMR-2',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'reorder argv: MMR-3 --before MMR-5 --before MMR-8',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'reorder argv: MMR-3 --top --bottom',
    kind: 'loom-refusal',
    reason: EXCLUSIVE,
  },
  {
    case: 'reorder argv: MMR-3 --top --before MMR-5',
    kind: 'loom-refusal',
    reason: EXCLUSIVE,
  },
  { case: 'tag argv: (no arguments)', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'tag argv: MMR-5 design --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'groom argv: (no arguments)',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  { case: 'groom argv: MMR-4', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'groom argv: MMR-4 groomed --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'attach argv: MMR-5 --file <file> --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'attach argv: MMR-5 --file <file> --file <file>',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'attach argv: MMR-5 MMR-6 --file <file>',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  {
    case: 'create argv: project Gamma -y',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: project Gamma --key GAM -y --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: initiative Growth',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: initiative Growth --parent MMR --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: initiative --weird-title --parent MMR',
    kind: 'flag-redirect',
    reason: REDIRECT,
  },
  { case: 'create argv: phase Beta', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'create argv: phase Beta --parent MMR-1 --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: task "Ship docs"',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: task "Ship docs" --parent MMR-2 --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: task --weird-title --parent MMR-2',
    kind: 'flag-redirect',
    reason: REDIRECT,
  },
  { case: 'create argv: epic Title', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'create argv: (no arguments)',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'create argv: project Gamma --key GAM -y --parent MMR',
    kind: 'loom-refusal',
    reason: ELSEWHERE,
  },
  {
    case: 'create argv: project Gamma --key GAM --key GAN -y',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'create argv: project Gamma Delta --key GAM -y',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  {
    case: 'create argv: initiative Growth More --parent MMR',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  {
    case: 'create argv: initiative Growth --parent MMR --target 2026-11',
    kind: 'loom-refusal',
    reason: ELSEWHERE,
  },
  {
    case: 'create argv: task "Ship docs" --parent MMR-2 --target 2026-11',
    kind: 'loom-refusal',
    reason: ELSEWHERE,
  },
  {
    case: 'create argv: task "Ship docs" --parent MMR-2 --parent MMR-1',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'create argv: task "Ship docs" More --parent MMR-2',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  {
    case: 'update argv: (no arguments)',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'update argv: MMR-3 --bogus',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  {
    case: 'update argv: MMR-3 --title a --title b',
    kind: 'loom-refusal',
    reason: REPEATED,
  },
  {
    case: 'update argv: MMR-3 MMR-4 --title a',
    kind: 'loom-refusal',
    reason: STRAY,
  },
  {
    case: 'create argv: project Gamma --key GAM -y --groomed',
    kind: 'loom-scoped',
    reason: NOT_TAKEN,
  },
  {
    case: 'create argv: initiative Growth --parent MMR --groomed',
    kind: 'loom-scoped',
    reason: NOT_TAKEN,
  },
  {
    case: 'create argv: initiative Growth --parent MMR --remote x',
    kind: 'loom-scoped',
    reason: NOT_TAKEN,
  },
  {
    case: 'create argv: task "Ship docs" --parent MMR-2 --open-ended',
    kind: 'loom-scoped',
    reason: NOT_TAKEN,
  },
  { case: 'annotate argv: MMR-3 " "', kind: 'engine-refusal', reason: BLANK },
  {
    case: 'update argv: MMR-3 --title ""',
    kind: 'engine-refusal',
    reason: BLANK,
  },
  {
    case: 'create argv: project " " --key GAM -y',
    kind: 'engine-refusal',
    reason: BLANK,
  },
  // MMR-553: the machine-local commands.
  { case: 'bind MMR -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'bind MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'bind argv: MMR extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'bind argv: MMR -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  { case: 'doctor -s MMR -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'doctor -s MMR --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'doctor argv: -s MMR -s XX', kind: 'loom-refusal', reason: REPEATED },
  { case: 'doctor argv: extra', kind: 'loom-refusal', reason: STRAY },
  { case: 'store', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store frobnicate', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store export (no file)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store import (no file)', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store upgrade -f yaml', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store upgrade --bogus', kind: 'loom-voice', reason: LOOM_PARSER },
  ...['store upgrade --apply', 'store export <file> --apply', 'store export <file> --resume'].map(
    (name): ParityDifference => ({
      case: name,
      kind: 'loom-voice',
      reason:
        'Loom scopes --apply and --resume to store import, so the other verbs reject them as unknown options; the old CLI named them in its own refusal.',
    }),
  ),
  { case: 'store argv: upgrade extra', kind: 'loom-voice', reason: LOOM_PARSER },
  { case: 'store argv: export - extra', kind: 'loom-voice', reason: LOOM_PARSER },
  {
    case: 'store argv: import <dir>/doc.json extra',
    kind: 'loom-voice',
    reason: LOOM_PARSER,
  },
  { case: 'store argv: upgrade -f json -f ids', kind: 'loom-refusal', reason: REPEATED },
  ...redirectEntries(MACHINE_REDIRECTS),
];
