/**
 * The flags a command does not declare but another does, or that were retired,
 * each with the redirect the old CLI printed when one was misplaced (MMR-321,
 * MMR-360, ADR 0029). Loom reports a misplaced flag as an unknown option; the
 * failures plugin looks the flag up here and prints the redirect as its hint,
 * so the caller learns where the flag lives instead of only that it is unknown.
 *
 * A layer that ports a command adds the flags that command owns to this table.
 * An empty `owner` list marks a retired spelling that no command owns. An
 * `only` entry is a redirect for one command that refuses the flag.
 */

/** The commands that run a date-filtered query, the owners of the date grammar. */
const DATE_QUERY_VERBS: readonly string[] = ['list', 'next', 'artifacts', 'seeds'];

type FlagOwner = {
  /** The long spelling, without its dashes. */
  flag: string;
  /** The short spelling, without its dash. */
  short?: string;
  /** When set, the redirect is for this one command, which refuses the flag. */
  only?: string;
  /** The commands that own the flag; none when it is retired. */
  owner: readonly string[];
  /** The redirect printed as the failure's hint. */
  hint: string;
};

const FLAG_OWNERS: readonly FlagOwner[] = [
  {
    flag: 'tz',
    hint: `'--tz' resolves a bare date in a query and renders its results; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: 'at-or-before',
    hint: `'--at-or-before FIELD:VALUE' filters a query; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: 'at-or-after',
    hint: `'--at-or-after FIELD:VALUE' filters a query; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: 'on',
    hint: `'--on' names the owner at block (you|others), the prerequisites at depend/undepend, and a date filter at ${DATE_QUERY_VERBS.join(', ')}`,
    owner: ['block', 'depend', 'undepend', ...DATE_QUERY_VERBS],
  },
  {
    flag: 'since',
    hint: `'--since' is retired; every resource windows created_at with '--at-or-after created_at:YYYY-MM-DD'`,
    owner: [],
  },
  {
    flag: 'not-before',
    hint: `'--not-before' is retired; the inclusive lower bound is '--at-or-after FIELD:VALUE'`,
    owner: [],
  },
  {
    flag: 'not-after',
    hint: `'--not-after' is retired; the inclusive upper bound is '--at-or-before FIELD:VALUE'`,
    owner: [],
  },
  {
    flag: 'offset',
    hint: `'--offset' pages the artifact feed; list/next cap with '-n, --limit'`,
    owner: ['artifacts'],
  },
  {
    flag: 'query',
    hint: `'-q, --query' searches titles; use it with artifacts, list, or next`,
    owner: ['artifacts', 'list', 'next'],
    short: 'q',
  },
  {
    flag: 'parent',
    hint: `'--parent' sets the owner at creation; list/next filter with '--eq parent:KEY'`,
    owner: ['create', 'promote'],
  },
  {
    flag: 'title',
    hint: `'--title' is a positional at create (mimir create task <title> …); the flag names a node at update/attach/scratch, or overrides promote's spawned title; list/next filter with '--eq title:KEY' or search with '-q, --query'`,
    owner: ['update', 'attach', 'promote', 'scratch'],
  },
  {
    flag: 'summary',
    hint: `'--summary' sets the summary at create/update/attach/scratch; list/next filter with '--eq summary:KEY'`,
    owner: ['create', 'update', 'attach', 'scratch'],
  },
  {
    flag: 'target',
    hint: `'--target' sets a phase's target at create/update; list/next filter with '--eq target:KEY'`,
    owner: ['create', 'update'],
  },
  {
    flag: 'ref',
    hint: `'--ref' sets external_ref at create/update; list/next filter with '--eq external_ref:KEY'`,
    owner: ['create', 'update'],
  },
  {
    flag: 'upstream',
    hint: `'--upstream' sets the requester-side seed pointer at create/update; list/next filter the task field with '--eq upstream:KEY'`,
    owner: ['create', 'update'],
  },
  {
    flag: 'groomed',
    hint: `'--groomed' creates a task already groomed; list/next filter with '--eq grooming:groomed', and 'mimir groom <ids> <state>' sets it later`,
    owner: ['create'],
  },
  {
    flag: 'pinned',
    hint: `'--pinned' pins a project: mimir update <KEY> --pinned (undo with --not-pinned)`,
    owner: ['update'],
  },
  {
    flag: 'not-pinned',
    hint: `'--not-pinned' unpins a project: mimir update <KEY> --not-pinned`,
    owner: ['update'],
  },
  {
    flag: 'remote',
    hint: `'--remote' sets a project's Git remote at create project / update KEY`,
    owner: ['create', 'update'],
  },
  ...['host', 'harness', 'session', 'branch'].map((flag): FlagOwner => ({
    flag,
    hint: `'--${flag}' sets a resume handle at create/update/queue/start; list/next filter with '--eq ${flag}:KEY'`,
    owner: ['create', 'update', 'queue', 'start'],
  })),
  {
    flag: 'project',
    hint: `'--project' targets attach/seed/seeds; list/next scope a project with '-s, --scope KEY'`,
    owner: ['attach', 'seed', 'seeds'],
  },
  {
    flag: 'requester',
    hint: `'--requester' filters seeds a board requested; use it with seeds`,
    owner: ['seeds'],
  },
  {
    flag: 'direction',
    hint: `the ## Next narrative is set after create: mimir update <id> --direction "…"`,
    owner: ['update'],
  },
  {
    flag: 'next',
    hint: `did you mean '--direction'? (mimir update <id> --direction "…" writes the ## Next narrative)`,
    owner: [],
  },
  // Loom's self-update retired the old selectors: a channel replaces `--next`,
  // and the version is an argument, not `--tag`.
  {
    flag: 'next',
    hint: `'--next' is now a channel: mimir self-update --channel next`,
    only: 'self-update',
    owner: [],
  },
  {
    flag: 'tag',
    hint: 'self-update takes the release version as its argument: mimir self-update <version>',
    only: 'self-update',
    owner: [],
  },
  {
    flag: 'clear-links',
    hint: `'--clear-links' replaces linked work; use it with scratch update`,
    owner: ['scratch'],
  },
  {
    flag: 'expected-updated-at',
    hint: `'--expected-updated-at' guards mutations; use it with scratch`,
    owner: ['scratch'],
  },
  {
    flag: 'force',
    hint: `'--force' permits a non-empty discard; use it with scratch discard`,
    owner: ['scratch'],
  },
  {
    flag: 'reason',
    hint: `'--reason' records a Scratchpad supersession or forced discard`,
    owner: ['scratch'],
  },
  {
    flag: 'dry-run',
    hint: `'--dry-run' previews a triage pass; use it with triage (store import previews by default)`,
    owner: ['triage'],
  },
  {
    flag: 'apply',
    hint: `'--apply' writes a previewed import; use it with store import`,
    owner: ['store'],
  },
  {
    flag: 'resume',
    hint: `'--resume' re-runs a partial import, skipping what is already identical; use it with store import`,
    owner: ['store'],
  },
  {
    flag: 'limit',
    hint: 'projects takes only --status and --format',
    only: 'projects',
    owner: [],
    short: 'n',
  },
  {
    flag: 'tag',
    hint: 'projects takes only --status and --format',
    only: 'projects',
    owner: [],
    short: 't',
  },
];

/** The flag a failure's unknown-option spelling names: dashes and any `=value` dropped. */
const bareName = (spelling: string): string => spelling.replace(/^-+/, '').split('=')[0] ?? '';

/**
 * The redirect for `spelling` misplaced on `command`, or nothing when the flag
 * is not in the table or `command` owns it. A flag's `only` entry for
 * `command` wins over its general entry.
 */
export function flagRedirect(spelling: string, command: string | undefined): string | undefined {
  const name = bareName(spelling);
  const short = !spelling.startsWith('--') && spelling.startsWith('-');
  const entries = FLAG_OWNERS.filter((e) => (short ? e.short === name : e.flag === name));
  const only = entries.find((e) => e.only !== undefined && e.only === command);
  if (only !== undefined) {
    return only.hint;
  }
  const entry = entries.find((e) => e.only === undefined);
  if (entry === undefined) {
    return undefined;
  }
  return command === undefined || !entry.owner.includes(command) ? entry.hint : undefined;
}
