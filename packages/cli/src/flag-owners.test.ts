import { expect, test } from 'bun:test';

import { FLAG_OWNERS, flagRedirect } from './flag-owners';
import type { FlagOwner } from './flag-owners';

const DATE_VERBS = 'list, next, artifacts, seeds';

/**
 * The redirect each owner-table entry prints, spelled out: the flag as the
 * caller misplaced it, a command that does not own it, and the hint. One row
 * per entry and per short spelling, so a changed hint fails here.
 */
const REDIRECTS: readonly { spelling: string; command: string; hint: string }[] = [
  {
    command: 'get',
    hint: `'--tz' resolves a bare date in a query and renders its results; use it with ${DATE_VERBS}`,
    spelling: '--tz',
  },
  {
    command: 'get',
    hint: `'--at-or-before FIELD:VALUE' filters a query; use it with ${DATE_VERBS}`,
    spelling: '--at-or-before',
  },
  {
    command: 'get',
    hint: `'--at-or-after FIELD:VALUE' filters a query; use it with ${DATE_VERBS}`,
    spelling: '--at-or-after',
  },
  {
    command: 'get',
    hint: `'--on' names the owner at block (you|others), the prerequisites at depend/undepend, and a date filter at ${DATE_VERBS}`,
    spelling: '--on',
  },
  {
    command: 'list',
    hint: `'--since' is retired; every resource windows created_at with '--at-or-after created_at:YYYY-MM-DD'`,
    spelling: '--since',
  },
  {
    command: 'list',
    hint: `'--not-before' is retired; the inclusive lower bound is '--at-or-after FIELD:VALUE'`,
    spelling: '--not-before',
  },
  {
    command: 'list',
    hint: `'--not-after' is retired; the inclusive upper bound is '--at-or-before FIELD:VALUE'`,
    spelling: '--not-after',
  },
  {
    command: 'list',
    hint: `'--offset' pages the artifact feed; list/next cap with '-n, --limit'`,
    spelling: '--offset',
  },
  {
    command: 'get',
    hint: `'-q, --query' searches titles; use it with artifacts, list, or next`,
    spelling: '--query',
  },
  {
    command: 'get',
    hint: `'-q, --query' searches titles; use it with artifacts, list, or next`,
    spelling: '-q',
  },
  {
    command: 'list',
    hint: `'--parent' sets the owner at creation; list/next filter with '--eq parent:KEY'`,
    spelling: '--parent',
  },
  {
    command: 'list',
    hint: `'--title' is a positional at create (mimir create task <title> …); the flag names a node at update/attach/scratch, or overrides promote's spawned title; list/next filter with '--eq title:KEY' or search with '-q, --query'`,
    spelling: '--title',
  },
  {
    command: 'list',
    hint: `'--summary' sets the summary at create/update/attach/scratch; list/next filter with '--eq summary:KEY'`,
    spelling: '--summary',
  },
  {
    command: 'list',
    hint: `'--target' sets a phase's target at create/update; list/next filter with '--eq target:KEY'`,
    spelling: '--target',
  },
  {
    command: 'list',
    hint: `'--ref' sets external_ref at create/update; list/next filter with '--eq external_ref:KEY'`,
    spelling: '--ref',
  },
  {
    command: 'list',
    hint: `'--upstream' sets the requester-side seed pointer at create/update; list/next filter the task field with '--eq upstream:KEY'`,
    spelling: '--upstream',
  },
  {
    command: 'list',
    hint: `'--groomed' creates a task already groomed; list/next filter with '--eq grooming:groomed', and 'mimir groom <ids> <state>' sets it later`,
    spelling: '--groomed',
  },
  {
    command: 'list',
    hint: `'--pinned' pins a project: mimir update <KEY> --pinned (undo with --not-pinned)`,
    spelling: '--pinned',
  },
  {
    command: 'list',
    hint: `'--not-pinned' unpins a project: mimir update <KEY> --not-pinned`,
    spelling: '--not-pinned',
  },
  {
    command: 'list',
    hint: `'--remote' sets a project's Git remote at create project / update KEY`,
    spelling: '--remote',
  },
  {
    command: 'list',
    hint: `'--host' sets a resume handle at create/update/queue/start; list/next filter with '--eq host:KEY'`,
    spelling: '--host',
  },
  {
    command: 'list',
    hint: `'--harness' sets a resume handle at create/update/queue/start; list/next filter with '--eq harness:KEY'`,
    spelling: '--harness',
  },
  {
    command: 'list',
    hint: `'--session' sets a resume handle at create/update/queue/start; list/next filter with '--eq session:KEY'`,
    spelling: '--session',
  },
  {
    command: 'list',
    hint: `'--branch' sets a resume handle at create/update/queue/start; list/next filter with '--eq branch:KEY'`,
    spelling: '--branch',
  },
  {
    command: 'list',
    hint: `'--worker-harness' identifies the distinct task owner at start/update`,
    spelling: '--worker-harness',
  },
  {
    command: 'list',
    hint: `'--worker-session' identifies the distinct task owner at start/update`,
    spelling: '--worker-session',
  },
  {
    command: 'list',
    hint: `'--project' targets attach/seed/seeds; list/next scope a project with '-s, --scope KEY'`,
    spelling: '--project',
  },
  {
    command: 'list',
    hint: `'--requester' filters seeds a board requested; use it with seeds`,
    spelling: '--requester',
  },
  {
    command: 'list',
    hint: `the ## Next narrative is set after create: mimir update <id> --direction "…"`,
    spelling: '--direction',
  },
  {
    command: 'list',
    hint: `did you mean '--direction'? (mimir update <id> --direction "…" writes the ## Next narrative)`,
    spelling: '--next',
  },
  {
    command: 'self-update',
    hint: `'--next' is now a channel: mimir self-update --channel next`,
    spelling: '--next',
  },
  {
    command: 'self-update',
    hint: 'self-update takes the release version as its argument: mimir self-update <version>',
    spelling: '--tag',
  },
  {
    command: 'list',
    hint: `'--clear-links' replaces linked work; use it with scratch update`,
    spelling: '--clear-links',
  },
  {
    command: 'list',
    hint: `'--expected-updated-at' guards mutations; use it with scratch`,
    spelling: '--expected-updated-at',
  },
  {
    command: 'list',
    hint: `'--force' permits a non-empty discard; use it with scratch discard`,
    spelling: '--force',
  },
  {
    command: 'list',
    hint: `'--reason' records a Scratchpad supersession or forced discard`,
    spelling: '--reason',
  },
  {
    command: 'list',
    hint: `'--dry-run' previews a triage pass; use it with triage (store import previews by default)`,
    spelling: '--dry-run',
  },
  {
    command: 'list',
    hint: `'--apply' writes a previewed import; use it with store import`,
    spelling: '--apply',
  },
  {
    command: 'list',
    hint: `'--resume' re-runs a partial import, skipping what is already identical; use it with store import`,
    spelling: '--resume',
  },
  { command: 'projects', hint: 'projects takes only --status and --format', spelling: '--limit' },
  { command: 'projects', hint: 'projects takes only --status and --format', spelling: '-n' },
  { command: 'projects', hint: 'projects takes only --status and --format', spelling: '--tag' },
  { command: 'projects', hint: 'projects takes only --status and --format', spelling: '-t' },
];

