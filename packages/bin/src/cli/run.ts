import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import {
  CHEAP_FACETS,
  FACET_NAMES,
  isUniformVerb,
  QUERY_OP_VALUES,
  STATUS_SELECTOR_VALUES,
  VERDICT_VALUES,
} from '@mimir/contract';
import type {
  FacetName,
  FieldFilter,
  NodeView,
  SetResult,
  StatusSelector,
  VerdictSelector,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import {
  MimirError,
  emitWire,
  formatIds,
  formatOverviewJson,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
  ARTIFACT_DATE_FIELD,
  assertDateFilters,
  getArtifact,
  getNode,
  getSeed,
  listArtifacts,
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  overviewOf,
  parseFilterToken,
  parseIdentity,
  statusOfNode,
  treeToWire,
} from '../core';
import type { Store } from '../core';
import { cmdDoctor } from '../doctor/commands';
import type { DoctorDeps } from '../doctor/commands';
import { defaultVaultPath } from '../env';
import { arrow, FORMATS, ok, warn } from '../presentation';
import type { Format, Io } from '../presentation';
import { cmdSelfUpdate, cmdService } from '../service';
import type { ServiceDeps } from '../service';
import { cmdVault } from '../vault/commands';
import type { VaultDeps } from '../vault/commands';
import { BINDING_FILE, writeBinding } from './binding';
import { exitCodeFor, isRenderable, renderError, renderWarnings, usage } from './errors';
import type { UsageError } from './errors';
import { COMMAND_HELP, helpForCommand, renderFullHelp, renderTerseHelp } from './help';
import {
  cmdAnnotate,
  cmdAttach,
  cmdCreate,
  cmdDepend,
  cmdMove,
  cmdReorder,
  cmdTag,
  cmdUndepend,
  cmdUniform,
  cmdUntag,
  cmdUpdate,
  cmdPromote,
  cmdReject,
  cmdResolve,
  cmdSeed,
  cmdSeeds,
  cmdTriage,
} from './mutations';
import type { Ctx } from './mutations';
import { callerTimeZone, parseDateFilters, parsePriority, parseSize } from './parse';
import {
  countLine,
  renderArtifactDetail,
  renderArtifacts,
  renderNodeView,
  renderOverview,
  renderRecords,
  renderSeedView,
  renderStatus,
  renderTable,
  renderTree,
} from './render';
import { resolveProject } from './resolve';
import { cmdScratch, scratchSubcommand } from './scratch';
import { cmdSetup } from './setup';
import { SKILL_AGENTS, SKILL_FILES, skillDirFor } from './skill-assets';

// Deliberately grouped query-flags-then-write-flags (see the divider comment),
// not alphabetical — the operator cluster reads as a unit.
/* oxlint-disable sort-keys */
const OPTIONS = {
  scope: { short: 's', type: 'string' },
  priority: { short: 'p', type: 'string' },
  size: { type: 'string' },
  status: { type: 'string' },
  is: { multiple: true, type: 'string' },
  'not-is': { multiple: true, type: 'string' },
  eq: { multiple: true, type: 'string' },
  'not-eq': { multiple: true, type: 'string' },
  in: { multiple: true, type: 'string' },
  'not-in': { multiple: true, type: 'string' },
  has: { multiple: true, type: 'string' },
  missing: { multiple: true, type: 'string' },
  before: { multiple: true, type: 'string' },
  on: { multiple: true, type: 'string' },
  after: { multiple: true, type: 'string' },
  'at-or-before': { multiple: true, type: 'string' },
  'at-or-after': { multiple: true, type: 'string' },
  // The caller's IANA timezone — how a bare YYYY-MM-DD resolves (ADR 0029).
  // Defaults to the invoking system's zone, so the CLI is never zone-less.
  tz: { type: 'string' },
  tag: { multiple: true, short: 't', type: 'string' },
  // Retired date spellings, parsed only so they can be REFUSED with a redirect
  // (ADR 0029, see VERB_OWNED_FLAGS) rather than read as an unknown flag.
  'not-before': { multiple: true, type: 'string' },
  'not-after': { multiple: true, type: 'string' },
  since: { type: 'string' },
  // The artifact feed's paging — `--offset` is its alone.
  offset: { type: 'string' },
  query: { short: 'q', type: 'string' },
  limit: { short: 'n', type: 'string' },
  col: { multiple: true, type: 'string' },
  format: { short: 'f', type: 'string' },
  ascii: { type: 'boolean' },
  help: { short: 'h', type: 'boolean' },
  // Write-surface flags — `--on` / `--before` / `--after` are shared with the
  // query date-ops above (multiple); the write verbs read the last value.
  to: { type: 'string' },
  parent: { type: 'string' },
  key: { type: 'string' },
  name: { type: 'string' },
  desc: { type: 'string' },
  // The `next` field's write flag (MMR-321). Spelled `--direction` — ADR 0026's
  // own word for what the `## Next` section holds — because `--next` is already
  // taken, as a BOOLEAN, by `self-update`'s prerelease channel below, and one
  // options table cannot carry a flag under two types.
  direction: { type: 'string' },
  summary: { type: 'string' },
  target: { type: 'string' },
  ref: { type: 'string' },
  file: { type: 'string' },
  link: { multiple: true, type: 'string' },
  'clear-links': { type: 'boolean' },
  'expected-updated-at': { type: 'string' },
  force: { type: 'boolean' },
  reason: { type: 'string' },
  project: { type: 'string' },
  top: { type: 'boolean' },
  bottom: { type: 'boolean' },
  // Container open-ended converse pair (MMR-204) — like top/bottom.
  'open-ended': { type: 'boolean' },
  'not-open-ended': { type: 'boolean' },
  title: { type: 'string' },
  yes: { short: 'y', type: 'boolean' },
  // skill install
  global: { type: 'boolean' },
  local: { type: 'boolean' },
  agent: { type: 'string' },
  // service flag
  port: { type: 'string' },
  'no-hunt': { type: 'boolean' },
  // setup wizard (MMR-145)
  vault: { type: 'string' },
  'install-service': { type: 'boolean' },
  'install-snapshot': { type: 'boolean' },
  'snapshot-interval': { type: 'string' },
  upstream: { type: 'string' },
  // the resume handles (ADR 0026 Decision 3, MMR-320) — set at `start`,
  // overwritten by `update` on resume or takeover
  host: { type: 'string' },
  harness: { type: 'string' },
  session: { type: 'string' },
  branch: { type: 'string' },
  // seed verbs (MMR-245)
  kind: { short: 'k', type: 'string' },
  requester: { type: 'string' },
  sort: { type: 'string' },
  grouped: { type: 'boolean' },
  // triage preview (MMR-246)
  'dry-run': { type: 'boolean' },
  // doctor deterministic repair (MMR-183)
  fix: { type: 'boolean' },
  // self-update selectors (--tag reuses the multiple `tag` flag above,
  // last-wins like the other shared write-surface flags)
  next: { type: 'boolean' },
} as const;
/* oxlint-enable sort-keys */

/**
 * Every dispatch verb — the authority for "is this a real command?" (MMR-211).
 * An unknown verb is a hard usage error (exit 2) even with `-h`/`--help`; it
 * must never fall through to the top-level help, which an agent can misread as
 * task data and then act on stale context.
 *
 * Derived from the `COMMAND_HELP` descriptor registry (single source) rather
 * than re-listed: every documented verb, dropping the space-keyed
 * `create <type>` subcommand descriptors. `serve`/`mcp`/`version` are
 * intercepted upstream in `main` for a bare invocation; a `-h`/`--help` on
 * any of them falls through here instead, rendering that verb's
 * `COMMAND_HELP` descriptor without ever touching the vault (MMR-294). The
 * switch in `runCli` keeps a defensive `default:` for any drift.
 */
const COMMANDS: ReadonlySet<string> = new Set(
  Object.keys(COMMAND_HELP).filter((key) => !key.includes(' ')),
);

/**
 * Flags parsed globally (there is one options table) but owned by exactly ONE
 * verb — `parseArgs` cannot scope a flag to a verb, so without this guard an
 * owner-mismatched flag is accepted and silently ignored (MMR-321).
 *
 * Most shared flags are read by several verbs and a stray one is harmless. These
 * are not, because each silently DISCARDS an argument the caller meant to apply:
 *
 * - `--next` is `self-update`'s prerelease selector and a BOOLEAN, so it
 *   swallows no value and `update KEY --next "text"` exits 0 having written
 *   nothing, the text having slid into the positionals. Every machine surface
 *   (MCP arg, HTTP body field, `--col`) spells the direction field `next`, so
 *   that is precisely the invocation to expect.
 * - `--direction` writes that narrative, and only `update` reads it — the
 *   settled write surface (ADR 0026 Decision 2). `create … --direction "…"`
 *   would drop the prose on the floor, which is worse for being exactly where
 *   the `--next` hint above sends the caller.
 * - `--offset` is the artifact feed's own paging. In the shared table it
 *   would otherwise make `mimir list --offset 20` exit 0 with the UNPAGED
 *   board — a silently-wrong answer where the invocation used to be a hard
 *   unknown-flag error. `list`/`next` cap with `-n, --limit`, which is where
 *   the hint sends the caller.
 * - `--parent` sets the owning node at creation (`create initiative/phase/task`)
 *   or when `promote` spawns a task from a seed. In the shared table it would
 *   otherwise make `mimir list --parent MMR-2` exit 0 with the FULL unfiltered
 *   board (MMR-360) — the exact `--offset` failure shape above, one flag over.
 *   The uniform selector `--eq parent:KEY` is where the hint sends `list`/`next`
 *   callers.
 * - The MMR-360 sweep found the same shape wherever a write-owned flag's
 *   spelling doubles as a `QUERY_FIELDS` name (`query.ts`): `--title`
 *   (update/attach/promote/scratch), `--summary` (create/update/attach/
 *   scratch), `--target` (create/update, phases only), `--ref`
 *   (create/update, the `external_ref` field), `--upstream` (create/update,
 *   plus `setup`'s unrelated snapshot-remote reuse of the same spelling),
 *   and the four resume handles `--host`/`--harness`/`--session`/`--branch`
 *   (create/update/start).
 *   `mimir list --host my-branch` used to exit 0 with the FULL board for the
 *   identical reason `--parent` did; each redirects to its own `--eq
 *   FIELD:VALUE`.
 * - `--project` has no `QUERY_FIELDS` counterpart, but it is not a harmless
 *   no-op like `--name`/`--key` below: `attach` (associate an artifact),
 *   `seed` (file against another board), and `seeds` (scope the queue to one
 *   board, or `all`) all read it as a real filter/selector. A caller who has
 *   just scoped `mimir seeds --project MMR` reasonably expects `mimir list
 *   --project MMR` to scope the same way; instead it used to exit 0 with the
 *   FULL cross-project board — a silently BROADER answer read as a
 *   per-project one, the same hazard as `--parent` in the opposite direction.
 *   `list`/`next` already own a real project scope, `-s, --scope KEY`, so
 *   that is where the hint sends the caller instead of a nonexistent `--eq`.
 * - `--requester` is `seeds`' own filter (seeds a board requested elsewhere);
 *   it has no `QUERY_FIELDS` counterpart either (tasks carry no requester),
 *   but the same "looks like a working filter on a sibling verb" hazard
 *   applies, so it is guarded to `seeds` alone rather than left to silently
 *   no-op on `list`/`next`.
 *   Flags with no query-field counterpart AND no life as a filter on any
 *   verb — `--name`, `--key`, `--kind` (`seed`'s required classification,
 *   never used to filter the seed queue — `listSeeds` has no `kind` option),
 *   and `--desc` (`description` is deliberately unqueryable, MMR-162) — stay
 *   unguarded: a stray one is a genuine no-op, not a silently narrowed (or
 *   broadened) answer masquerading as a filter.
 *
 * - `--tz`, `--at-or-before`, and `--at-or-after` belong to the four query
 *   verbs (ADR 0029). `--tz` names the caller's zone for both halves of a
 *   query — the calendar day a bare date means, and the wall clock the styled
 *   formats render — but only a verb that runs a date-filtered query has the
 *   first half to offer. `mimir get MMR-1 --tz Asia/Tokyo` would otherwise
 *   exit 0 having read a record the flag half-applied to, and the zone is
 *   exactly the argument a caller expects to have changed the answer. Their
 *   three siblings — `--on`, `--before`, `--after` — stay shared: `depend`
 *   takes `--on`, `reorder` takes `--before`/`--after`, and one options table
 *   cannot scope a spelling two verbs both mean.
 *
 * The same guard carries the **tombstones** for spellings ADR 0029 removed —
 * `--not-before`, `--not-after`, and the artifact feed's `--since`. An empty
 * `owner` list means no verb owns them, so every use is refused with the new
 * spelling in the hint rather than parsed as an unknown flag (whose typo hint
 * cannot explain a renamed grammar).
 *
 * Each entry redirects to the flag or verb that does the work, so the hint
 * ladder terminates somewhere useful instead of looping.
 */
type OwnedFlagValues = {
  'clear-links'?: boolean;
  'expected-updated-at'?: string;
  force?: boolean;
  next?: boolean;
  direction?: string;
  since?: string;
  'not-before'?: string[];
  'not-after'?: string[];
  'at-or-before'?: string[];
  'at-or-after'?: string[];
  tz?: string;
  offset?: string;
  query?: string;
  reason?: string;
  parent?: string;
  title?: string;
  summary?: string;
  target?: string;
  ref?: string;
  upstream?: string;
  host?: string;
  harness?: string;
  session?: string;
  branch?: string;
  project?: string;
  requester?: string;
};

/** No verb owns a tombstoned flag — every use is a usage error with a redirect. */
const RETIRED: readonly string[] = [];

/** The verbs that run a date-filtered query — the owners of the date grammar. */
const DATE_QUERY_VERBS: readonly string[] = ['list', 'next', 'artifacts', 'seeds'];

const VERB_OWNED_FLAGS: readonly {
  flag: string;
  owner: string | readonly string[];
  given: (values: OwnedFlagValues) => boolean;
  hint: string;
}[] = [
  {
    flag: '--clear-links',
    given: (values) => values['clear-links'] === true,
    hint: `'--clear-links' replaces linked work; use it with scratch update`,
    owner: 'scratch',
  },
  {
    flag: '--expected-updated-at',
    given: (values) => values['expected-updated-at'] !== undefined,
    hint: `'--expected-updated-at' guards mutations; use it with scratch`,
    owner: 'scratch',
  },
  {
    flag: '--force',
    given: (values) => values.force === true,
    hint: `'--force' permits a non-empty discard; use it with scratch discard`,
    owner: 'scratch',
  },
  {
    flag: '--reason',
    given: (values) => values.reason !== undefined,
    hint: `'--reason' records a Scratchpad supersession or forced discard`,
    owner: 'scratch',
  },
  {
    flag: '--next',
    given: (values) => values.next === true,
    hint: `did you mean '--direction'? (mimir update <id> --direction "…" writes the ## Next narrative)`,
    owner: 'self-update',
  },
  {
    flag: '--direction',
    given: (values) => values.direction !== undefined,
    hint: `the ## Next narrative is set after create: mimir update <id> --direction "…"`,
    owner: 'update',
  },
  {
    flag: '--since',
    given: (values) => values.since !== undefined,
    hint: `'--since' is retired; every resource windows created_at with '--at-or-after created_at:YYYY-MM-DD'`,
    owner: RETIRED,
  },
  {
    flag: '--not-before',
    given: (values) => (values['not-before'] ?? []).length > 0,
    hint: `'--not-before' is retired; the inclusive lower bound is '--at-or-after FIELD:VALUE'`,
    owner: RETIRED,
  },
  {
    flag: '--not-after',
    given: (values) => (values['not-after'] ?? []).length > 0,
    hint: `'--not-after' is retired; the inclusive upper bound is '--at-or-before FIELD:VALUE'`,
    owner: RETIRED,
  },
  {
    flag: '--tz',
    given: (values) => values.tz !== undefined,
    hint: `'--tz' resolves a bare date in a query and renders its results; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: '--at-or-before',
    given: (values) => (values['at-or-before'] ?? []).length > 0,
    hint: `'--at-or-before FIELD:VALUE' filters a query; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: '--at-or-after',
    given: (values) => (values['at-or-after'] ?? []).length > 0,
    hint: `'--at-or-after FIELD:VALUE' filters a query; use it with ${DATE_QUERY_VERBS.join(', ')}`,
    owner: DATE_QUERY_VERBS,
  },
  {
    flag: '--offset',
    given: (values) => values.offset !== undefined,
    hint: `'--offset' pages the artifact feed; list/next cap with '-n, --limit'`,
    owner: 'artifacts',
  },
  {
    flag: '--query',
    given: (values) => values.query !== undefined,
    hint: `'-q, --query' searches titles; use it with artifacts, list, or next`,
    owner: ['artifacts', 'list', 'next'],
  },
  {
    flag: '--parent',
    given: (values) => values.parent !== undefined,
    hint: `'--parent' sets the owner at creation; list/next filter with '--eq parent:KEY'`,
    owner: ['create', 'promote'],
  },
  // The MMR-360 sweep (see the doc comment above) — every remaining
  // `QUERY_FIELDS` name that also spells a write-owned flag.
  {
    flag: '--title',
    given: (values) => values.title !== undefined,
    hint: `'--title' is a positional at create (mimir create task <title> …); the flag names a node at update/attach/scratch, or overrides promote's spawned title; list/next filter with '--eq title:KEY' or search with '-q, --query'`,
    owner: ['update', 'attach', 'promote', 'scratch'],
  },
  {
    flag: '--summary',
    given: (values) => values.summary !== undefined,
    hint: `'--summary' sets the summary at create/update/attach/scratch; list/next filter with '--eq summary:KEY'`,
    owner: ['create', 'update', 'attach', 'scratch'],
  },
  {
    flag: '--target',
    given: (values) => values.target !== undefined,
    hint: `'--target' sets a phase's target at create/update; list/next filter with '--eq target:KEY'`,
    owner: ['create', 'update'],
  },
  {
    flag: '--ref',
    given: (values) => values.ref !== undefined,
    hint: `'--ref' sets external_ref at create/update; list/next filter with '--eq external_ref:KEY'`,
    owner: ['create', 'update'],
  },
  {
    flag: '--upstream',
    given: (values) => values.upstream !== undefined,
    hint: `'--upstream' sets the requester-side seed pointer at create/update (or the snapshot git remote at setup); list/next filter the task field with '--eq upstream:KEY'`,
    owner: ['create', 'update', 'setup'],
  },
  {
    flag: '--host',
    given: (values) => values.host !== undefined,
    hint: `'--host' sets a resume handle at create/update/start; list/next filter with '--eq host:KEY'`,
    owner: ['create', 'update', 'start'],
  },
  {
    flag: '--harness',
    given: (values) => values.harness !== undefined,
    hint: `'--harness' sets a resume handle at create/update/start; list/next filter with '--eq harness:KEY'`,
    owner: ['create', 'update', 'start'],
  },
  {
    flag: '--session',
    given: (values) => values.session !== undefined,
    hint: `'--session' sets a resume handle at create/update/start; list/next filter with '--eq session:KEY'`,
    owner: ['create', 'update', 'start'],
  },
  {
    flag: '--branch',
    given: (values) => values.branch !== undefined,
    hint: `'--branch' sets a resume handle at create/update/start; list/next filter with '--eq branch:KEY'`,
    owner: ['create', 'update', 'start'],
  },
  // `--project` and `--requester` have no `QUERY_FIELDS` counterpart, but each
  // is a real filter/selector on a sibling verb — see the doc comment above.
  {
    flag: '--project',
    given: (values) => values.project !== undefined,
    hint: `'--project' targets attach/seed/seeds; list/next scope a project with '-s, --scope KEY'`,
    owner: ['attach', 'seed', 'seeds'],
  },
  {
    flag: '--requester',
    given: (values) => values.requester !== undefined,
    hint: `'--requester' filters seeds a board requested; use it with seeds`,
    owner: 'seeds',
  },
];

/** Every valid flag spelling — long `--name` plus any short `-x` alias. */
const FLAG_SPELLINGS: readonly string[] = Object.entries(OPTIONS).flatMap(([name, spec]) =>
  'short' in spec ? [`--${name}`, `-${spec.short}`] : [`--${name}`],
);

/**
 * Per-invocation environment defaults resolved by the composition root —
 * the Project Binding scope (ADR 0011) and the directory `bind` writes into.
 * Injected so the CLI stays testable without touching the real cwd.
 */
export type Defaults = {
  scope?: string;
  cwd?: string;
  /** Real service/self-update edges; absent where supervision is unavailable (tests). */
  service?: ServiceDeps;
  /** Real vault edges (git snapshot); absent where the vault is unavailable (tests). */
  vault?: VaultDeps;
  /** The `doctor` vault diagnostics read handle; absent where doctor is
   * unavailable (tests). */
  doctor?: DoctorDeps;
};

/**
 * The effective `-s` scope: an explicit flag wins; the literal `all` is the
 * cross-project escape (a key is uppercase, so `all` can never collide);
 * otherwise the Project Binding's key, if any.
 */
function effectiveScope(
  explicit: string | undefined,
  bound: string | undefined,
): string | undefined {
  if (explicit === 'all') {
    return undefined;
  }
  return explicit ?? bound;
}

/**
 * Run the CLI for one invocation. `argv` is the args after `mimir`; `getStore`
 * lazily supplies the Store over the converged Norn vault — it must be
 * idempotent (the caller owns the client's lifecycle) and is called only
 * by verbs that touch data, so help/usage/`skill` paths never open a store
 * (MMR-39); `io` is the injected sink + presentation context. Returns the
 * process exit code.
 */
export async function runCli(
  argv: string[],
  getStore: () => Store | Promise<Store>,
  io: Io,
  defaults: Defaults = {},
): Promise<number> {
  let values: {
    scope?: string;
    priority?: string;
    size?: string;
    status?: string;
    is?: string[];
    'not-is'?: string[];
    eq?: string[];
    'not-eq'?: string[];
    in?: string[];
    'not-in'?: string[];
    has?: string[];
    missing?: string[];
    before?: string[];
    on?: string[];
    after?: string[];
    'at-or-before'?: string[];
    'at-or-after'?: string[];
    tz?: string;
    tag?: string[];
    'not-before'?: string[];
    'not-after'?: string[];
    since?: string;
    offset?: string;
    query?: string;
    limit?: string;
    col?: string[];
    format?: string;
    ascii?: boolean;
    help?: boolean;
    // Write-surface flags
    to?: string;
    parent?: string;
    key?: string;
    name?: string;
    desc?: string;
    direction?: string;
    summary?: string;
    target?: string;
    ref?: string;
    file?: string;
    link?: string[];
    'clear-links'?: boolean;
    'expected-updated-at'?: string;
    force?: boolean;
    reason?: string;
    project?: string;
    top?: boolean;
    bottom?: boolean;
    title?: string;
    yes?: boolean;
    global?: boolean;
    local?: boolean;
    agent?: string;
    port?: string;
    'no-hunt'?: boolean;
    vault?: string;
    'install-service'?: boolean;
    'install-snapshot'?: boolean;
    'snapshot-interval'?: string;
    upstream?: string;
    kind?: string;
    requester?: string;
    sort?: string;
    grouped?: boolean;
    next?: boolean;
    'dry-run'?: boolean;
    fix?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({ allowPositionals: true, args: argv, options: OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    // A strict parse fails on a bad flag or bad value. Recover the verb
    // leniently (a flag error can't be the command) and route: an unknown verb
    // is the primary fault — surface its typo hint — otherwise it's a genuine
    // flag error on a known verb, so synthesize house voice for it and point
    // at THAT verb's help (MMR-211, MMR-289).
    const command = lenientCommand(argv);
    if (command !== undefined && !COMMANDS.has(command)) {
      return renderUnknownCommand(command, argv, io);
    }
    renderError(synthesizeParseError(error, command), errorFormat(argv), io);
    return 2;
  }

  // `zone` is reassigned below once `--tz` has been validated against its owning
  // verb — a caller who names a zone reads the answer in it too (ADR 0029).
  let ctx: Io = { ...io, plain: io.plain || values.ascii === true };

  const command = positionals[0];
  const full = argv.includes('--help');
  if (command === undefined) {
    ctx.write(full ? renderFullHelp(ctx.plain) : renderTerseHelp(ctx.plain));
    return 0;
  }
  // An unknown verb is a hard usage error (exit 2) — even with `-h`/`--help`,
  // which must never fall through to the top-level help. A silent help dump
  // (worse, at exit 0) reads as data to an agent that then proceeds on stale
  // context (MMR-211). Real verbs continue to the help/dispatch paths below.
  if (!COMMANDS.has(command)) {
    return renderUnknownCommand(command, argv, ctx);
  }
  // `<cmd> -h` / `<cmd> --help` prints THAT command's help (MMR-118), falling
  // back to the top-level help for a verb without a descriptor. Returns before
  // any dispatch, so help never opens the store.
  if (values.help === true) {
    ctx.write(
      helpForCommand(command, positionals[1], full, ctx.plain, positionals[2]) ??
        (full ? renderFullHelp(ctx.plain) : renderTerseHelp(ctx.plain)),
    );
    return 0;
  }

  try {
    // Verb-owned flags, checked before any dispatch (inside the try so they
    // render through the usual usage path). See {@link VERB_OWNED_FLAGS}.
    for (const owned of VERB_OWNED_FLAGS) {
      const owners = Array.isArray(owned.owner) ? owned.owner : [owned.owner];
      if (!owners.includes(command) && owned.given(values)) {
        // No owner at all means the flag is a tombstone (ADR 0029): say it is
        // gone rather than that this verb is the wrong home for it.
        throw usage(
          owners.length === 0
            ? `'${owned.flag}' is retired`
            : `'${owned.flag}' doesn't apply to ${command}`,
          owned.hint,
        );
      }
    }
    // The write echo's format, picked inside the try block so a bad --format
    // value is caught and rendered.
    const singleFormat = pickFormat(values.format, 'single', ctx);
    // An explicit `--tz` is the caller's zone for the WHOLE invocation: it
    // resolves their bare dates and renders the styled formats they read back
    // (ADR 0029). Filtering a Tokyo calendar day and printing EDT is a correct
    // answer that reads like a bug. Without the flag, rendering stays the
    // invoking machine's zone. The owned-flag guard above has already refused
    // `--tz` on any verb outside the date grammar, so this only fires on a
    // query verb; an unknown zone throws the same usage error it always did.
    if (values.tz !== undefined) {
      ctx = { ...ctx, zone: callerTimeZone(values.tz) };
    }
    // Mutation context shared across all write-verb handlers — built lazily so
    // the store is acquired only by verbs that actually touch data (MMR-39):
    // help, usage errors, and `skill install` never open or create it.
    const mkCtx = async (): Promise<Ctx> => {
      const store = await getStore();
      return {
        boundScope: effectiveScope(values.scope, defaults.scope),
        format: singleFormat,
        io: ctx,
        positionals,
        store,
        values,
      };
    };

    // The twelve uniform verbs (six lifecycle, four hold, archive/unarchive)
    // dispatch through one generic arm driven by the operation registry (ADR
    // 0025 Decision 3) — no per-verb case. The remaining verbs stay bespoke.
    if (isUniformVerb(command)) {
      return await cmdUniform(await mkCtx(), command);
    }

    switch (command) {
      case 'next': {
        const nextScope = effectiveScope(values.scope, defaults.scope);
        const nextEmptyMsg =
          nextScope !== undefined
            ? `No ready tasks in ${nextScope} — mimir list --status awaiting -s ${nextScope} shows what's queued`
            : "No ready tasks — mimir list --status awaiting shows what's queued";
        // Parsed BEFORE the store is opened (MMR-39): every one of these throws
        // `usage` on a structural fault, and a wrong invocation must not open the
        // vault. Inside the call's argument list they were evaluated after
        // `getStore()` had already resolved.
        const nextQuery = {
          facets: parseFacets(values.col),
          filters: parseFilters(values, callerTimeZone(values.tz)),
          limit: parseLimit(values.limit),
          priority: parsePriority(values.priority),
          q: values.query,
          scope: nextScope,
          size: parseSize(values.size),
          timeZone: callerTimeZone(values.tz),
          verdicts: parseVerdicts(values.is, values['not-is']),
        };
        return runSet(
          await nextTasks(await getStore(), nextQuery),
          values.format,
          ctx,
          nextEmptyMsg,
        );
      }
      case 'list': {
        // Same pre-store parse as `next` above (MMR-39) — hoisted out of the
        // call's argument list, where it ran only after the store had opened.
        const listQuery = {
          facets: parseFacets(values.col),
          filters: parseFilters(values, callerTimeZone(values.tz)),
          limit: parseLimit(values.limit),
          priority: parsePriority(values.priority),
          q: values.query,
          scope: effectiveScope(values.scope, defaults.scope),
          size: parseSize(values.size),
          status: parseStatus(values.status),
          tag: values.tag?.[0],
          timeZone: callerTimeZone(values.tz),
          verdicts: parseVerdicts(values.is, values['not-is']),
        };
        // The archived-projects shelf (ADR 0015) — the sole door to hidden
        // projects; lists projects, not nodes, so it bypasses listNodes.
        if (values.status === 'archived') {
          const projects = await listProjects(
            await getStore(),
            ['distribution', 'tags'],
            'archived',
          );
          // No issueCount here by design (MMR-184): this is a project-shelf
          // resource, not a node working set — threading the doctor tally
          // through would widen listProjects' cross-transport shape for a
          // nudge, which is disproportionate.
          return runSet(
            { items: projects, returned: projects.length, startsAt: 0, total: projects.length },
            values.format,
            ctx,
            'No archived projects',
          );
        }
        return runSet(
          await listNodes(await getStore(), listQuery),
          values.format,
          ctx,
          'No tasks match — try --status all, or drop a filter',
        );
      }
      case 'get': {
        const id = requireId(positionals[1], 'get');
        if (parseIdentity(id)?.kind === 'artifact') {
          const content = (values.col ?? []).includes('content');
          renderArtifactDetail(
            await getArtifact(await getStore(), id, { content }),
            pickFormat(values.format, 'single', ctx),
            ctx,
          );
          return 0;
        }
        if (parseIdentity(id)?.kind === 'seed') {
          // `get KEY-sN` routes to the single-seed reader + renderer, matching MCP
          // (`get_seed`) and HTTP (`GET /api/seeds/:id`) — the ADR 0020 amendment
          // promises `get KEY-sN` works on every surface (MMR-245/B3). Content is
          // opted in for the `## Seed Description` prose, as those transports do.
          renderSeedView(
            await getSeed(await getStore(), id, { content: true }),
            pickFormat(values.format, 'single', ctx),
            ctx,
          );
          return 0;
        }
        const facets = parseFacets(values.col);
        const node = await getNode(await getStore(), id, {
          facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
        });
        return renderSingle(node, values.format, ctx);
      }
      case 'status': {
        const id = requireId(positionals[1], 'status');
        const status = await statusOfNode(await getStore(), id);
        const format = pickFormat(values.format, 'status', ctx);
        ctx.write(format === 'json' ? formatStatusJson(status) : renderStatus(status, ctx));
        return 0;
      }
      case 'tree': {
        const id = requireId(positionals[1], 'tree');
        const tree = await nodeTree(await getStore(), id);
        const format = pickFormat(values.format, 'single', ctx);
        switch (format) {
          case 'json': {
            ctx.write(emitWire(treeToWire(tree), true));
            break;
          }
          case 'jsonl': {
            ctx.write(emitWire(treeToWire(tree), false));
            break;
          }
          case 'ids': {
            ctx.write(tree.id);
            break;
          }
          case 'records':
          case 'table': {
            ctx.write(renderTree(tree, ctx));
            break;
          }
        }
        return 0;
      }
      case 'overview': {
        // `overview` reads ONE project (ADR 0024): `-s all` is a category error —
        // a composite is not a cross-project set.
        if (values.scope === 'all') {
          throw usage(
            'overview reads one project, not a cross-project set',
            "run 'mimir list -s all' for a cross-project set",
          );
        }
        const scope = effectiveScope(values.scope, defaults.scope);
        if (scope === undefined) {
          throw usage('overview needs a project', 'bind a project or pass -s KEY');
        }
        const format = pickOverviewFormat(values.format, ctx);
        const report = await overviewOf(await getStore(), scope);
        ctx.write(format === 'json' ? formatOverviewJson(report) : renderOverview(report, ctx));
        return 0;
      }
      case 'artifacts': {
        // Unlike `overview`, the artifact feed IS a cross-project set: an unbound
        // invocation and the literal `-s all` both mean the portfolio (ADR 0004 —
        // an artifact is project-anchored but the search never was).
        const scope = effectiveScope(values.scope, defaults.scope);
        const artifactZone = callerTimeZone(values.tz);
        // Every structural fault (bad date, bad offset, bad format) is decided
        // BEFORE the store is acquired — a wrong invocation must never open the
        // vault, matching the help/usage paths (MMR-39).
        const artifactQuery = {
          dates: parseDateFilters(values, ARTIFACT_DATE_FIELD, artifactZone),
          limit: parseLimit(values.limit),
          offset: parseOffset(values.offset),
          q: values.query,
          scope,
          tag: values.tag?.[0],
          timeZone: artifactZone,
        };
        const format = pickFormat(values.format, 'set', ctx);
        const result = await listArtifacts(await getStore(), artifactQuery);
        issueNudge(result.issueCount, format, ctx);
        // A well-formed query that returns NO ROWS is an empty set at exit 0, with
        // the reason on stderr so stdout stays a clean machine contract (ADR 0009).
        // Keyed off the returned rows, not the total: an `--offset` past the end
        // matches plenty and returns nothing, which is the case most in need of a
        // note (and the one a `total === 0` test would silently pass over).
        if (result.returned === 0) {
          const where = scope === undefined ? '' : ` in ${scope}`;
          emptySetWarning(
            result.total > 0
              ? `no artifacts${where} past offset ${String(result.startsAt)} — ${countLine(result.total, 'artifact')} matched`
              : `no artifacts${where} — widen the window, or drop a filter`,
            format,
            ctx,
          );
        }
        renderArtifacts(result, format, ctx, { showProject: scope === undefined });
        return 0;
      }
      case 'scratch': {
        scratchSubcommand(positionals);
        return await cmdScratch({
          boundScope: defaults.scope,
          format: pickFormat(values.format, positionals[1] === 'list' ? 'set' : 'single', ctx),
          io: ctx,
          positionals,
          store: await getStore(),
          values,
        });
      }
      case 'depend': {
        return await cmdDepend(await mkCtx());
      }
      case 'undepend': {
        return await cmdUndepend(await mkCtx());
      }
      case 'move': {
        return await cmdMove(await mkCtx());
      }
      case 'reorder': {
        return await cmdReorder(await mkCtx());
      }
      case 'update': {
        return await cmdUpdate(await mkCtx());
      }
      case 'annotate': {
        return await cmdAnnotate(await mkCtx());
      }
      case 'attach': {
        return await cmdAttach(await mkCtx());
      }
      case 'create': {
        return await cmdCreate(await mkCtx());
      }
      case 'seed': {
        return await cmdSeed(await mkCtx());
      }
      case 'seeds': {
        return await cmdSeeds(await mkCtx());
      }
      case 'promote': {
        return await cmdPromote(await mkCtx());
      }
      case 'reject': {
        return await cmdReject(await mkCtx());
      }
      case 'resolve': {
        return await cmdResolve(await mkCtx());
      }
      case 'triage': {
        // `report` format (MMR-59 split): human prose in a terminal, json when piped.
        const c = await mkCtx();
        return await cmdTriage({ ...c, format: pickFormat(values.format, 'report', ctx) });
      }
      case 'tag': {
        return await cmdTag(await mkCtx());
      }
      case 'untag': {
        return await cmdUntag(await mkCtx());
      }
      case 'skill': {
        const sub = positionals[1];
        if (sub !== 'install') {
          throw usage('skill: unknown subcommand (expected: skill install)');
        }
        if (values.global === true && values.local === true) {
          throw usage('skill install takes --global or --local, not both');
        }
        const agent = values.agent ?? 'claude';
        if (!isMember(agent, SKILL_AGENTS)) {
          throw usage(`unknown agent: ${agent} (expected ${SKILL_AGENTS.join('|')})`);
        }
        const base = values.local === true ? (defaults.cwd ?? process.cwd()) : homedir();
        const dir = skillDirFor(agent, base);
        for (const f of SKILL_FILES) {
          const target = `${dir}/${f.path}`;
          mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
          writeFileSync(target, f.content);
        }
        if (singleFormat === 'json' || singleFormat === 'jsonl') {
          ctx.write(JSON.stringify({ installed: { agent, files: SKILL_FILES.length, path: dir } }));
        } else if (singleFormat === 'ids') {
          ctx.write(dir);
        } else {
          ok(
            ctx,
            `installed the mimir skill ${arrow(ctx.plain)} ${dir} (${SKILL_FILES.length} files)`,
          );
        }
        return 0;
      }
      case 'bind': {
        const key = positionals[1];
        if (key === undefined) {
          throw usage('bind requires a project KEY');
        }
        await resolveProject(await getStore(), key); // validates the project exists (not_found otherwise)
        writeBinding(defaults.cwd ?? process.cwd(), key);
        if (singleFormat === 'json' || singleFormat === 'jsonl') {
          ctx.write(JSON.stringify({ bound: { file: BINDING_FILE, project: key } }));
        } else if (singleFormat === 'ids') {
          ctx.write(key);
        } else {
          const glyph = ctx.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
          ctx.write(`${glyph} bound to ${key} (${BINDING_FILE})`);
        }
        return 0;
      }
      case 'setup': {
        if (defaults.service === undefined || defaults.vault === undefined) {
          throw usage('setup is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdSetup(
          {
            installService: values['install-service'],
            installSnapshot: values['install-snapshot'],
            port: values.port,
            snapshotInterval: values['snapshot-interval'],
            upstream: values.upstream,
            vault: values.vault,
            yes: values.yes,
          },
          ctx,
          {
            defaultVaultPath: defaultVaultPath(),
            service: defaults.service,
            vault: defaults.vault,
          },
          format,
        );
      }
      case 'service': {
        if (defaults.service === undefined) {
          throw usage('service is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdService(positionals, { port: values.port }, ctx, defaults.service, format);
      }
      case 'vault': {
        if (defaults.vault === undefined) {
          throw usage('vault is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdVault(positionals, ctx, defaults.vault, format);
      }
      case 'doctor': {
        if (defaults.doctor === undefined) {
          throw usage('doctor is unavailable in this context');
        }
        if (values['dry-run'] === true && values.fix !== true) {
          throw usage('doctor --dry-run requires --fix');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdDoctor(
          ctx,
          defaults.doctor,
          format,
          effectiveScope(values.scope, defaults.scope),
          { dryRun: values['dry-run'] === true, fix: values.fix === true },
        );
      }
      case 'self-update': {
        if (defaults.service === undefined) {
          throw usage('self-update is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdSelfUpdate(
          ctx,
          defaults.service,
          { next: values.next === true, tag: values.tag?.at(-1) },
          format,
        );
      }
      default: {
        throw usage(`unknown command: ${command}`);
      }
    }
  } catch (error) {
    if (isRenderable(error)) {
      renderError(error, errorFormat(argv), ctx);
      return exitCodeFor(error);
    }
    throw error;
  }
}

/**
 * Determine the error rendering format from the raw argv. Returns "json" or
 * "jsonl" iff the user explicitly requested it, else "records" (human default).
 * Scanning raw argv avoids depending on the already-parsed values, which may
 * not be available when a parseArgs failure occurs.
 *
 * Handles both separate-token form (`--format json`) and equals form
 * (`--format=json`, `-f=json`).
 */
function errorFormat(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    // Equals form: --format=json or -f=json
    const eqMatch = /^(?:--format|-f)=(.+)$/.exec(arg);
    if (eqMatch) {
      const val = eqMatch[1];
      if (val === 'json' || val === 'jsonl') {
        return val;
      }
      continue;
    }
    // Separate-token form: --format json or -f json
    if ((arg === '-f' || arg === '--format') && i < argv.length - 1) {
      const val = argv[i + 1] ?? '';
      if (val === 'json' || val === 'jsonl') {
        return val;
      }
    }
  }
  return 'records';
}

/** Levenshtein edit distance — small inputs (verb/flag names), one-row DP. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * The closest candidate to `input`, but only when it's a genuinely near miss:
 * within 2 edits, strictly shorter distance than the input's own length, and
 * UNAMBIGUOUS — a tie at the minimum (e.g. an unknown short flag `-x`, one edit
 * from every `-<char>`) yields no suggestion rather than an arbitrary one.
 */
function nearest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of candidates) {
    const d = editDistance(input, candidate);
    if (d < bestD) {
      bestD = d;
      best = candidate;
      tied = false;
    } else if (d === bestD) {
      tied = true;
    }
  }
  return best !== undefined && !tied && bestD <= 2 && bestD < input.length ? best : undefined;
}

/**
 * Recover the command (first positional) without throwing on unknown flags — a
 * lenient parse for the error paths, where the strict parse has already failed
 * and we still need to know which verb was invoked (MMR-211). Lenient parsing
 * still honors known value-taking flags, so a flag's value is never mistaken for
 * the verb (`mimir -s alpha get --bad` → `get`, not `alpha`).
 */
function lenientCommand(argv: string[]): string | undefined {
  try {
    return parseArgs({ allowPositionals: true, args: argv, options: OPTIONS, strict: false })
      .positionals[0];
  } catch {
    return argv.find((arg) => !arg.startsWith('-'));
  }
}

/** Render the unknown-command usage error (exit 2) with a did-you-mean hint. */
function renderUnknownCommand(command: string, argv: string[], io: Io): number {
  const near = nearest(command, COMMANDS);
  const hint =
    near !== undefined
      ? `did you mean '${near}'? (or run 'mimir --help' to see the commands)`
      : "run 'mimir --help' to see the commands";
  renderError(usage(`unknown command: ${command}`, hint), errorFormat(argv), io);
  return 2;
}

/**
 * The long spelling for a short flag (`-s` -> `--scope`), or `flag` unchanged
 * when it's already long or matches no short alias in OPTIONS. Node's own
 * "argument is ambiguous" message reports whichever spelling the caller
 * typed; canonicalizing keeps the synthesized message's flag naming
 * consistent regardless of which one that was.
 */
function canonicalFlag(flag: string): string {
  if (flag.startsWith('--')) {
    return flag;
  }
  const short = flag.slice(1);
  const match = Object.entries(OPTIONS).find(([, spec]) => 'short' in spec && spec.short === short);
  return match !== undefined ? `--${match[0]}` : flag;
}

/**
 * Re-synthesize a `node:util` parseArgs failure in house voice (voice guide:
 * "library text never ships") — Node's own message is a runtime-library
 * implementation detail and must appear in no output, including a structured
 * envelope's `message` field.
 *
 * Empirically enumerated for OPTIONS with `strict: true`/`allowPositionals:
 * true` (the only configuration this parse call uses — `allowPositionals` is
 * always `true` here, so `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`, thrown only
 * when positionals are disallowed, can never fire): an unknown flag
 * (`ERR_PARSE_ARGS_UNKNOWN_OPTION`), and — both under
 * `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` — a missing value (including the
 * "argument is ambiguous" shape Node emits when the next token looks like a
 * flag, e.g. `--to --ascii`) and a value given to a boolean flag (e.g.
 * `--ascii=x`).
 *
 * Applies the hint ladder's most specific applicable rung: a near-match
 * did-you-mean (rung 2) for an unknown flag when an unambiguous candidate
 * exists in FLAG_SPELLINGS, else the verb's own help pointer (rung 3) — there
 * is no statable fix (rung 1) for a parse failure, since the intended value is
 * unknowable.
 */
function synthesizeParseError(error: unknown, command: string | undefined): UsageError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const help =
    command !== undefined && COMMANDS.has(command)
      ? `run 'mimir ${command} -h' for its flags`
      : "run 'mimir --help' for usage";

  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const flag = /^Unknown option '(.+?)'\./.exec(message)?.[1];
    if (flag !== undefined) {
      // Short aliases stay in the candidate pool (a short typo is nearest to a
      // short spelling) but the suggestion always names the canonical long flag.
      const near = nearest(flag, FLAG_SPELLINGS);
      return usage(
        `unknown flag '${flag}'`,
        near !== undefined ? `did you mean '${canonicalFlag(near)}'?` : help,
      );
    }
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const noValueFlag = /^Option '(?:-\w, )?(-{1,2}[\w-]+)' does not take an argument/.exec(
      message,
    )?.[1];
    if (noValueFlag !== undefined) {
      return usage(`'${canonicalFlag(noValueFlag)}' doesn't take a value`, help);
    }
    const missingFlag =
      /^Option '(?:-\w, )?(--[\w-]+)(?: <value>)?' argument missing/.exec(message)?.[1] ??
      /^Option '(-{1,2}[\w-]+)' argument is ambiguous/.exec(message)?.[1];
    if (missingFlag !== undefined) {
      return usage(`'${canonicalFlag(missingFlag)}' expects a value`, help);
    }
  }
  // No further shape has been observed for this OPTIONS table; a defensive
  // fallback still keeps library text off every output.
  return usage('invalid arguments', help);
}

function runSet(
  result: SetResult<NodeView>,
  explicit: string | undefined,
  io: Io,
  emptyMsg?: string,
): number {
  const format = pickFormat(explicit, 'set', io);
  if (result.warnings !== undefined && result.warnings.length > 0) {
    renderWarnings(result.warnings, format, io);
  }
  issueNudge(result.issueCount, format, io);
  switch (format) {
    case 'ids': {
      io.write(formatIds(result.items));
      break;
    }
    case 'json': {
      io.write(formatSetJson(result));
      break;
    }
    case 'jsonl': {
      io.write(formatSetJsonl(result.items));
      break;
    }
    case 'records': {
      if (result.items.length === 0 && io.isTTY && emptyMsg !== undefined) {
        io.write(emptyMsg);
      } else {
        io.write(result.items.map((n) => renderRecords(n, io)).join('\n\n'));
      }
      break;
    }
    case 'table': {
      io.write(renderTable(result, io, emptyMsg));
      break;
    }
  }
  return 0;
}

/**
 * The doctor issue-count nudge (MMR-184): a stderr-only boot-orientation note,
 * off the tolerant reader's own drop tally for this load — never a fresh
 * `mimir doctor` pass. Unconditional of format (stdout stays a clean machine
 * contract either way) and silent at zero, matching the rare-condition cost bar.
 */
function issueNudge(issueCount: number | undefined, format: Format, io: Io): void {
  if (issueCount === undefined || issueCount === 0) {
    return;
  }
  emitStderrNote(`${countLine(issueCount, 'issue')} — run mimir doctor`, format, io, {
    issueCount,
  });
}

/** The querying-doctrine note for a well-formed query that matched nothing
 * (ADR 0009): exit 0, an empty set on stdout, the "why nothing" on stderr. */
function emptySetWarning(message: string, format: Format, io: Io): void {
  emitStderrNote(message, format, io);
}

/** One stderr note, in the destination's own grammar. Machine formats
 * (json/jsonl) follow renderWarnings' convention — a JSON object line rather
 * than the prose glyph line — so a piped stderr stays parseable. */
function emitStderrNote(
  message: string,
  format: Format,
  io: Io,
  extra: Record<string, unknown> = {},
): void {
  if (format === 'json' || format === 'jsonl') {
    io.error(JSON.stringify({ ...extra, warning: message }));
  } else {
    warn(io, message);
  }
}

function renderSingle(node: NodeView, explicit: string | undefined, io: Io): number {
  renderNodeView(node, pickFormat(explicit, 'single', io), io);
  return 0;
}

function pickFormat(
  explicit: string | undefined,
  kind: 'set' | 'single' | 'status' | 'report',
  io: Io,
): Format {
  if (explicit !== undefined) {
    if (!isMember(explicit, FORMATS)) {
      throw usage(`unknown format: ${explicit} (expected ${FORMATS.join('|')})`);
    }
    return explicit;
  }
  // `status` is structured data — json on every destination.
  if (kind === 'status') {
    return 'json';
  }
  // `report` (service status / self-update) keeps its MMR-59 split: json when
  // piped, human prose in a terminal.
  if (kind === 'report') {
    return io.isTTY ? 'records' : 'json';
  }
  // `set`/`single` (MMR-87): `isTTY` governs *decoration* only, never
  // *information*. The piped default carries the same fields as the interactive
  // one — color is already stripped via `io.plain` (`NO_COLOR || !isTTY`).
  // `ids`/`json`/`jsonl` stay explicit `-f` opt-ins: the non-TTY consumer is an
  // agent reading to decide (for whom bare ids are useless), not a `| xargs`
  // pipeline.
  return kind === 'set' ? 'table' : 'records';
}

/**
 * The `overview` format resolver (MMR-278): the `report` split — `records` on a
 * TTY, `json` when piped — but ONLY those two. The set formats are category
 * errors (a composite is not one table / a row stream / an id set), each rejected
 * as usage with a pointer at `mimir list`.
 */
function pickOverviewFormat(explicit: string | undefined, io: Io): 'records' | 'json' {
  if (explicit === undefined) {
    return io.isTTY ? 'records' : 'json';
  }
  if (explicit === 'records' || explicit === 'json') {
    return explicit;
  }
  if (explicit === 'table') {
    throw usage('overview is a composite, not a single table', "run 'mimir list' for a table");
  }
  if (explicit === 'jsonl') {
    throw usage(
      'overview is a composite, not a row stream',
      "run 'mimir list -f jsonl' for a row stream",
    );
  }
  if (explicit === 'ids') {
    throw usage('overview is a composite, not an id set', "run 'mimir list -f ids' for an id set");
  }
  throw usage(`unknown format: ${explicit} (expected records|json)`);
}

function requireId(id: string | undefined, command: string): string {
  if (id === undefined) {
    throw usage(`${command} requires an id (KEY | KEY-seq | KEY-aN)`);
  }
  return id;
}

/**
 * The always-shown `NodeView` bare columns (dto.ts). `--col` only *adds* optional
 * facet columns, so a user naming one of these is treating it as a projection —
 * the 21-occurrence `--col id,type,status` miss (MMR-212). Best-effort: a name
 * missing here just falls through to the generic unknown-column error.
 */
const BASE_COLUMN_NAMES = [
  'id',
  'type',
  'title',
  'status',
  'parent',
  'summary',
  'priority',
  'size',
  'lifecycle',
  'hold',
  'target',
  'created',
  'updated',
  'completed',
] as const;

/**
 * The flat `--col` vocabulary (MMR-38) — the dot prefix is gone (it fenced a
 * dynamic namespace Mimir doesn't have). One closed list; `content` is
 * artifact-only and handled by the `get KEY-aN` path.
 */
function parseFacets(cols: string[] | undefined): FacetName[] {
  const facets: FacetName[] = [];
  // Accept a comma-separated list (`--col history,annotations`) as well as the
  // repeated `--col` form (MMR-212); tolerate surrounding spaces and empties.
  for (const raw of (cols ?? []).flatMap((c) => c.split(','))) {
    const col = raw.trim();
    if (col === '') {
      continue;
    }
    if (col.startsWith('.')) {
      throw usage(`columns are flat now: --col ${col.slice(1)} (the dot prefix was dropped)`);
    }
    if (col === 'content') {
      continue;
    } // artifact-only; a node simply has no body
    if (!isMember(col, FACET_NAMES)) {
      if (isMember(col, BASE_COLUMN_NAMES)) {
        throw usage(
          `--col adds optional columns; '${col}' is always shown`,
          `optional columns: ${[...FACET_NAMES, 'content'].join(', ')}`,
        );
      }
      throw usage(`unknown column: ${col}`, `columns: ${[...FACET_NAMES, 'content'].join(', ')}`);
    }
    facets.push(col);
  }
  return facets;
}

function parseStatus(value: string | undefined): StatusSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, STATUS_SELECTOR_VALUES)) {
    throw usage(`invalid status: ${value} (expected ${STATUS_SELECTOR_VALUES.join('|')})`);
  }
  return value;
}

function parseVerdicts(is: string[] | undefined, notIs: string[] | undefined): VerdictSelector[] {
  const out: VerdictSelector[] = [];
  const take = (tokens: string[] | undefined, negate: boolean): void => {
    for (const token of tokens ?? []) {
      if (!isMember(token, VERDICT_VALUES)) {
        throw usage(`invalid verdict: ${token} (expected ${VERDICT_VALUES.join('|')})`);
      }
      out.push({ negate, verdict: token });
    }
  };
  take(is, false);
  take(notIs, true);
  return out;
}

/**
 * Collect FIELD:VALUE filter tokens from the op flags — one flag per
 * {@link QUERY_OP_VALUES} entry, the flag spelled identically to the op
 * (MMR-306: the CLI needs no separate flag-name mapping, unlike MCP's
 * `OP_ARG_KEYS`). Structural faults (unknown field, operator-type mismatch)
 * surface as usage — the caller's invocation is wrong (exit 2); the same
 * fault over MCP stays `validation`.
 */
function parseFilters(values: Record<string, unknown>, zone: string): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const op of QUERY_OP_VALUES) {
    const tokens = values[op];
    if (!Array.isArray(tokens)) {
      continue;
    }
    for (const token of tokens) {
      if (typeof token !== 'string') {
        continue;
      }
      try {
        filters.push(parseFilterToken(op, token));
      } catch (error) {
        if (error instanceof MimirError) {
          throw usage(error.message, error.hint);
        }
        throw error;
      }
    }
  }
  // Refuse an unreadable date here rather than inside the query, so a wrong
  // invocation never opens the vault (MMR-39).
  try {
    assertDateFilters(filters, zone);
  } catch (error) {
    if (error instanceof MimirError) {
      throw usage(error.message, error.hint);
    }
    throw error;
  }
  return filters;
}

/**
 * A whole-token non-negative integer flag value. `Number.parseInt` is the wrong
 * tool here and was the wrong tool before (MMR-322 tightening): it stops at the
 * first non-digit, so `-n 2x` silently capped at 2 and `-n 2.5` silently capped
 * at 2 — a wrong answer reported as a right one. The token must parse WHOLE, and
 * must land inside the safe-integer range so a huge value can't alias.
 */
function parseCount(value: string | undefined, flag: string, hint: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (
    value.trim() === '' ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    // `Number` accepts hex/binary/exponent/whitespace forms `parseInt` wouldn't;
    // the flag grammar is plain decimal digits, so require exactly that.
    !/^\d+$/.test(value)
  ) {
    throw usage(`invalid ${flag}: ${value}`, hint);
  }
  return n;
}

function parseLimit(value: string | undefined): number | undefined {
  return parseCount(value, 'limit', 'limit is a whole number of rows (0 or more)');
}

/** The artifact feed's paging cursor (MMR-322) — rows to skip before the window. */
function parseOffset(value: string | undefined): number | undefined {
  return parseCount(value, 'offset', 'offset is a whole count of rows to skip (0 or more)');
}