test.each(REDIRECTS)('$spelling misplaced on $command prints its redirect', (row) => {
  expect(flagRedirect(row.spelling, row.command)).toBe(row.hint);
});

/** The spellings of an entry: its long flag, and its short one when it has one. */
const spellingsOf = (entry: FlagOwner): string[] => [
  `--${entry.flag}`,
  ...(entry.short === undefined ? [] : [`-${entry.short}`]),
];

test('every owner-table entry and short spelling has a redirect row', () => {
  const uncovered = FLAG_OWNERS.flatMap((entry) =>
    spellingsOf(entry).filter(
      (spelling) =>
        !REDIRECTS.some(
          (row) =>
            row.spelling === spelling &&
            row.hint === entry.hint &&
            (entry.only === undefined
              ? !entry.owner.includes(row.command)
              : row.command === entry.only),
        ),
    ),
  );
  expect(uncovered).toEqual([]);
});

test.each(FLAG_OWNERS.filter((entry) => entry.only === undefined && entry.owner.length > 0))(
  '--$flag on a command that owns it gets no redirect',
  (entry) => {
    for (const owner of entry.owner) {
      for (const spelling of spellingsOf(entry)) {
        expect(flagRedirect(spelling, owner), `${spelling} on ${owner}`).toBeUndefined();
      }
    }
  },
);

test('a value joined with = still finds the redirect', () => {
  expect(flagRedirect('--tz=UTC', 'get')).toBe(flagRedirect('--tz', 'get'));
});

test('with no command known, a general entry redirects and a one-command entry does not', () => {
  expect(flagRedirect('--offset', undefined)).toBe(
    `'--offset' pages the artifact feed; list/next cap with '-n, --limit'`,
  );
  expect(flagRedirect('--limit', undefined)).toBeUndefined();
});

test.each<[string, string]>([
  ['--tag', 'list'],
  ['-t', 'list'],
  ['--limit', 'list'],
  ['-n', 'list'],
])('%s on %s, which only another command redirects, gets no redirect', (spelling, command) => {
  expect(flagRedirect(spelling, command)).toBeUndefined();
});

test('a flag the table does not hold gets no redirect', () => {
  expect(flagRedirect('--bogus', 'list')).toBeUndefined();
});
